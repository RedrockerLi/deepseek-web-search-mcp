import { describe, expect, it } from "vitest";

import {
  DeepSeekClient,
  RequestError,
  type DeepSeekClientOptions,
} from "../src/client.js";

interface StubResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface FetchCall {
  input: string | URL | Request;
  init?: RequestInit;
}

function fetchSequence(sequence: StubResponse[]): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let index = 0;

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ input, init });
    const item = sequence[Math.min(index, sequence.length - 1)];
    if (!item) {
      throw new Error("empty response sequence");
    }
    index += 1;
    return new Response(item.body, {
      status: item.status,
      headers: item.headers,
    });
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function makeClient(
  fetchImpl: typeof fetch,
  overrides: Partial<DeepSeekClientOptions> = {},
): {
  client: DeepSeekClient;
  logs: string[];
  delays: number[];
} {
  const logs: string[] = [];
  const delays: number[] = [];

  const client = new DeepSeekClient({
    apiKey: "test-key",
    baseUrl: "https://api.deepseek.com",
    fetchImpl,
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0,
    now: () => 0,
    log: (line) => {
      logs.push(line);
    },
    ...overrides,
  });

  return { client, logs, delays };
}

const requestOptions = { timeoutMs: 1000, totalBudgetMs: 5000 };

describe("DeepSeekClient", () => {
  it("returns the response body verbatim", async () => {
    const { fetchImpl, calls } = fetchSequence([
      { status: 200, body: ' { "results" : [] } ' },
    ]);
    const { client } = makeClient(fetchImpl);

    const result = await client.post(
      "/v1/tools/search",
      { query: "x" },
      requestOptions,
    );

    expect(calls).toHaveLength(1);
    expect(result).toEqual({ status: 200, text: ' { "results" : [] } ' });
  });

  it("sends the expected headers and body", async () => {
    const { fetchImpl, calls } = fetchSequence([
      { status: 200, body: "{}" },
    ]);
    const { client } = makeClient(fetchImpl);

    await client.post(
      "/v1/tools/search",
      { query: "x", count: 3 },
      requestOptions,
    );

    const init = calls[0]?.init;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("user-agent")).toBe("deepseek-web-search-mcp/0.1.0");
    expect(JSON.parse(String(init?.body))).toEqual({ query: "x", count: 3 });
    expect(calls[0]?.input).toBe(
      "https://api.deepseek.com/v1/tools/search",
    );
  });

  it("preserves a base URL path prefix", async () => {
    const { fetchImpl, calls } = fetchSequence([
      { status: 200, body: "{}" },
    ]);
    const { client } = makeClient(fetchImpl, {
      baseUrl: "https://proxy.example.com/deepseek/",
    });

    await client.post("/v1/tools/search", {}, requestOptions);

    expect(calls[0]?.input).toBe(
      "https://proxy.example.com/deepseek/v1/tools/search",
    );
  });

  it("does not retry non-retryable 4xx responses", async () => {
    for (const status of [400, 401, 402, 403, 404, 413]) {
      const { fetchImpl, calls } = fetchSequence([
        { status, body: '{"error":"x"}' },
        { status: 200, body: "{}" },
      ]);
      const { client } = makeClient(fetchImpl);

      const result = await client.post("/v1/tools/search", {}, requestOptions);

      expect(result.status).toBe(status);
      expect(calls).toHaveLength(1);
    }
  });

  it("retries 408, 429, and 5xx up to two times with backoff", async () => {
    const { fetchImpl, calls } = fetchSequence([
      { status: 500, body: "a" },
      { status: 502, body: "b" },
      { status: 200, body: "c" },
    ]);
    const { client, delays } = makeClient(fetchImpl);

    const result = await client.post("/v1/tools/search", {}, requestOptions);

    expect(calls).toHaveLength(3);
    expect(result).toEqual({ status: 200, text: "c" });
    expect(delays).toEqual([500, 1000]);
  });

  it("returns the last response after exhausting retries", async () => {
    const { fetchImpl, calls } = fetchSequence([
      { status: 500, body: "a" },
      { status: 500, body: "b" },
      { status: 503, body: "c" },
    ]);
    const { client } = makeClient(fetchImpl);

    const result = await client.post("/v1/tools/search", {}, requestOptions);

    expect(calls).toHaveLength(3);
    expect(result).toEqual({ status: 503, text: "c" });
  });

  it("honors Retry-After seconds", async () => {
    const { fetchImpl } = fetchSequence([
      { status: 429, body: "", headers: { "retry-after": "1" } },
      { status: 200, body: "ok" },
    ]);
    const { client, delays } = makeClient(fetchImpl);

    const result = await client.post("/v1/tools/search", {}, requestOptions);

    expect(result).toEqual({ status: 200, text: "ok" });
    expect(delays).toEqual([1000]);
  });

  it("honors Retry-After HTTP dates", async () => {
    const { fetchImpl } = fetchSequence([
      {
        status: 429,
        body: "",
        headers: { "retry-after": new Date(2000).toUTCString() },
      },
      { status: 200, body: "ok" },
    ]);
    const { client, delays } = makeClient(fetchImpl);

    await client.post("/v1/tools/search", {}, requestOptions);

    expect(delays).toEqual([2000]);
  });

  it("does not wait for Retry-After longer than 30 seconds", async () => {
    const { fetchImpl, calls } = fetchSequence([
      { status: 429, body: "slow down", headers: { "retry-after": "60" } },
      { status: 200, body: "ok" },
    ]);
    const { client } = makeClient(fetchImpl);

    const result = await client.post("/v1/tools/search", {}, requestOptions);

    expect(calls).toHaveLength(1);
    expect(result).toEqual({ status: 429, text: "slow down" });
  });

  it("stops retrying when the total budget is exhausted", async () => {
    let time = 0;
    const calls: FetchCall[] = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ input, init });
      time += 1000;
      return new Response("busy", { status: 500 });
    }) as typeof fetch;

    const { client } = makeClient(fetchImpl, { now: () => time });

    const result = await client.post("/v1/tools/search", {}, {
      timeoutMs: 1000,
      totalBudgetMs: 1500,
    });

    expect(calls).toHaveLength(1);
    expect(result).toEqual({ status: 500, text: "busy" });
  });

  it("throws RequestError on timeout without retrying", async () => {
    const fetchImpl = (async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    }) as typeof fetch;
    const { client } = makeClient(fetchImpl);

    await expect(
      client.post("/v1/tools/search", {}, requestOptions),
    ).rejects.toThrow(/timed out after 1000ms/);
  });

  it("wraps network errors without leaking the API key", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection reset");
    }) as typeof fetch;
    const { client } = makeClient(fetchImpl);

    const error = await client
      .post("/v1/tools/search", {}, requestOptions)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RequestError);
    expect((error as Error).message).toContain(
      "Network request failed: connection reset",
    );
    expect((error as Error).message).not.toContain("test-key");
  });

  it("does not log the API key or request body", async () => {
    const { fetchImpl } = fetchSequence([
      { status: 200, body: "{}" },
    ]);
    const { client, logs } = makeClient(fetchImpl);

    await client.post(
      "/v1/tools/search",
      { query: "secret query" },
      requestOptions,
    );

    const output = logs.join("\n");
    expect(output).toContain("status=200");
    expect(output).not.toContain("test-key");
    expect(output).not.toContain("secret query");
  });
});
