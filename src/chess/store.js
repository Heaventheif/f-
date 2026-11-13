// Chess game store on state/kv: string ids, version (optimistic concurrency), per-game mutex,
// 24h idle sweep with notification.
import { randomUUID } from "node:crypto";
import { KeyedMutex } from "../infra/limiter.js";
import { AppError } from "../infra/errors.js";
import { getStore } from "../state/kv.js";

export const IDLE_MS = 24 * 3600e3;
export const FINISHED_KEEP_MS = 2 * 3600e3;

export function createChessStore({ ns, now = Date.now, idleMs = IDLE_MS } = {}) {
  const locks = new KeyedMutex();
  const space = async () => (typeof ns === "function" ? ns() : ns);
  return {
    // Serialise work on one game (engine call + persist).
    withLock: (id, fn) => locks.run(String(id), fn),
    async create(game) {
      const id = `${String(game.threadID)}_${randomUUID()}`;
      const doc = { ...game, id, threadID: String(game.threadID), player_white: String(game.player_white), player_black: String(game.player_black), current_turn: String(game.current_turn), status: "active", version: 1, createdAt: now(), updatedAt: now() };
      await (await space()).set(id, doc);
      return doc;
    },
    async get(id) { return (await space()).get(String(id)); },
    async findActive(threadID, playerId) {
      const [t, p] = [String(threadID), String(playerId)];
      for (const [, g] of await (await space()).list()) {
        if (g.status === "active" && g.threadID === t && (g.player_white === p || g.player_black === p)) return g;
      }
      return null;
    },
    // update(id, expectedVersion, patch) -> new doc; throws AppError("conflict") on stale version.
    async update(id, expectedVersion, patch) {
      return (await space()).update(String(id), (cur) => {
        if (!cur) throw new AppError("not_found", "game_missing");
        if (cur.version !== expectedVersion) throw new AppError("conflict", "stale_version");
        return { ...cur, ...patch, id: cur.id, version: cur.version + 1, updatedAt: now() };
      });
    },
    // Ends idle active games (notify(game)) and drops finished ones after a short retention.
    async sweep(notify) {
      const n = await space();
      const t = now();
      let ended = 0;
      for (const [id, g] of await n.list()) {
        if (g.status === "active" && t - g.updatedAt > idleMs) {
          await n.del(id);
          ended++;
          try { await notify?.(g); } catch { /* best effort */ }
        } else if (g.status !== "active" && t - g.updatedAt > FINISHED_KEEP_MS) await n.del(id);
      }
      return ended;
    },
  };
}
let _store;
export const chessStore = () => (_store ??= createChessStore({ ns: async () => (await getStore()).ns("chess_games") }));
