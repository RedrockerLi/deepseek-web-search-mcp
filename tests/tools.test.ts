import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createFetchHandler,
  createSearchHandler,
  searchInputSchema,
  validateFetchUrl,
  type FetchArgs,
  type SearchArgs,
  type ToolDeps,
} from "../src/tools.js";

type SearchInput = z.input<typeof searchInputSchema>;

interface StubResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface FetchCall {
  input: string | URL | Request;
  init?: RequestInit;
}

function searchArgs(overrides: Partial<SearchInput> = {}): SearchArgs {
  return searchInputSchema.parse({ query: "DeepSeek", ...overrides });
}

function fetchArgs(url: string): FetchArgs {
  return { url };
}

function stubDeps(response: StubResponse): {
  deps: ToolDeps;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ input, init });
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  }) as typeof fetch;

  return {
    deps: {
      env: { DEEPSEEK_API_KEY: "test-key" },
      fetchImpl,
      sleep: async () => {},
      random: () => 0,
      now: () => 0,
      log: () => {},
    },
    calls,
  };
}

function textAt(result: CallToolResult, index: number): string {
  const block = result.content[index];
  if (!block || block.type !== "text") {
    throw new Error(`Expected a text content block at index ${index}.`);
  }
  return block.text;
}

describe("search tool", () => {
  it("returns an error when DEEPSEEK_API_KEY is missing", async () => {
    const result = await createSearchHandler({ env: {} })(searchArgs());

    expect(result.isError).toBe(true);
    expect(textAt(result, 0)).toContain("DEEPSEEK_API_KEY");
  });

  it("returns the raw response body on success", async () => {
    const body = ' { "results" : [] } ';
    const { deps } = stubDeps({ status: 200, body });
    const result = await createSearchHandler(deps)(searchArgs());

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(textAt(result, 0)).toBe(body);
  });

  it("returns HTTP status plus the raw body on failure", async () => {
    const body = '{"error":{"message":"bad request"}}';
    const { deps } = stubDeps({ status: 400, body });
    const result = await createSearchHandler(deps)(searchArgs());

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(2);
    expect(textAt(result, 0)).toBe("HTTP 400");
    expect(textAt(result, 1)).toBe(body);
  });

  it("composes filters into the query and request body", async () => {
    const { deps, calls } = stubDeps({ status: 200, body: "{}" });
    const result = await createSearchHandler(deps)(
      searchArgs({
        query: "DeepSeek",
        count: 3,
        need_content: true,
        ori_question: "what is deepseek?",
        site: ["github.com"],
        exclude_sites: ["spam.test"],
        lang: ["zh"],
        after: "2025",
        before: "2026",
        exact_phrase: "deep seek",
        exclude_terms: ["ads"],
      }),
    );

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(String(calls[0]?.init?.body));
    expect(payload).toEqual({
      query:
        'DeepSeek "deep seek" site:github.com -site:spam.test -ads lang:zh after:2025 before:2026',
      count: 3,
      need_content: true,
      ori_question: "what is deepseek?",
    });
    expect(payload).not.toHaveProperty("localization");
  });

  it("applies defaults and omits undefined ori_question", async () => {
    const { deps, calls } = stubDeps({ status: 200, body: "{}" });
    await createSearchHandler(deps)(searchArgs());

    const payload = JSON.parse(String(calls[0]?.init?.body));
    expect(payload).toEqual({
      query: "DeepSeek",
      count: 10,
      need_content: false,
    });
  });

  it("rejects invalid input without calling the API", async () => {
    const { deps, calls } = stubDeps({ status: 200, body: "{}" });
    const result = await createSearchHandler(deps)(
      searchArgs({ query: "   " }),
    );

    expect(result.isError).toBe(true);
    expect(textAt(result, 0)).toContain("query must not be empty");
    expect(calls).toHaveLength(0);
  });

  it("reports invalid base URL configuration", async () => {
    const result = await createSearchHandler({
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "ftp://example.com",
      },
    })(searchArgs());

    expect(result.isError).toBe(true);
    expect(textAt(result, 0)).toContain("DEEPSEEK_BASE_URL");
  });

  it("does not expose the API key in results", async () => {
    const { deps } = stubDeps({ status: 500, body: "server error" });
    const result = await createSearchHandler(deps)(searchArgs());

    expect(JSON.stringify(result)).not.toContain("test-key");
  });

  it("reports network failures", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    const result = await createSearchHandler({
      env: { DEEPSEEK_API_KEY: "test-key" },
      fetchImpl,
    })(searchArgs());

    expect(result.isError).toBe(true);
    expect(textAt(result, 0)).toContain("Network request failed: boom");
  });
});

describe("fetch tool", () => {
  it("returns the raw response body on success", async () => {
    const body = '{"title":"Example","content":"hello"}';
    const { deps, calls } = stubDeps({ status: 200, body });
    const result = await createFetchHandler(deps)(
      fetchArgs("https://example.com/article"),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(textAt(result, 0)).toBe(body);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      url: "https://example.com/article",
    });
  });

  it("returns an error when DEEPSEEK_API_KEY is missing", async () => {
    const result = await createFetchHandler({ env: {} })(
      fetchArgs("https://example.com"),
    );

    expect(result.isError).toBe(true);
    expect(textAt(result, 0)).toContain("DEEPSEEK_API_KEY");
  });

  it("rejects invalid URLs without calling the API", async () => {
    const invalidUrls = [
      "ftp://example.com",
      "http://user:pass@example.com",
      "not a url",
      "https://",
      "a".repeat(8193),
    ];

    for (const url of invalidUrls) {
      const { deps, calls } = stubDeps({ status: 200, body: "{}" });
      const result = await createFetchHandler(deps)(fetchArgs(url));

      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
    }
  });

  it("returns HTTP status plus the raw body on failure", async () => {
    const body = '{"error":{"message":"not found"}}';
    const { deps } = stubDeps({ status: 404, body });
    const result = await createFetchHandler(deps)(
      fetchArgs("https://example.com/missing"),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(2);
    expect(textAt(result, 0)).toBe("HTTP 404");
    expect(textAt(result, 1)).toBe(body);
  });
});

describe("validateFetchUrl", () => {
  it("returns the URL unchanged when valid", () => {
    const url = "https://example.com/a?b=1#c";
    expect(validateFetchUrl(url)).toBe(url);
  });

  it("rejects credentials and non-HTTP protocols", () => {
    expect(() => validateFetchUrl("http://user:pass@example.com")).toThrow(
      /credentials/,
    );
    expect(() => validateFetchUrl("file:///etc/passwd")).toThrow(/http or https/);
  });
});
