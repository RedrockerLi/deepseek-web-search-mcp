export interface HttpResponse {
  status: number;
  text: string;
}

export class RequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RequestError";
  }
}

export interface PostOptions {
  timeoutMs: number;
  totalBudgetMs: number;
}

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  log?: (line: string) => void;
}

const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 30_000;
const MIN_ATTEMPT_BUDGET_MS = 1_000;
const RETRY_AFTER_MAX_BACKOFF_MS = 8_000;

export class DeepSeekClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(options: DeepSeekClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.error(line));
  }

  async post(
    path: string,
    body: unknown,
    options: PostOptions,
  ): Promise<HttpResponse> {
    const url = `${this.baseUrl}${path}`;
    const deadline = this.now() + options.totalBudgetMs;

    let payload: string;
    try {
      payload = JSON.stringify(body);
    } catch (error) {
      throw new RequestError("Failed to serialize the request body.", {
        cause: error,
      });
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        break;
      }

      const timeoutMs = Math.min(options.timeoutMs, remaining);
      const startedAt = this.now();
      let response: Response;

      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": "deepseek-web-search-mcp/0.1.0",
          },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new RequestError(describeFetchError(error, timeoutMs), {
          cause: error,
        });
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw new RequestError("Failed to read the HTTP response body.", {
          cause: error,
        });
      }

      this.log(
        `${path} status=${response.status} durationMs=${this.now() - startedAt} attempt=${attempt + 1}`,
      );

      if (!isRetryableStatus(response.status) || attempt === MAX_RETRIES) {
        return { status: response.status, text };
      }

      const delayMs = this.retryDelayMs(response, attempt);
      if (delayMs === null) {
        return { status: response.status, text };
      }

      const remainingAfterDelay = deadline - this.now() - delayMs;
      if (remainingAfterDelay < MIN_ATTEMPT_BUDGET_MS) {
        return { status: response.status, text };
      }

      this.log(
        `${path} retrying in ${delayMs}ms after status=${response.status}`,
      );
      await this.sleep(delayMs);
    }

    throw new RequestError(
      `Request to ${path} exceeded the total time budget of ${options.totalBudgetMs}ms.`,
    );
  }

  private retryDelayMs(response: Response, attempt: number): number | null {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const parsed = parseRetryAfter(retryAfter, this.now());
      if (parsed !== null) {
        return parsed > MAX_RETRY_AFTER_MS ? null : parsed;
      }
    }

    return (
      Math.min(500 * 2 ** attempt, RETRY_AFTER_MAX_BACKOFF_MS) +
      Math.floor(this.random() * 250)
    );
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function parseRetryAfter(value: string, now: number): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return Math.max(0, timestamp - now);
}

function describeFetchError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `Request timed out after ${timeoutMs}ms.`;
    }
    return `Network request failed: ${error.message}`;
  }
  return "Network request failed.";
}
