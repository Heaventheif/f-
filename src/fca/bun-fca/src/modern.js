"use strict";

const { EventEmitter } = require("events");

function promisifyMethod(fn) {
  return function (...args) {
    let options;
    let callback;

    if (typeof args[args.length - 1] === "function") {
      callback = args.pop();
      options = {};
    } else {
      options = { multi: true };
    }
    return new Promise((resolve, reject) => {
      const cb = (err, data) => {
        if (err) {

          if (err instanceof Error) reject(err);
          else {
            const e = new Error(err && err.error ? String(err.error) : JSON.stringify(err));
            e.payload = err;
            reject(e);
          }
          if (callback) return callback(err, data);
          return;
        }
        resolve(data);
        if (callback) return callback(null, data);
      };
      if (options.multi) args.push(cb);
      else args.push(cb);
      try {
        const ret = fn.apply(null, args);

        if (ret && typeof ret.catch === "function") {
          ret.catch((e) => {
            if (!options.multi) cb(e);
          });
        }
      } catch (e) {
        cb(e);
      }
    });
  };
}

function createModernClient(api, opts = {}) {
  const events = new EventEmitter();
  events.setMaxListeners(0);

  const modern = {

    raw: api,

    events,

    get userID() {
      return api.getCurrentUserID ? api.getCurrentUserID() : undefined;
    },

    listen() {
      return startListen();
    },

    stopListen() {
      stopped = true;
      try {
        if (api.mqttClient) api.mqttClient.end(true);
      } catch (_) { }
    },

    webhook: null,
    attachPageWebhook(config) {
      const { attachPageWebhook } = require("./features/webhook");
      this.webhook = attachPageWebhook(api, config, events);
      return this.webhook;
    },
  };

  let listenerStarted = false;
  let stopped = false;

  function startListen() {
    if (listenerStarted || stopped || typeof api.listenMqtt !== "function") return;
    listenerStarted = true;
    const listenEvents = opts.listenEvents !== false;
    try {
      api.listenMqtt((err, event) => {
        if (err) {
          events.emit("error", err);

          if (!stopped) listenerStarted = false;
          return;
        }
        if (!event) return;
        const type = event.type || "event";
        events.emit(type, event);
        if (type !== "message") events.emit("*", event);
      });
    } catch (e) {
      events.emit("error", e);
    }
  }

  const SKIP = new Set([
    "listen", "listenMqtt", "_listenMqttRaw", "on", "once", "off",
    "removeAllListeners", "events", "raw", "stopListen",
    "sendMessageDM", "OldMessage",
  ]);
  for (const key of Object.keys(api)) {
    if (SKIP.has(key)) continue;
    const val = api[key];
    if (typeof val !== "function") continue;
    try {
      modern[key] = promisifyMethod(val);
    } catch (_) {
      modern[key] = val;
    }
  }

  modern.getAppState = api.getAppState.bind(api);
  modern.getCurrentUserID = api.getCurrentUserID;

  if (opts.autoListen !== false) {

    setImmediate(() => startListen());
  }

  return modern;
}

function loginAsync(loginData, options = {}, modernOpts = {}) {
  const { login } = require("../module/login");
  return login(loginData, options).then((api) => createModernClient(api, modernOpts));
}

module.exports = { loginAsync, createModernClient, promisifyMethod };