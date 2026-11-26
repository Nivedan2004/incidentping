import {
  Controller,
  Post,
  Req,
  Logger,
  HttpCode,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import Linq from '@linqapp/sdk';
import { SentryService } from './sentry.service.js';
import { DynamoDBService } from '../dynamodb/dynamodb.service.js';

// Expected Sentry webhook payload
interface SentryWebhookPayload {
  action: string;
  data?: {
    issue?: {
      id: string;
    };
  };
}

@Controller('sentry')
export class SentryController {
  private readonly logger = new Logger(SentryController.name);
  private readonly linq: Linq;
  private readonly webhookToken: string;
  private readonly clientSecret: string;
  private readonly allowedChatId: string;

  constructor(
    private readonly config: ConfigService,
    private readonly sentryService: SentryService,
    private readonly dynamoDBService: DynamoDBService,
  ) {
    this.webhookToken = this.config.getOrThrow<string>('SENTRY_WEBHOOK_TOKEN');

    this.clientSecret = this.config.getOrThrow<string>(
      'SENTRY_INCIDENTPING_CLIENT_SECRET',
    );

    this.allowedChatId = this.config.getOrThrow<string>('LINQ_ALLOWED_CHAT_ID');

    this.linq = new Linq({
      apiKey: this.config.getOrThrow<string>('LINQ_API_KEY'),
    });
  }

  // Constant-time comparison of sensitive values
  private secureCompare(expected: string, received: string): boolean {
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(received);

    if (expectedBuffer.length !== receivedBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, receivedBuffer);
  }

  // Verify Sentry HMAC signature against the original request body
  private verifySignature(rawBody: Buffer, signature: string): boolean {
    if (!/^[a-fA-F0-9]{64}$/.test(signature)) {
      return false;
    }

    const expectedSignature = createHmac('sha256', this.clientSecret)
      .update(rawBody)
      .digest('hex');

    return this.secureCompare(expectedSignature, signature.toLowerCase());
  }

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(@Req() request: RawBodyRequest<Request>) {
    // Layer 1: Verify custom webhook token
    const token = request.get('X-IncidentPing-Token') ?? '';

    if (!this.secureCompare(this.webhookToken, token)) {
      this.logger.warn('Unauthorized Sentry webhook rejected');

      throw new UnauthorizedException('Invalid webhook token');
    }

    this.logger.log('Sentry webhook token verified');

    // Layer 2: Verify Sentry HMAC signature
    const signature = request.get('Sentry-Hook-Signature') ?? '';

    if (!request.rawBody || !this.verifySignature(request.rawBody, signature)) {
      this.logger.warn('Invalid Sentry webhook signature');

      throw new UnauthorizedException('Invalid webhook signature');
    }

    this.logger.log('Sentry HMAC signature verified successfully');

    // Only accept issue-related webhook events
    const resource = request.get('Sentry-Hook-Resource');

    if (resource !== 'issue') {
      return {
        received: true,
        ignored: true,
      };
    }

    const payload = request.body as SentryWebhookPayload;

    // Only process newly created issues
    if (payload?.action !== 'created') {
      return {
        received: true,
        ignored: true,
      };
    }

    const issueId = payload.data?.issue?.id;

    // Validate the issue identifier
    if (typeof issueId !== 'string' || !/^\d+$/.test(issueId)) {
      this.logger.warn('Invalid issue ID received in Sentry webhook');

      return {
        received: true,
        ignored: true,
      };
    }

    this.logger.log(`Processing new Sentry issue: ${issueId}`);

    // Atomically claim the incident in DynamoDB.
    // Only one Lambda invocation can successfully claim it.
    const claimed = await this.dynamoDBService.claimIncident(issueId);

    if (!claimed) {
      this.logger.log(`Duplicate issue ignored: ${issueId}`);

      return {
        received: true,
        duplicate: true,
      };
    }

    this.logger.log(`DynamoDB incident claim acquired: ${issueId}`);

    // Track the processing stage for error handling
    let stage = 'fetching issue details from Sentry';

    // Track whether an external notification has been attempted
    let notificationAttempted = false;

    try {
      // Retrieve verified issue details directly from Sentry
      this.logger.log(`Fetching Sentry issue details: ${issueId}`);

      const issue = await this.sentryService.getIssueDetails(issueId);

      this.logger.log(`Successfully retrieved issue ${issue.shortId}`);

      // Construct the incident notification
      const message = [
        '🚨 IncidentPing Alert',
        '',
        'A new incident has been detected.',
        '',
        `Issue: ${issue.shortId}`,
        `Error: ${issue.title}`,
        `Severity: ${issue.level.toUpperCase()}`,
        `Status: ${issue.status}`,
        `Occurrences: ${issue.count}`,
        '',
        'Reply to this message to investigate the incident.',
      ].join('\n');

      // Send the notification through Linq
      stage = 'sending notification through Linq';

      this.logger.log(
        `Sending incident notification to Linq for ${issue.shortId}`,
      );

      notificationAttempted = true;

      await this.linq.chats.messages.send(this.allowedChatId, {
        message: {
          parts: [
            {
              type: 'text',
              value: message,
            },
          ],
        },
      });

      this.logger.log(
        `Incident notification successfully sent for ${issue.shortId}`,
      );

      // Keep the DynamoDB claim to prevent duplicate notifications.
      // DynamoDB TTL will eventually remove the expired record.
      return {
        received: true,
        notified: true,
      };
    } catch (error) {
      // Release the claim only if notification delivery
      // has not yet been attempted.
      if (!notificationAttempted) {
        try {
          await this.dynamoDBService.releaseIncident(issueId);

          this.logger.log(`Released failed incident claim: ${issueId}`);
        } catch {
          this.logger.error(`Failed to release incident claim: ${issueId}`);
        }
      } else {
        // A failed API request does not necessarily mean
        // Linq failed to deliver the message.
        // Preserve the claim to avoid duplicate notifications.
        this.logger.warn(
          `Notification delivery uncertain for issue ${issueId}. Claim retained.`,
        );
      }

      if (error instanceof Error) {
        this.logger.error(
          `Failed while ${stage} for issue ${issueId}: ${error.message}`,
          error.stack,
        );
      } else {
        this.logger.error(
          `Failed while ${stage} for issue ${issueId}: ${String(error)}`,
        );
      }

      throw error;
    }
  }
}
