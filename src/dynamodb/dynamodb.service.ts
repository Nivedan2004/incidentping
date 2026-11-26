import { Injectable, Logger } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

// Structure of a conversation exchange
export interface ConversationExchange {
  user: string;
  assistant: string;
}

@Injectable()
export class DynamoDBService {
  private readonly logger = new Logger(DynamoDBService.name);

  private readonly tableName = 'incidentping';

  // Retention periods in seconds
  private readonly deduplicationTTL = 7 * 24 * 60 * 60;
  private readonly conversationTTL = 30 * 24 * 60 * 60;

  private readonly client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: 'us-east-2',
    }),
    {
      marshallOptions: {
        removeUndefinedValues: true,
      },
    },
  );

  // Return the current Unix timestamp in seconds
  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  // Atomically claim an event before processing it
  private async claim(pk: string, sk: string): Promise<boolean> {
    const now = this.now();

    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,

          Item: {
            pk,
            sk,
            createdAt: now,
            expiresAt: now + this.deduplicationTTL,
          },

          // Only claim records that do not exist or have expired
          ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',

          ExpressionAttributeValues: {
            ':now': now,
          },
        }),
      );

      return true;
    } catch (error) {
      // Another invocation has already claimed this record
      if (
        error instanceof Error &&
        error.name === 'ConditionalCheckFailedException'
      ) {
        this.logger.log('Duplicate record detected');

        return false;
      }

      // Do not process the event if DynamoDB is unavailable
      this.logger.error('Failed to claim DynamoDB record');

      throw error;
    }
  }

  // Claim a Sentry issue before sending its notification
  async claimIncident(issueId: string): Promise<boolean> {
    return this.claim(`INCIDENT#${issueId}`, 'NOTIFICATION');
  }

  // Release an incident claim after a confirmed processing failure
  async releaseIncident(issueId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          pk: `INCIDENT#${issueId}`,
          sk: 'NOTIFICATION',
        },
      }),
    );
  }

  // Claim an incoming Linq event before processing it
  async claimEvent(eventId: string): Promise<boolean> {
    return this.claim(`EVENT#${eventId}`, 'PROCESSED');
  }

  // Release an event claim after a confirmed processing failure
  async releaseEvent(eventId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          pk: `EVENT#${eventId}`,
          sk: 'PROCESSED',
        },
      }),
    );
  }

  // Retrieve persistent conversation history
  async getConversation(chatId: string): Promise<ConversationExchange[]> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,

        Key: {
          pk: `CHAT#${chatId}`,
          sk: 'HISTORY',
        },

        // Retrieve the latest committed conversation
        ConsistentRead: true,
      }),
    );

    // Ignore missing or expired conversation records
    if (
      !result.Item ||
      typeof result.Item.expiresAt !== 'number' ||
      result.Item.expiresAt <= this.now()
    ) {
      return [];
    }

    return Array.isArray(result.Item.history) ? result.Item.history : [];
  }

  // Save conversation history with a refreshed expiration
  async saveConversation(
    chatId: string,
    history: ConversationExchange[],
  ): Promise<void> {
    const now = this.now();

    await this.client.send(
      new PutCommand({
        TableName: this.tableName,

        Item: {
          pk: `CHAT#${chatId}`,
          sk: 'HISTORY',

          // Limit stored history to the latest 10 exchanges
          history: history.slice(-10),

          updatedAt: now,
          expiresAt: now + this.conversationTTL,
        },
      }),
    );

    this.logger.log('Conversation history saved');
  }
}
