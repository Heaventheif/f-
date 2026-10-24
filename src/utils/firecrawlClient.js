const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const KEY_ENV_NAMES = ["FIRECRAWL_API", "FIRECRAWL_API_KEYS", "FIRECRAWL_API_KEY", "FIRECRUL_API"];
const FAILOVER_STATUSES = new Set([401, 402, 403, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 60_000;

export class FirecrawlClientError extends Error {
  constructor(message, { code = "FIRECRAWL_ERROR", statusCode = null, keyIndex = null } = {}) {
    super(message);
    this.name = "FirecrawlClientError";
    this.code = code;
    this.statusCode = statusCode;
    this.keyIndex = keyIndex;
  }
}

export function parseFirecrawlKeys(env = process.env) {
  const keys = [];
  const seen = new Set();
  for (const name of KEY_ENV_NAMES) {
    for (const entry of String(env?.[name] ?? "").split(",")) {
      const key = entry.trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

export function createFirecrawlClient({
  getApiKeys = parseFirecrawlKeys,
  fetchImpl = (...args) => globalThis.fetch(...args),
  baseUrl = FIRECRAWL_SCRAPE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let nextKeyIndex = 0;

  async function scrape(url, options = {}) {
    const keys = getApiKeys();
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new FirecrawlClientError("Firecrawl API keys are not configured.", {
        code: "FIRECRAWL_NOT_CONFIGURED",
      });
    }

    const startIndex = nextKeyIndex % keys.length;
    nextKeyIndex = (startIndex + 1) % keys.length;
    let lastError = null;

    for (let offset = 0; offset < keys.length; offset++) {
      const keyIndex = (startIndex + offset) % keys.length;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(baseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${keys[keyIndex]}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url,
            formats: ["html"],
            onlyMainContent: false,
            maxAge: 0,
            timeout: timeoutMs,
            ...options,
          }),
          signal: controller.signal,
        });

        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new FirecrawlClientError("Firecrawl returned an invalid response.", {
            code: "FIRECRAWL_INVALID_RESPONSE",
            statusCode: response.status || null,
            keyIndex,
          });
        }

        if (!response.ok || payload?.success === false) {
          const statusCode = Number(response.status) || Number(payload?.statusCode) || null;
          const failure = new FirecrawlClientError(
            statusCode ? `Firecrawl request failed (HTTP ${statusCode}).` : "Firecrawl request failed.",
            { code: "FIRECRAWL_REQUEST_FAILED", statusCode, keyIndex },
          );
          lastError = failure;
          if (!FAILOVER_STATUSES.has(statusCode) || offset === keys.length - 1) throw failure;
          continue;
        }

        nextKeyIndex = (keyIndex + 1) % keys.length;
        return payload;
      } catch (error) {
        if (error instanceof FirecrawlClientError) {
          lastError = error;
          if (!FAILOVER_STATUSES.has(error.statusCode) || offset === keys.length - 1) throw error;
          continue;
        }
        const timedOut = error?.name === "AbortError" || controller.signal.aborted;
        throw new FirecrawlClientError(
          timedOut ? "Firecrawl request timed out." : "Firecrawl could not be reached.",
          { code: timedOut ? "FIRECRAWL_TIMEOUT" : "FIRECRAWL_NETWORK", keyIndex },
        );
      } finally {
        clearTimeout(timer);
      }
    }

    nextKeyIndex = (startIndex + 1) % keys.length;
    throw lastError || new FirecrawlClientError("Firecrawl request failed.");
  }

  return { scrape };
}

export const firecrawlClient = createFirecrawlClient();
