// Per-thread conversation state: load -> call -> SAVE happen under one lock,
// so concurrent messages in a thread can never overwrite each other.
import { KeyedMutex, RateLimiter } from "../infra/limiter.js";
import { loadCtx, saveCtx, clearCtx, trimByChars } from "../utils/sharedSession.js";

const locks = new KeyedMutex();
export const MAX_TURNS = 8;

// Pure: append a user/assistant pair and trim by turns and chars.
export function nextHistory(history, userTurn, reply, maxTurns = MAX_TURNS) {
  const h = [...(Array.isArray(history) ? history : []), userTurn, { role: "assistant", content: reply }];
  return trimByChars(h.slice(-maxTurns * 2));
}

// `call(history)` must return the reply text or throw (nothing is stored on throw,
// so error strings can never enter the history).
export function converse(collection, threadID, userTurn, call) {
  return locks.run(`${collection}:${threadID}`, async () => {
    const history = trimByChars(await loadCtx(collection, threadID));
    const reply = await call(history);
    await saveCtx(collection, threadID, nextHistory(history, userTurn, reply));
    return reply;
  });
}
export function readHistory(collection, threadID) {
  return locks.run(`${collection}:${threadID}`, async () => trimByChars(await loadCtx(collection, threadID)));
}
export function resetThread(collection, threadID) {
  return locks.run(`${collection}:${threadID}`, () => clearCtx(collection, threadID));
}

// Auto-reply cooldown: at most 1 reply per thread per window.
const cooldown = new RateLimiter({ max: 1, windowMs: 6000 });
export const autoReplyAllowed = (threadID) => cooldown.allow(String(threadID)).ok;

// Reply chains: each hop carries a depth; stop after MAX_CHAIN.
export const MAX_CHAIN = 8;
export const chainAllowed = (depth) => depth < MAX_CHAIN;

export function isBotSender(api, event) {
  let me = "";
  try {
    me = String(api?.getCurrentUserID?.() ?? "");
  } catch {}
  return !!me && String(event?.senderID ?? "") === me;
}
