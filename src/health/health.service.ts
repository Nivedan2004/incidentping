import { Injectable, Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  // Restrict health checks to the authorized website.
  // Never accept arbitrary URLs from the AI or user.
  private readonly websiteUrl = 'https://www.nivedan.website';

  // Prevent requests from hanging indefinitely
  private readonly timeoutMs = 10000;

  async checkWebsiteHealth() {
    this.logger.log('Checking portfolio website health');

    const startTime = performance.now();
    const checkedAt = new Date().toISOString();

    try {
      // Perform a real HTTP request to the deployed website
      const response = await fetch(this.websiteUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'manual',
        cache: 'no-store',
        headers: {
          'User-Agent': 'IncidentPing-HealthCheck/1.0',
        },
      });

      // Calculate the time taken to receive response headers
      const responseTimeMs = Math.round(performance.now() - startTime);

      // Release the response body since we only need HTTP metadata
      await response.body?.cancel();

      // Classify the observed website response
      let status: string;

      if (response.ok) {
        status = 'healthy';
      } else if (response.status >= 300 && response.status < 400) {
        status = 'redirect';
      } else if (response.status >= 500) {
        status = 'server_error';
      } else {
        status = 'http_error';
      }

      this.logger.log(
        `Health check completed: HTTP ${response.status} ` +
          `in ${responseTimeMs}ms`,
      );

      return {
        url: this.websiteUrl,
        status,
        reachable: true,
        healthy: response.ok,
        statusCode: response.status,
        responseTimeMs,
        checkedAt,
        message: response.ok
          ? 'Website responded successfully.'
          : `Website returned HTTP ${response.status}.`,
      };
    } catch (error) {
      const responseTimeMs = Math.round(performance.now() - startTime);

      // Distinguish timeouts from other connection failures
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';

      this.logger.warn(
        `Website health check failed: ${
          isTimeout ? 'Request timed out' : 'Connection failed'
        }`,
      );

      // Return structured diagnostic data without exposing
      // sensitive internal network information
      return {
        url: this.websiteUrl,
        status: isTimeout ? 'timeout' : 'unreachable',
        reachable: false,
        healthy: false,
        statusCode: null,
        responseTimeMs,
        checkedAt,
        message: isTimeout
          ? 'Website did not respond within 10 seconds.'
          : 'Unable to connect to the website.',
      };
    }
  }
}
