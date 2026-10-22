import { describe, expect, it } from "vitest";

import {
  buildSearchQuery,
  QueryValidationError,
  validateOriQuestion,
} from "../src/query.js";

describe("buildSearchQuery", () => {
  it("returns the query unchanged when no filters are provided", () => {
    expect(buildSearchQuery({ query: "DeepSeek" })).toBe("DeepSeek");
  });

  it("preserves query whitespace", () => {
    expect(buildSearchQuery({ query: "  DeepSeek  " })).toBe("  DeepSeek  ");
  });

  it("rejects empty or whitespace-only queries", () => {
    expect(() => buildSearchQuery({ query: "" })).toThrow(QueryValidationError);
    expect(() => buildSearchQuery({ query: "   " })).toThrow(
      /query must not be empty/,
    );
  });

  it("joins multiple sites with OR", () => {
    expect(
      buildSearchQuery({
        query: "DeepSeek",
        site: ["github.com", "https://example.com/docs"],
      }),
    ).toBe("DeepSeek site:github.com OR site:example.com");
  });

  it("normalizes and deduplicates sites", () => {
    expect(
      buildSearchQuery({
        query: "DeepSeek",
        site: ["GitHub.com", "github.com/", "github.com"],
      }),
    ).toBe("DeepSeek site:github.com");
  });

  it("rejects invalid sites", () => {
    expect(() =>
      buildSearchQuery({ query: "DeepSeek", site: [" "] }),
    ).toThrow(QueryValidationError);
    expect(() =>
      buildSearchQuery({ query: "DeepSeek", site: ["foo bar"] }),
    ).toThrow(/invalid site/);
    expect(() =>
      buildSearchQuery({ query: "DeepSeek", site: ['foo"bar'] }),
    ).toThrow(/invalid site/);
    expect(() =>
      buildSearchQuery({ query: "DeepSeek", site: ["ftp://example.com"] }),
    ).toThrow(/invalid site/);
  });

  it("prefixes excluded sites", () => {
    expect(
      buildSearchQuery({
        query: "DeepSeek",
        exclude_sites: ["example.com", "spam.test"],
      }),
    ).toBe("DeepSeek -site:example.com -site:spam.test");
  });

  it("joins languages with commas and deduplicates them", () => {
    expect(
      buildSearchQuery({ query: "DeepSeek", lang: ["zh", "en", "zh"] }),
    ).toBe("DeepSeek lang:zh,en");
    expect(buildSearchQuery({ query: "DeepSeek", lang: ["zh,en"] })).toBe(
      "DeepSeek lang:zh,en",
    );
  });

  it("validates dates", () => {
    expect(
      buildSearchQuery({
        query: "DeepSeek",
        after: "2025",
        before: "2026-06-01",
      }),
    ).toBe("DeepSeek after:2025 before:2026-06-01");
    expect(() =>
      buildSearchQuery({ query: "DeepSeek", after: "2025-13" }),
    ).toThrow(/after must be/);
    expect(() =>
      buildSearchQuery({ query: "DeepSeek", before: "" }),
    ).toThrow(/before must be/);
  });

  it("quotes and escapes exact phrases", () => {
    expect(
      buildSearchQuery({
        query: "DeepSeek",
        exact_phrase: 'release "notes"',
      }),
    ).toBe('DeepSeek "release \\"notes\\""');
  });

  it("quotes exclude terms containing whitespace", () => {
    expect(
      buildSearchQuery({
        query: "DeepSeek",
        exclude_terms: ["ads", "release notes"],
      }),
    ).toBe('DeepSeek -ads -"release notes"');
  });

  it("orders filters predictably", () => {
    expect(
      buildSearchQuery({
        query: "DeepSeek",
        exact_phrase: "exact",
        site: ["a.test"],
        exclude_sites: ["b.test"],
        exclude_terms: ["bad"],
        lang: ["en"],
        after: "2025",
        before: "2026",
      }),
    ).toBe(
      'DeepSeek "exact" site:a.test -site:b.test -bad lang:en after:2025 before:2026',
    );
  });

  it("counts Unicode code points for the 128-character limit", () => {
    const max = "a".repeat(128);
    expect(buildSearchQuery({ query: max })).toBe(max);
    expect(() => buildSearchQuery({ query: "a".repeat(129) })).toThrow(
      /1-128/,
    );

    const emoji = "😀".repeat(128);
    expect(buildSearchQuery({ query: emoji })).toBe(emoji);
    expect(() => buildSearchQuery({ query: "😀".repeat(129) })).toThrow(
      /1-128/,
    );
  });

  it("rejects filters that push the query over 128 characters", () => {
    expect(() =>
      buildSearchQuery({
        query: "a".repeat(120),
        site: ["example.com"],
      }),
    ).toThrow(/1-128/);
  });
});

describe("validateOriQuestion", () => {
  it("passes through undefined", () => {
    expect(validateOriQuestion(undefined)).toBeUndefined();
  });

  it("accepts up to 128 code points", () => {
    const value = "😀".repeat(128);
    expect(validateOriQuestion(value)).toBe(value);
  });

  it("rejects empty and overlong values", () => {
    expect(() => validateOriQuestion("   ")).toThrow(/ori_question/);
    expect(() => validateOriQuestion("😀".repeat(129))).toThrow(/128/);
  });
});
