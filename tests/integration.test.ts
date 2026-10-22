import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationRequested = process.env.DEEPSEEK_INTEGRATION === "1";
const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

if (integrationRequested && !apiKey) {
  throw new Error("DEEPSEEK_INTEGRATION=1 requires DEEPSEEK_API_KEY.");
}

describe.skipIf(!integrationRequested || !apiKey)(
  "DeepSeek API integration",
  () => {
    let client: Client | undefined;

    beforeAll(async () => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["dist/index.js"],
        env: { ...env, DEEPSEEK_API_KEY: apiKey!, DEEPSEEK_INTEGRATION: "1" },
      });

      client = new Client({
        name: "deepseek-web-search-integration",
        version: "0.0.0",
      });
      await client.connect(transport);
    });

    afterAll(async () => {
      await client?.close();
    });

    it("returns raw search JSON", async () => {
      const result = await client!.callTool({
        name: "search",
        arguments: { query: "DeepSeek", count: 2 },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(firstText(result)) as { results?: unknown };
      expect(Array.isArray(parsed.results)).toBe(true);
    });

    it("returns raw fetch JSON with Markdown content", async () => {
      const result = await client!.callTool({
        name: "fetch",
        arguments: {
          url: "https://api-docs.deepseek.com/zh-cn/guides/search",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(firstText(result)) as {
        title?: unknown;
        content?: unknown;
      };
      expect(typeof parsed.title).toBe("string");
      expect(typeof parsed.content).toBe("string");
      expect((parsed.content as string).length).toBeGreaterThan(0);
    });

    it("rejects invalid input without calling the API", async () => {
      const result = await client!.callTool({
        name: "search",
        arguments: { query: "   " },
      });

      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/query must not be empty/);
    });
  },
);

function firstText(result: CallToolResult): string {
  const block = result.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Expected a text content block.");
  }
  return block.text;
}
