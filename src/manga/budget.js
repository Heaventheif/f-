// Per-user daily budget for paid scrapes (Firecrawl). Backed by state/kv (atomic update).
import { AppError } from "../infra/errors.js";

export const DAILY_LIMIT = Math.max(1, Number(process.env.MANGALIK_DAILY_LIMIT) || 12);
const dayKey = (uid, now) => `${String(uid)}:${new Date(now).toISOString().slice(0, 10)}`;

// ns: kv namespace (get/update). Throws AppError("rate_limited") once the limit is used up.
export function createBudget({ ns, limit = DAILY_LIMIT, now = Date.now } = {}) {
  const fallback = new Map(); // used only if the store itself is unavailable
  return {
    async take(uid) {
      const key = dayKey(uid, now());
      try {
        await ns().update(key, (n) => {
          if ((n || 0) >= limit) throw new AppError("rate_limited", "daily_budget", { meta: { limit } });
          return (n || 0) + 1;
        }, 0);
      } catch (e) {
        if (e instanceof AppError && e.code === "rate_limited") throw e;
        const n = (fallback.get(key) || 0) + 1;
        if (n > limit) throw new AppError("rate_limited", "daily_budget", { meta: { limit } });
        fallback.set(key, n);
        if (fallback.size > 2000) fallback.delete(fallback.keys().next().value);
      }
    },
  };
}
