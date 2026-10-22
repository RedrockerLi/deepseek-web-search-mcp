export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryValidationError";
  }
}

export interface SearchFilterInput {
  query: string;
  site?: string[];
  exclude_sites?: string[];
  lang?: string[];
  after?: string;
  before?: string;
  exact_phrase?: string;
  exclude_terms?: string[];
}

const MAX_QUERY_CODE_POINTS = 128;
const DATE_PATTERN = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const SITE_INVALID_PATTERN = /[\s"\\@]/;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function buildSearchQuery(input: SearchFilterInput): string {
  if (input.query.trim().length === 0) {
    throw new QueryValidationError(
      "query must not be empty or whitespace-only.",
    );
  }

  const parts: string[] = [input.query];

  if (input.exact_phrase !== undefined) {
    const phrase = normalizeText(input.exact_phrase, "exact_phrase");
    parts.push(`"${escapeQuoted(phrase)}"`);
  }

  const sites = normalizeSites(input.site, "site");
  if (sites.length > 0) {
    parts.push(sites.map((site) => `site:${site}`).join(" OR "));
  }

  const excludedSites = normalizeSites(input.exclude_sites, "exclude_sites");
  if (excludedSites.length > 0) {
    parts.push(excludedSites.map((site) => `-site:${site}`).join(" "));
  }

  const excludeTerms = normalizeTerms(input.exclude_terms);
  if (excludeTerms.length > 0) {
    parts.push(excludeTerms.map((term) => `-${quoteTerm(term)}`).join(" "));
  }

  const langs = normalizeLangs(input.lang);
  if (langs.length > 0) {
    parts.push(`lang:${langs.join(",")}`);
  }

  if (input.after !== undefined) {
    parts.push(`after:${normalizeDate(input.after, "after")}`);
  }
  if (input.before !== undefined) {
    parts.push(`before:${normalizeDate(input.before, "before")}`);
  }

  const composed = parts.join(" ");
  const length = codePointLength(composed);
  if (length > MAX_QUERY_CODE_POINTS) {
    throw new QueryValidationError(
      `composed query must be 1-${MAX_QUERY_CODE_POINTS} Unicode characters (got ${length}); shorten query or reduce filters.`,
    );
  }

  return composed;
}

export function validateOriQuestion(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0) {
    throw new QueryValidationError(
      "ori_question must not be empty or whitespace-only.",
    );
  }

  const length = codePointLength(value);
  if (length > MAX_QUERY_CODE_POINTS) {
    throw new QueryValidationError(
      `ori_question must be at most ${MAX_QUERY_CODE_POINTS} Unicode characters (got ${length}).`,
    );
  }
  return value;
}

function normalizeText(value: string, field: string): string {
  const text = value.trim();
  if (!text) {
    throw new QueryValidationError(`${field} must not be empty.`);
  }
  if (/[\r\n]/.test(text)) {
    throw new QueryValidationError(`${field} must not contain line breaks.`);
  }
  return text;
}

function normalizeSites(values: string[] | undefined, field: string): string[] {
  if (!values) {
    return [];
  }

  const result: string[] = [];
  for (const value of values) {
    const site = normalizeSite(value, field);
    if (!result.includes(site)) {
      result.push(site);
    }
  }
  return result;
}

function normalizeSite(value: string, field: string): string {
  const raw = normalizeText(value, field);

  if (SCHEME_PATTERN.test(raw) && !/^https?:\/\//i.test(raw)) {
    throw new QueryValidationError(
      `${field} contains an invalid site: ${value}`,
    );
  }

  let site = raw.replace(/^https?:\/\//i, "");
  const cut = site.search(/[/?#]/);
  if (cut >= 0) {
    site = site.slice(0, cut);
  }
  site = site.replace(/\/+$/, "").toLowerCase();

  if (!site || SITE_INVALID_PATTERN.test(site) || site.startsWith("-")) {
    throw new QueryValidationError(
      `${field} contains an invalid site: ${value}`,
    );
  }

  return site;
}

function normalizeTerms(values: string[] | undefined): string[] {
  if (!values) {
    return [];
  }

  const result: string[] = [];
  for (const value of values) {
    const term = normalizeText(value, "exclude_terms");
    if (!result.includes(term)) {
      result.push(term);
    }
  }
  return result;
}

function normalizeLangs(values: string[] | undefined): string[] {
  if (!values) {
    return [];
  }

  const result: string[] = [];
  for (const value of values) {
    for (const part of value.split(",")) {
      const lang = part.trim();
      if (!lang) {
        continue;
      }
      if (!/^[A-Za-z0-9_-]+$/.test(lang)) {
        throw new QueryValidationError(
          `lang contains an invalid value: ${value}`,
        );
      }
      if (!result.includes(lang)) {
        result.push(lang);
      }
    }
  }
  return result;
}

function normalizeDate(value: string, field: "after" | "before"): string {
  const date = value.trim();
  const match = DATE_PATTERN.exec(date);
  if (!match) {
    throw new QueryValidationError(
      `${field} must be YYYY, YYYY-MM, or YYYY-MM-DD.`,
    );
  }

  const month = match[2];
  const day = match[3];
  if (month !== undefined && (Number(month) < 1 || Number(month) > 12)) {
    throw new QueryValidationError(
      `${field} must be YYYY, YYYY-MM, or YYYY-MM-DD.`,
    );
  }
  if (day !== undefined && (Number(day) < 1 || Number(day) > 31)) {
    throw new QueryValidationError(
      `${field} must be YYYY, YYYY-MM, or YYYY-MM-DD.`,
    );
  }

  return date;
}

function quoteTerm(term: string): string {
  if (/[\s"\\]/.test(term)) {
    return `"${escapeQuoted(term)}"`;
  }
  return term;
}

function escapeQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
