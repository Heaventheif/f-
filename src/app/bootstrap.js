// Must be the FIRST import of main.js: ES imports are hoisted, so anything that
// has to exist before other modules evaluate (TZ, globals) lives here.
process.env.TZ = "Europe/Berlin";

const reactionTimestamps = new Map();
const reactionListener = new Proxy(
  {},
  {
    set(target, prop, value) {
      reactionTimestamps.set(prop, Date.now());
      target[prop] = value;
      return true;
    },
    deleteProperty(target, prop) {
      reactionTimestamps.delete(prop);
      delete target[prop];
      return true;
    },
  },
);

const perfManager = {
  _times: [],
  _errors: 0,
  trackRequest(t0) {
    this._times.push(Date.now() - t0);
    if (this._times.length > 100) this._times.shift();
  },
  trackError() {
    this._errors++;
  },
  getMetrics() {
    const n = this._times.length;
    return {
      avgResponseTimeMs: n ? Math.round(this._times.reduce((a, b) => a + b, 0) / n) : 0,
      errorCount: this._errors,
    };
  },
};

Object.assign(globalThis, {
  __mainErrorHandlersInstalled: true,
  client: { reactionListener },
  _reactionTimestamps: reactionTimestamps,
  Kagenou: { replies: {} },
  config: {
    admins: [],
    moderators: [],
    developers: [],
    vips: [],
    Prefix: [""],
    botName: "Sunken Bot",
  },
  _botAdminIds: new Map(),
  globalData: new Map(),
  usersData: new Map(),
  userCooldowns: new Map(),
  commands: new Map(),
  eventCommands: [],
  appState: {},
  botApi: null,
  botApis: [],
  scheduler: null,
  perfManager,
  threadsData: new Map(),
  sessionGuard: null,
  db: null,
  log: {
    info: (msg) => console.log("[INFO]", msg),
    warn: (msg) => console.log("[WARN]", msg),
    error: (msg) => console.log("[ERROR]", msg),
    success: (msg) => console.log("[SUCCESS]", msg),
  },
});

import { installUserData } from "./userData.js";
installUserData(globalThis);
