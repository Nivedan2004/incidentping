import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { WebhookController } from './webhook/webhook.controller.js';
import { GeminiService } from './gemini/gemini.service.js';
import { SentryService } from './sentry/sentry.service.js';
import { SentryController } from './sentry/sentry.controller.js';
import { GithubService } from './github/github.service.js';
import { HealthService } from './health/health.service.js';
import { DynamoDBService } from './dynamodb/dynamodb.service.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    // Make environment variables available throughout the application
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    // Configure application observability
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? 'YOUR_APP_KEY',
      appSecret: process.env.OBSERVE_APP_SECRET ?? 'YOUR_APP_SECRET',
      serviceId: 'incidentping',
    }),
  ],

  // Register application and webhook endpoints
  controllers: [AppController, WebhookController, SentryController],

  // Register injectable application services
  providers: [
    AppService,
    GeminiService,
    SentryService,
    GithubService,
    HealthService,
    DynamoDBService,
  ],
})
export class AppModule {}
