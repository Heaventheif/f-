// Login supervisor: per-attempt timeout + exponential backoff with jitter.
// After maxAttempts the caller decides (main.js exits so the platform restarts us).
import { AppError } from "../infra/errors.js";

export function backoffDelay(attempt, { baseMs = 2000, capMs = 5 * 60_000, random = Math.random } = {}) {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 16));
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

export function withTimeout(promiseFactory, ms, label = "operation", { setT = setTimeout, clearT = clearTimeout } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setT(() => {
      if (done) return;
      done = true;
      reject(new AppError("timeout", `${label} timed out after ${ms}ms`));
    }, ms);
    timer?.unref?.();
    Promise.resolve()
      .then(promiseFactory)
      .then(
        (v) => {
          if (done) return;
          done = true;
          clearT(timer);
          resolve(v);
        },
        (e) => {
          if (done) return;
          done = true;
          clearT(timer);
          reject(e);
        },
      );
  });
}

export async function superviseLogin({
  attempt: run,
  maxAttempts = 6,
  timeoutMs = 90_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  isFatal = () => false,
  onFail = () => {},
  isStopped = () => false,
  backoff = {},
}) {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    if (isStopped()) throw new AppError("aborted", "login aborted");
    try {
      return await withTimeout(() => run(i), timeoutMs, "login");
    } catch (err) {
      lastErr = err;
      onFail(err, i + 1);
      if (isFatal(err) || i === maxAttempts - 1) break;
      await sleep(backoffDelay(i, backoff));
    }
  }
  throw lastErr;
}
