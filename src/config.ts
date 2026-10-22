export interface Config {
  apiKey: string | undefined;
  baseUrl: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.DEEPSEEK_API_KEY?.trim() || undefined;
  const rawBaseUrl = env.DEEPSEEK_BASE_URL?.trim();

  return {
    apiKey,
    baseUrl: rawBaseUrl ? normalizeBaseUrl(rawBaseUrl) : DEFAULT_BASE_URL,
  };
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("DEEPSEEK_BASE_URL must be a valid absolute URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("DEEPSEEK_BASE_URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new ConfigError("DEEPSEEK_BASE_URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new ConfigError("DEEPSEEK_BASE_URL must not contain a query string or fragment.");
  }
  if (url.pathname.replace(/\/+$/, "").endsWith("/v1")) {
    throw new ConfigError("DEEPSEEK_BASE_URL must not include /v1; use the service root.");
  }

  return raw.replace(/\/+$/, "");
}
