import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// GitHub source file response
interface GitHubFile {
  type: string;
  path: string;
  size: number;
  encoding: string;
  content: string;
  sha: string;
}

// GitHub commit response
interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: {
      date: string;
    };
  };
  files?: {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }[];
}

@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);
  private readonly token: string;
  private readonly owner: string;
  private readonly repository: string;
  private readonly branch: string;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.token = this.config.getOrThrow<string>('GITHUB_TOKEN');

    this.owner = this.config.getOrThrow<string>('GITHUB_OWNER');

    this.repository = this.config.getOrThrow<string>('GITHUB_REPO');

    this.branch = this.config.getOrThrow<string>('GITHUB_BRANCH');

    // Restrict requests to the configured repository
    this.baseUrl =
      `https://api.github.com/repos/` +
      `${encodeURIComponent(this.owner)}/` +
      `${encodeURIComponent(this.repository)}`;
  }

  // Execute authenticated, read-only GitHub API requests
  private async request<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });

    if (!response.ok) {
      this.logger.error(`GitHub API returned status ${response.status}`);

      throw new Error(`GitHub API returned ${response.status}`);
    }

    return (await response.json()) as T;
  }

  // Restrict access to ordinary source code files
  private validatePath(filePath: string): void {
    if (
      typeof filePath !== 'string' ||
      !filePath ||
      filePath.length > 500 ||
      filePath.startsWith('/') ||
      !/^[a-zA-Z0-9_./()[\]-]+$/.test(filePath)
    ) {
      throw new Error('Invalid source file path');
    }

    const segments = filePath.toLowerCase().split('/');

    // Block hidden files, traversal and sensitive directories
    if (
      segments.some(
        (segment) =>
          !segment ||
          segment.startsWith('.') ||
          /^(secrets?|credentials?|private|node_modules|dist|build)$/.test(
            segment,
          ),
      )
    ) {
      throw new Error('Restricted source file path');
    }

    // Only allow supported source code extensions
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|css|html|py|sql)$/.test(filePath)) {
      throw new Error('Unsupported source file type');
    }

    // Block filenames commonly associated with credentials
    if (
      /secret|credential|password|private.?key|service.?account/i.test(filePath)
    ) {
      throw new Error('Sensitive file access denied');
    }
  }

  // Retrieve source code around a specific line
  async getFileContent(filePath: string, lineNumber?: number) {
    this.validatePath(filePath);

    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');

    this.logger.log(`Retrieving source file: ${filePath}`);

    const file = await this.request<GitHubFile>(
      `/contents/${encodedPath}` + `?ref=${encodeURIComponent(this.branch)}`,
    );

    // Prevent directory retrieval and oversized responses
    if (
      file.type !== 'file' ||
      file.encoding !== 'base64' ||
      file.size > 100000
    ) {
      throw new Error('Unsupported file or file too large');
    }

    const content = Buffer.from(file.content, 'base64').toString('utf8');

    const lines = content.split(/\r?\n/);

    // Validate the requested line number
    if (
      lineNumber !== undefined &&
      (!Number.isInteger(lineNumber) ||
        lineNumber < 1 ||
        lineNumber > lines.length)
    ) {
      throw new Error('Invalid source line number');
    }

    // Retrieve 20 surrounding lines or the first 80 lines
    const start = lineNumber ? Math.max(0, lineNumber - 21) : 0;

    const end = lineNumber
      ? Math.min(lines.length, lineNumber + 20)
      : Math.min(lines.length, 80);

    const numberedContent = lines
      .slice(start, end)
      .map((line, index) => `${start + index + 1}: ${line}`)
      .join('\n');

    return {
      repository: `${this.owner}/${this.repository}`,
      branch: this.branch,
      path: file.path,
      blobSha: file.sha,
      totalLines: lines.length,
      startLine: start + 1,
      endLine: end,
      content: numberedContent.slice(0, 12000),
    };
  }

  // Retrieve the five most recent commits
  async getRecentCommits() {
    this.logger.log('Retrieving recent GitHub commits');

    const commits = await this.request<GitHubCommit[]>(
      `/commits?sha=${encodeURIComponent(this.branch)}` + '&per_page=5',
    );

    return commits.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message.slice(0, 500),
      date: commit.commit.author.date,
    }));
  }

  // Retrieve metadata about changes in a specific commit
  async getCommitDetails(sha: string) {
    if (typeof sha !== 'string' || !/^[a-fA-F0-9]{40}$/.test(sha)) {
      throw new Error('Invalid GitHub commit SHA');
    }

    this.logger.log('Retrieving GitHub commit details');

    const commit = await this.request<GitHubCommit>(`/commits/${sha}`);

    return {
      sha: commit.sha,
      message: commit.commit.message.slice(0, 500),
      date: commit.commit.author.date,
      files: (commit.files ?? [])
        .filter((file) => {
          try {
            this.validatePath(file.filename);
            return true;
          } catch {
            return false;
          }
        })
        .slice(0, 10)
        .map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
        })),
    };
  }
}
