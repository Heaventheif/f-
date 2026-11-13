// Small shared helpers for media commands.
import { userMessage } from "../infra/errors.js";

// Promise wrapper over global.safeSend; resolves with the sent info (or null when it failed).
export function sendStatus(api, threadID, text, replyToID) {
  return new Promise((resolve) => {
    try {
      global.safeSend(api, text, threadID, (error, info) => resolve(error ? null : info || null), replyToID);
    } catch { resolve(null); }
  });
}
export const reply = (api, threadID, text, replyToID) =>
  Promise.resolve(global.safeSend(api, text, threadID, null, replyToID)).catch(() => {});
export const unsendQuiet = (api, id) => (id ? Promise.resolve(api.unsendMessage(id)).catch(() => {}) : Promise.resolve());

// Send a payload and wait for completion (rejects on failure).
export function sendPayload(api, threadID, payload, replyToID) {
  return new Promise((resolve, reject) =>
    global.safeSend(api, payload, threadID, (err, info) => (err ? reject(err) : resolve(info)), replyToID));
}
// Arabic message for any error, with command-specific overrides by AppError code.
export function errorText(error, overrides = {}) {
  return overrides[error?.code] || userMessage(error);
}
