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
import Linq from '@linqapp/sdk';
import { GeminiService } from '../gemini/gemini.service.js';
import { DynamoDBService } from '../dynamodb/dynamodb.service.js';
import type { ConversationExchange } from '../dynamodb/dynamodb.service.js';

@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);
  private readonly linq: Linq;
  private readonly allowedChatId: string;

  constructor(
    private readonly config: ConfigService,
    private readonly geminiService: GeminiService,
    private readonly dynamoDBService: DynamoDBService,
  ) {
    // Load Linq credentials
    const apiKey = this.config.getOrThrow<string>('LINQ_API_KEY');

    const webhookSecret = this.config.getOrThrow<string>('LINQ_WEBHOOK_SECRET');

    // Initialize Linq with webhook verification support
    this.linq = new Linq({
      apiKey,
      webhookSecret,
    });

    // Load the authorized conversation ID
    this.allowedChatId = this.config.getOrThrow<string>('LINQ_ALLOWED_CHAT_ID');
  }

  // Build a prompt using persistent conversation history
  private buildConversationPrompt(
    history: ConversationExchange[],
    message: string,
  ): string {
    return JSON.stringify({
      instructions:
        'Use previous conversation exchanges only as context. ' +
        'Answer the current message. ' +
        'Retrieve fresh investigation data when needed. ' +
        'Do not treat previous assistant responses as verified current facts.',
      previousConversation: history,
      currentMessage: message,
    });
  }

  @Post()
  @HttpCode(200)
  async handleWebhook(@Req() request: RawBodyRequest<Request>) {
    // Signature verification requires the original request body
    if (!request.rawBody) {
      throw new UnauthorizedException('Missing raw request body');
    }

    // Extract the required Standard Webhooks headers
    const headers: Record<string, string> = {
      'webhook-id': request.get('webhook-id') ?? '',
      'webhook-timestamp': request.get('webhook-timestamp') ?? '',
      'webhook-signature': request.get('webhook-signature') ?? '',
    };

    // Reject requests without signature headers
    if (Object.values(headers).some((value) => !value)) {
      this.logger.warn('Missing webhook signature headers');

      throw new UnauthorizedException('Missing signature headers');
    }

    let event: any;

    try {
      // Verify and parse the authenticated payload
      event = this.linq.webhooks.unwrap(request.rawBody.toString('utf8'), {
        headers,
      });

      this.logger.log('Webhook signature verified successfully');
    } catch {
      this.logger.warn('Webhook signature verification failed');

      throw new UnauthorizedException('Invalid webhook signature');
    }

    // Only process incoming messages
    if (
      event?.event_type !== 'message.received' ||
      event.data?.direction !== 'inbound'
    ) {
      return { received: true, ignored: true };
    }

    const eventId = event.event_id;
    const chatId = event.data?.chat?.id;

    // Reject unauthorized conversations and group chats
    if (chatId !== this.allowedChatId || event.data?.chat?.is_group === true) {
      this.logger.warn('Unauthorized conversation ignored');

      return { received: true, ignored: true };
    }

    // Extract text from the incoming message
    const message = event.data?.parts
      ?.filter(
        (part: any) => part.type === 'text' && typeof part.value === 'string',
      )
      .map((part: any) => part.value)
      .join(' ');

    // Ignore incomplete or empty messages
    if (
      typeof eventId !== 'string' ||
      !eventId.trim() ||
      !chatId ||
      !message?.trim()
    ) {
      return { received: true, ignored: true };
    }

    // Atomically claim the event in DynamoDB.
    // This prevents duplicate processing across Lambda instances.
    const claimed = await this.dynamoDBService.claimEvent(eventId);

    if (!claimed) {
      this.logger.log(`Duplicate Linq event ignored: ${eventId}`);

      return { received: true, duplicate: true };
    }

    this.logger.log(`DynamoDB event claim acquired: ${eventId}`);

    // Track whether an external reply has been attempted
    let replyAttempted = false;

    try {
      this.logger.log('Processing authorized incoming message');

      // Retrieve persistent conversation history from DynamoDB
      const history = await this.dynamoDBService.getConversation(chatId);

      this.logger.log(
        `Loaded ${history.length} previous conversation exchanges`,
      );

      // Include previous conversation context
      const prompt = this.buildConversationPrompt(history, message);

      // Generate a context-aware AI response
      const aiResponse = await this.geminiService.generateResponse(prompt);

      // Send the response through Linq
      replyAttempted = true;

      await this.linq.chats.messages.send(chatId, {
        message: {
          parts: [
            {
              type: 'text',
              value: aiResponse,
            },
          ],
        },
      });

      this.logger.log('IncidentPing replied successfully');

      // Append the latest exchange to persistent history
      const updatedHistory: ConversationExchange[] = [
        ...history,
        {
          user: message,
          assistant: aiResponse,
        },
      ].slice(-10);

      // Save history after Linq accepts the outgoing message.
      // A storage failure must not trigger another outgoing reply.
      try {
        await this.dynamoDBService.saveConversation(chatId, updatedHistory);

        this.logger.log(
          `Persistent conversation updated: ${updatedHistory.length} exchanges`,
        );
      } catch {
        this.logger.error(
          'Reply sent, but conversation history could not be saved',
        );

        return {
          received: true,
          replied: true,
          historySaved: false,
        };
      }

      return {
        received: true,
        replied: true,
        historySaved: true,
      };
    } catch (error) {
      // Release the claim if no outgoing reply was attempted.
      // This allows safe retries for investigation failures.
      if (!replyAttempted) {
        try {
          await this.dynamoDBService.releaseEvent(eventId);

          this.logger.log(`Released failed Linq event claim: ${eventId}`);
        } catch {
          this.logger.error(`Failed to release Linq event claim: ${eventId}`);
        }
      } else {
        // Linq may have accepted the reply even if the request failed.
        // Retain the claim to reduce duplicate replies.
        this.logger.warn(
          `Reply delivery uncertain for event ${eventId}. Claim retained.`,
        );
      }

      this.logger.error('Failed to process incoming message');

      throw error;
    }
  }
}
