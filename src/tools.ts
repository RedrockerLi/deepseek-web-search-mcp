import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  DeepSeekClient,
  RequestError,
  type HttpResponse,
} from "./client.js";
import { ConfigError, readConfig } from "./config.js";
import {
  buildSearchQuery,
  QueryValidationError,
  validateOriQuestion,
} from "./query.js";

const MISSING_KEY_MESSAGE =
  "DEEPSEEK_API_KEY is not set. Configure it in the MCP server environment.";

const SEARCH_DESCRIPTION = [
  "Search the web with DeepSeek's search API and return the raw JSON response exactly as received.",
  "",
  "The response is a JSON object with a `results` array; fields include rerank_score, title, url, snippet, summary, content, site_name, site_icon, date, and authority.",
  "Set need_content=true to include full page content (can be very large). Prefer the fetch tool for a specific URL.",
  "",
  "query supports DeepSeek search syntax: site:github.com, -site:example.com, -term, \"exact phrase\", lang:zh,en, after:2025-01-01, before:2026.",
  "Structured filters are appended to query. Results are not filtered or truncated by this server.",
  "Billing: 5 CNY per 1,000 successful requests that produce results. Rate limit: 100 QPS.",
].join("\n");

const FETCH_DESCRIPTION = [
  "Fetch a URL through DeepSeek and return the raw JSON response exactly as received.",
  "",
  "The response is a JSON object with `title` (string) and `content` (Markdown). The content is not truncated by this server.",
  "The URL must be an absolute HTTP/HTTPS URL of at most 8192 characters and must not contain credentials.",
  "Billing: 5 CNY per 1,000 successful fetches. Rate limit: 25 QPS.",
].join("\n");

export const searchInputSchema = z.object({
  query: z
    .string()
    .describe(
      "Search text, 1-128 Unicode characters. Supports DeepSeek syntax: site:github.com, -site:example.com, -term, \"exact phrase\", lang:zh,en, after:2025-01-01, before:2026.",
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Number of results to return, 1-50. Default: 10."),
  need_content: z
    .boolean()
    .default(false)
    .describe(
      "Include full page content in each result. Default: false. Responses can be very large.",
    ),
  ori_question: z
    .string()
    .optional()
    .describe(
      "The user's original question, 1-128 characters. Helps the search service understand intent.",
    ),
  site: z
    .array(z.string())
    .optional()
    .describe("Only include these sites. Multiple sites are joined with OR."),
  exclude_sites: z
    .array(z.string())
    .optional()
    .describe("Exclude these sites."),
  lang: z
    .array(z.string())
    .optional()
    .describe('Preferred languages, for example ["zh", "en"].'),
  after: z
    .string()
    .optional()
    .describe(
      "Only results published after this date: YYYY, YYYY-MM, or YYYY-MM-DD.",
    ),
  before: z
    .string()
    .optional()
    .describe(
      "Only results published before this date: YYYY, YYYY-MM, or YYYY-MM-DD.",
    ),
  exact_phrase: z
    .string()
    .optional()
    .describe("Require this exact phrase."),
  exclude_terms: z
    .array(z.string())
    .optional()
    .describe("Exclude pages containing these terms."),
});

export const fetchInputSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(8192)
    .describe(
      "Absolute HTTP/HTTPS URL to fetch. Must not contain credentials.",
    ),
});

export type SearchArgs = z.infer<typeof searchInputSchema>;
export type FetchArgs = z.infer<typeof fetchInputSchema>;

export interface ToolDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  log?: (line: string) => void;
}

export function createSearchHandler(deps: ToolDeps = {}) {
  return async (args: SearchArgs): Promise<CallToolResult> => {
    try {
      const { apiKey, baseUrl } = readConfig(deps.env);
      if (!apiKey) {
        return errorResult(MISSING_KEY_MESSAGE);
      }

      const query = buildSearchQuery({
        query: args.query,
        site: args.site,
        exclude_sites: args.exclude_sites,
        lang: args.lang,
        after: args.after,
        before: args.before,
        exact_phrase: args.exact_phrase,
        exclude_terms: args.exclude_terms,
      });
      const oriQuestion = validateOriQuestion(args.ori_question);

      const body: Record<string, unknown> = {
        query,
        count: args.count,
        need_content: args.need_content,
      };
      if (oriQuestion !== undefined) {
        body.ori_question = oriQuestion;
      }

      const client = new DeepSeekClient({
        apiKey,
        baseUrl,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
        random: deps.random,
        now: deps.now,
        log: deps.log,
      });
      const response = await client.post("/v1/tools/search", body, {
        timeoutMs: 30_000,
        totalBudgetMs: 90_000,
      });
      return formatResponse(response);
    } catch (error) {
      return errorResult(describeError(error));
    }
  };
}

export function createFetchHandler(deps: ToolDeps = {}) {
  return async (args: FetchArgs): Promise<CallToolResult> => {
    try {
      const { apiKey, baseUrl } = readConfig(deps.env);
      if (!apiKey) {
        return errorResult(MISSING_KEY_MESSAGE);
      }

      const url = validateFetchUrl(args.url);
      const client = new DeepSeekClient({
        apiKey,
        baseUrl,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
        random: deps.random,
        now: deps.now,
        log: deps.log,
      });
      const response = await client.post(
        "/v1/tools/fetch",
        { url },
        { timeoutMs: 60_000, totalBudgetMs: 180_000 },
      );
      return formatResponse(response);
    } catch (error) {
      return errorResult(describeError(error));
    }
  };
}

export function registerTools(server: McpServer, deps: ToolDeps = {}): void {
  server.registerTool(
    "search",
    {
      title: "DeepSeek Web Search",
      description: SEARCH_DESCRIPTION,
      inputSchema: searchInputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    createSearchHandler(deps),
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch URL as Markdown",
      description: FETCH_DESCRIPTION,
      inputSchema: fetchInputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    createFetchHandler(deps),
  );
}

export function validateFetchUrl(raw: string): string {
  if (raw.length > 8192) {
    throw new QueryValidationError("url must be at most 8192 characters.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new QueryValidationError("url must be a valid absolute URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new QueryValidationError("url must use http or https.");
  }
  if (!url.hostname) {
    throw new QueryValidationError("url must include a host.");
  }
  if (url.username || url.password) {
    throw new QueryValidationError("url must not contain credentials.");
  }

  return raw;
}

function formatResponse(response: HttpResponse): CallToolResult {
  if (response.status >= 200 && response.status < 300) {
    return {
      content: [{ type: "text", text: response.text }],
    };
  }

  return {
    content: [
      { type: "text", text: `HTTP ${response.status}` },
      { type: "text", text: response.text },
    ],
    isError: true,
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function describeError(error: unknown): string {
  if (
    error instanceof QueryValidationError ||
    error instanceof ConfigError ||
    error instanceof RequestError
  ) {
    return error.message;
  }
  if (error instanceof Error) {
    return `Unexpected error: ${error.message}`;
  }
  return "Unexpected error.";
}
