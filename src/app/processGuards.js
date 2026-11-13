// Process-level crash policy. Pure classification + an installer with injected deps.
const BENIGN_SOCKET_CODES = new Set(["ECONNRESET", "EPIPE"]);

// Only a socket-level write/read failure (has a syscall) is survivable.
// Everything else is a bug in our process state: log it and exit.
export function classifyUncaught(err) {
  const code = err?.code;
  if (BENIGN_SOCKET_CODES.has(code) && (err?.syscall === "write" || err?.syscall === "read")) {
    return "ignore";
  }
  return "fatal";
}

export function describeError(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function installProcessGuards({
  proc = process,
  log = console,
  exit = (c) => process.exit(c),
  onFatal = async () => {},
  now = Date.now,
} = {}) {
  let ignoredLogAt = 0;
  let fatalHandling = false;
  const state = { rejections: 0, ignored: 0 };

  const uncaught = (err, origin = "uncaughtException") => {
    if (classifyUncaught(err) === "ignore") {
      state.ignored++;
      if (now() - ignoredLogAt > 5000) {
        ignoredLogAt = now();
        log.warn(`[${origin}] socket error ignored: ${err.code} (${err.syscall})`);
      }
      return;
    }
    log.error(`[${origin}] FATAL`, describeError(err));
    if (fatalHandling) return exit(1);
    fatalHandling = true;
    // Give cleanup a short window, then exit regardless.
    Promise.resolve()
      .then(() => onFatal(err))
      .catch(() => {})
      .finally(() => exit(1));
  };
  const rejection = (reason) => {
    state.rejections++;
    // Never filtered by message text: every rejection is logged with its stack.
    log.error("[unhandledRejection]", describeError(reason));
  };
  proc.on("uncaughtException", uncaught);
  proc.on("unhandledRejection", rejection);
  return {
    state,
    uninstall() {
      proc.off("uncaughtException", uncaught);
      proc.off("unhandledRejection", rejection);
    },
  };
}
