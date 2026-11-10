const { getType } = require("../src/utils/format");
const { setOptions } = require("./options");
const { loadConfig } = require("./config");
const { checkAndUpdateVersion } = require("../func/checkUpdate");
const loginHelper = require("./loginHelper");
const logger = require("../func/logger");
const { DEFAULT_IDENTITY } = require("../src/utils/clientIdentity");

const { config } = loadConfig();
global.fca = { config };

if (!global.fca._errorHandlersInstalled) {
  global.fca._errorHandlersInstalled = true;

  process.on("unhandledRejection", (reason, promise) => {
    try {

      if (reason && typeof reason === "object") {
        const errorCode = reason.code || reason.cause?.code;
        const errorMessage = reason.message || String(reason);

        if (errorMessage.includes("No Sequelize instance passed")) {
          return;
        }

        if (errorCode === "UND_ERR_CONNECT_TIMEOUT" ||
            errorCode === "ETIMEDOUT" ||
            errorMessage.includes("Connect Timeout") ||
            errorMessage.includes("fetch failed")) {
          logger(`Network timeout error caught (non-fatal): ${errorMessage}`, "warn");
          return;
        }

        if (errorCode === "ECONNREFUSED" ||
            errorCode === "ENOTFOUND" ||
            errorCode === "ECONNRESET" ||
            errorMessage.includes("ECONNREFUSED") ||
            errorMessage.includes("ENOTFOUND")) {
          logger(`Network connection error caught (non-fatal): ${errorMessage}`, "warn");
          return;
        }
      }

      const errorDetail = reason && reason.stack ? reason.stack : (reason && reason.message ? reason.message : String(reason));
      logger(`Unhandled promise rejection (non-fatal): ${errorDetail}`, "error");
    } catch (e) {

      try { console.error("[bun-fca] logger failed while handling unhandledRejection:", e, reason); } catch { }
    }
  });

  process.on("uncaughtException", (error) => {
    try {
      const errorMessage = error.message || String(error);
      const errorCode = error.code;

      if (errorMessage.includes("No Sequelize instance passed")) {
        return;
      }

      if (errorCode === "UND_ERR_CONNECT_TIMEOUT" ||
          errorCode === "ETIMEDOUT" ||
          errorMessage.includes("Connect Timeout") ||
          errorMessage.includes("fetch failed")) {
        logger(`Uncaught network timeout error (non-fatal): ${errorMessage}`, "warn");
        return;
      }

      logger(`Uncaught exception (attempting to continue): ${error && error.stack ? error.stack : errorMessage}`, "error");

    } catch (e) {

      try { console.error("[bun-fca] logger failed while handling uncaughtException:", e, error); } catch { }
    }
  });
}

if (!global.fca._activeLogins) global.fca._activeLogins = new Set();

function extractLoginKey(loginData) {
  if (!loginData) return null;
  if (loginData.email) return `email:${String(loginData.email).toLowerCase()}`;
  const findUid = (str) => {
    const m = String(str || "").match(/(?:c_user|i_user)=(\d+)/);
    return m ? m[1] : null;
  };
  if (Array.isArray(loginData.appState)) {
    const c = loginData.appState.find(c => c && (c.key === "c_user" || c.key === "i_user" || c.name === "c_user" || c.name === "i_user"));
    if (c) return `uid:${c.value}`;
  } else if (typeof loginData.appState === "string") {
    const uid = findUid(loginData.appState);
    if (uid) return `uid:${uid}`;
  }
  if (loginData.Cookie) {
    const uid = findUid(loginData.Cookie);
    if (uid) return `uid:${uid}`;
  }
  return null;
}

function login(loginData, options, callback) {
  if (getType(options) === "Function" || getType(options) === "AsyncFunction") {
    callback = options;
    options = {};
  }
  const globalOptions = {
    selfListen: false,
    selfListenEvent: false,
    listenEvents: false,
    listenTyping: false,
    updatePresence: false,
    forceLogin: false,
    autoMarkRead: false,
    autoReconnect: true,
    online: false,
    emitReady: false,

    userAgent: DEFAULT_IDENTITY.userAgent
  };
  setOptions(globalOptions, options);
  let prCallback = null;
  let rejectFunc = null;
  let resolveFunc = null;
  let returnPromise = null;
  if (getType(callback) !== "Function" && getType(callback) !== "AsyncFunction") {
    returnPromise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    prCallback = function (error, api) {
      if (error) return rejectFunc(error);
      return resolveFunc(api);
    };
    callback = prCallback;
  }
  const loginKey = extractLoginKey(loginData);
  if (loginKey && global.fca._activeLogins.has(loginKey)) {
    const err = new Error("A login attempt for this account is already in progress.");
    err.error = "login_in_progress";
    callback(err);
    return returnPromise;
  }
  if (loginKey) global.fca._activeLogins.add(loginKey);
  const releaseLoginKey = () => { if (loginKey) global.fca._activeLogins.delete(loginKey); };
  const wrappedCallback = (error, api) => {
    releaseLoginKey();
    callback(error, api);
  };

  const proceed = () => loginHelper(loginData.appState, loginData.Cookie, loginData.email, loginData.password, globalOptions, wrappedCallback, prCallback);
  if (config && (config.autoUpdateCheck || config.autoUpdate)) {
    const p = checkAndUpdateVersion();
    if (p && typeof p.then === "function") {
      p.then(proceed).catch(err => { releaseLoginKey(); callback(err); });
    } else {
      proceed();
    }
  } else {
    proceed();
  }
  return returnPromise;
}

module.exports = login;