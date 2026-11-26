import { NestFactory } from '@nestjs/core';
import { configure as serverlessExpress } from '@codegenie/serverless-express';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { AppModule } from './app.module.js';

// Cache the handler across warm Lambda invocations
let cachedHandler: ReturnType<typeof serverlessExpress>;

// Initialize NestJS without starting an HTTP server
async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Preserve raw bodies for webhook signature verification
    rawBody: true,
  });

  await app.init();

  // Retrieve the underlying Express application
  const expressApp = app.getHttpAdapter().getInstance();

  // Use promise-based resolution for Node.js 24
  return serverlessExpress({
    app: expressApp,
    resolutionMode: 'PROMISE',
  });
}

// AWS Lambda entry point with only two parameters
export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
) => {
  // Initialize NestJS only when necessary
  cachedHandler ??= await bootstrap();

  // Satisfy the adapter's callback type requirement.
  // Promise mode does not use this callback.
  return cachedHandler(event, context, () => {});
};
