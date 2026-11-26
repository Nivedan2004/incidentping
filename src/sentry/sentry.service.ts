import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Define the Sentry issue structure
interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  status: string;
  level: string;
  count: string;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  project: {
    id: string | number;
    slug: string;
  };
}

// Define the relevant stack trace fields
interface SentryFrame {
  filename?: string;
  function?: string;
  lineNo?: number;
  inApp?: boolean;
}

// Define the relevant Sentry event structure
interface SentryEvent {
  eventID: string;
  platform: string;
  entries?: {
    type: string;
    data?: {
      values?: {
        type?: string;
        stacktrace?: {
          frames?: SentryFrame[];
        };
      }[];
    };
  }[];
}

// Define the short ID resolution response
interface SentryShortIdResponse {
  groupId: string;
  projectSlug: string;
  organizationSlug: string;
}

@Injectable()
export class SentryService {
  private readonly logger = new Logger(SentryService.name);

  private readonly apiToken: string;
  private readonly organization: string;
  private readonly projectId: string;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    // Load Sentry configuration
    this.apiToken = this.config.getOrThrow<string>('SENTRY_API_TOKEN');

    this.organization = this.config.getOrThrow<string>('SENTRY_ORG');

    this.projectId = this.config.getOrThrow<string>('SENTRY_PROJECT_ID');

    this.baseUrl = this.config.getOrThrow<string>('SENTRY_BASE_URL');
  }

  // Reusable authenticated Sentry API request
  private async request<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: 'application/json',
      },

      // Prevent requests from hanging indefinitely
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      this.logger.error(
        `Sentry API returned ${response.status} for ${endpoint}`,
      );

      throw new Error(`Sentry API returned ${response.status}`);
    }

    return (await response.json()) as T;
  }

  // Remove local machine paths and limit text length
  private sanitize(value: string | undefined): string {
    return (value ?? '')
      .replace(/\/Users\/[^/\s]+/g, '[LOCAL_HOME]')
      .replace(/\/home\/[^/\s]+/g, '[LOCAL_HOME]')
      .replace(/[\r\n\t]/g, ' ')
      .slice(0, 500);
  }

  // Return only the issue fields required for investigation
  private summarizeIssue(issue: SentryIssue) {
    return {
      id: issue.id,
      shortId: issue.shortId,
      title: this.sanitize(issue.title),
      status: issue.status,
      level: issue.level,
      count: Number(issue.count),
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
    };
  }

  // Resolve a short ID or numeric ID into a numeric Sentry ID
  private async resolveIssueId(identifier: string): Promise<string> {
    if (typeof identifier !== 'string') {
      throw new Error('Issue identifier must be a string');
    }

    const normalizedId = identifier.trim().toUpperCase();

    // Numeric IDs can be used directly
    if (/^\d+$/.test(normalizedId)) {
      return normalizedId;
    }

    // Validate human-readable Sentry issue IDs
    if (!/^[A-Z0-9_-]+-[A-Z0-9]+$/.test(normalizedId)) {
      throw new Error('Invalid Sentry issue identifier');
    }

    this.logger.log(`Resolving short issue ID: ${normalizedId}`);

    // Use Sentry's dedicated short ID resolution endpoint
    const result = await this.request<SentryShortIdResponse>(
      `/organizations/${this.organization}/shortids/${encodeURIComponent(normalizedId)}/`,
    );

    // Validate the returned organization and numeric issue ID
    if (
      result.organizationSlug !== this.organization ||
      !/^\d+$/.test(String(result.groupId))
    ) {
      throw new Error('Invalid Sentry issue resolution');
    }

    const issueId = String(result.groupId);

    this.logger.log(`Resolved ${normalizedId} to ${issueId}`);

    return issueId;
  }

  // Resolve the identifier and verify project ownership
  private async getAuthorizedIssue(identifier: string): Promise<SentryIssue> {
    const issueId = await this.resolveIssueId(identifier);

    const issue = await this.request<SentryIssue>(
      `/organizations/${this.organization}/issues/${issueId}/`,
    );

    // Prevent access to incidents outside the configured project
    if (String(issue.project?.id) !== this.projectId) {
      this.logger.warn('Attempted access to an unauthorized Sentry project');

      throw new Error('Issue does not belong to the configured project');
    }

    return issue;
  }

  // Tool 1: Retrieve unresolved incidents
  async getIssues() {
    this.logger.log('Retrieving unresolved Sentry issues');

    const issues = await this.request<SentryIssue[]>(
      `/organizations/${this.organization}/issues/?project=${this.projectId}&query=is%3Aunresolved&per_page=20`,
    );

    // Return only incidents belonging to the configured project
    return issues
      .filter((issue) => String(issue.project?.id) === this.projectId)
      .slice(0, 20)
      .map((issue) => this.summarizeIssue(issue));
  }

  // Tool 2: Retrieve details using either identifier format
  async getIssueDetails(identifier: string) {
    this.logger.log('Retrieving Sentry issue details');

    const issue = await this.getAuthorizedIssue(identifier);

    return this.summarizeIssue(issue);
  }

  // Tool 3: Retrieve exception details and stack traces
  async getLatestEvent(identifier: string) {
    this.logger.log('Retrieving latest Sentry event');

    // Resolve the identifier and verify project ownership
    const issue = await this.getAuthorizedIssue(identifier);

    // Always use the resolved numeric ID
    const event = await this.request<SentryEvent>(
      `/organizations/${this.organization}/issues/${issue.id}/events/latest/`,
    );

    // Extract only exception entries
    const exceptions = (event.entries ?? [])
      .filter((entry) => entry.type === 'exception')
      .flatMap((entry) => entry.data?.values ?? [])
      .slice(0, 5);

    this.logger.log(`Retrieved latest event for ${issue.shortId}`);

    return {
      issue: this.summarizeIssue(issue),
      eventId: event.eventID,
      platform: event.platform,

      exceptions: exceptions.map((exception) => ({
        type: this.sanitize(exception.type),

        // Return a limited number of relevant stack frames
        frames: (exception.stacktrace?.frames ?? [])
          .slice(-15)
          .map((frame) => ({
            filename: this.sanitize(frame.filename),
            function: this.sanitize(frame.function),
            line: frame.lineNo,
            inApp: frame.inApp,
          })),
      })),
    };
  }
}
