// Text/vision provider table + a fallback chain with a correct circuit breaker.
import { fetchJson } from "../net/safeFetch.js";
import { AppError, isCode } from "../infra/errors.js";
import { Breaker } from "../infra/limiter.js";
import { fitPrompt } from "./text.js";

const CEDDS = "https://ceddsrestapi.vercel.app";
const REPLY_KEYS = ["result", "reply", "answer", "response", "message"];

function pick(data, keys = REPLY_KEYS) {
  for (const k of keys) {
    const v = data?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  if (data?.data && typeof data.data === "object") return pick(data.data, keys);
  if (typeof data?.data === "string" && data.data.trim()) return data.data.trim();
  return null;
}

// provider = { name, display, maxPrompt, timeoutMs, buildRequest(prompt, {image}), parse(json) }
function cedds(name, display, path, bodyKey, extra = {}, imgKey = null, imgParse = null) {
  return {
    name,
    display,
    maxPrompt: 8000,
    timeoutMs: 45_000,
    imgKey,
    buildRequest(prompt, { image } = {}) {
      const body = { ...extra, [bodyKey]: prompt };
      if (image && imgKey) body[imgKey] = image;
      return { url: CEDDS + path, method: "POST", body };
    },
    parse: (json) => pick(json),
  };
}

export const TEXT_PROVIDERS = [
  cedds("overchat-claude", "Claude 🧠", "/ai/overchat-claude", "message"),
  cedds("overchat-deepseek", "DeepSeek 🔵", "/ai/overchat-deepseek", "message"),
  cedds("overchat-qwen", "Qwen 🟠", "/ai/overchat-qwen", "message"),
  cedds("overchat", "GPT-4o 🟢", "/ai/overchat", "message"),
  cedds("aichatting", "GPT-4o Mini ⚡", "/ai/aichatting", "message", { model: "gpt-4o-mini" }),
  cedds("chatgpt", "ChatGPT 🤖", "/ai/chatgpt", "prompt", { model: "chatgpt4" }),
  cedds("deepai", "DeepAI 🔷", "/ai/deepai", "message", { model: "deepseek-v3.2" }),
  cedds("goody", "Goody ✨", "/ai/goody", "question"),
];
export const IMAGE_PROVIDERS = [
  cedds("chipp", "Chipp", "/ai/chipp", "message", {}, "url"),
  cedds("deepchat", "DeepChat", "/ai/deepchat", "text", {}, "image_url"),
];

// Every alias must resolve to a real provider name (asserted in tests).
export const MODEL_ALIASES = {
  claude: "overchat-claude",
  كلود: "overchat-claude",
  deepseek: "overchat-deepseek",
  ديبسيك: "overchat-deepseek",
  qwen: "overchat-qwen",
  كوين: "overchat-qwen",
  gpt: "overchat",
  gpt4o: "overchat",
  "gpt-4o": "overchat",
  جيبيتي: "overchat",
  mini: "aichatting",
  "gpt-4o-mini": "aichatting",
  chatgpt: "chatgpt",
  deepai: "deepai",
  goody: "goody",
};
export function resolveModel(alias) {
  const a = String(alias || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(MODEL_ALIASES, a) ? MODEL_ALIASES[a] : null;
}
// "name -> first alias" for the `models` listing.
export function modelListing(current) {
  const firstAlias = new Map();
  for (const [alias, name] of Object.entries(MODEL_ALIASES)) if (!firstAlias.has(name)) firstAlias.set(name, alias);
  return TEXT_PROVIDERS.map((p) => `${current === p.name ? "✅" : "•"} ${p.display}  →  gptx set ${firstAlias.get(p.name) ?? p.name}`);
}

export function orderProviders(providers, preferred) {
  const first = providers.find((p) => p.name === preferred);
  return first ? [first, ...providers.filter((p) => p !== first)] : providers;
}

// Only rate limiting, server errors, timeouts and network failures count against a provider.
export function classifyError(e) {
  const status = Number(e?.status || 0);
  if (status === 413 || status === 414) return { tooLong: true, trips: false };
  if (status === 429 || status >= 500) return { tooLong: false, trips: true };
  if (isCode(e, "timeout")) return { tooLong: false, trips: true };
  if (e instanceof AppError) return { tooLong: false, trips: false };
  return { tooLong: false, trips: true }; // raw fetch/network failure
}

export const textBreaker = new Breaker({ failures: 3, openMs: 5 * 60_000 });

async function callOne(p, prompt, image, fj) {
  const { url, method, body } = p.buildRequest(prompt, { image });
  const json = await fj(url, { method, body, timeoutMs: p.timeoutMs, maxBytes: 2 * 1024 * 1024 });
  const text = p.parse(json);
  if (!text) throw new AppError("upstream", "empty_response");
  return text;
}

// Tries providers in order. On 413/414 the prompt is halved and retried once.
export async function runChain(providers, prompt, { image = null, breaker = textBreaker, fj = fetchJson } = {}) {
  const errors = [];
  const live = providers.filter((p) => !breaker.isOpen(p.name));
  for (const p of live.length ? live : providers) {
    let cur = fitPrompt(prompt, p.maxPrompt);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await callOne(p, cur, image, fj);
        breaker.ok(p.name);
        return { text, provider: p.name };
      } catch (e) {
        const c = classifyError(e);
        if (c.tooLong && attempt === 0) {
          cur = fitPrompt(cur, Math.max(500, Math.floor(cur.length / 2)));
          continue;
        }
        if (c.trips) breaker.fail(p.name);
        errors.push({ name: p.name, status: e?.status, code: e?.code });
        break;
      }
    }
  }
  throw new AppError("upstream", "all_providers_failed", { meta: { errors } });
}
