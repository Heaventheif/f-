"use strict";

const mqtt = require("mqtt");

const WebSocket = require("ws");

const HttpsProxyAgent = (() => {
  try {
    return require("https-proxy-agent").HttpsProxyAgent;
  } catch (_) {
    return function NotInstalled() {
      logger(
        "proxy set but `https-proxy-agent` is not installed — MQTT proxy disabled. Install it with: npm i https-proxy-agent",
        "warn"
      );
      return undefined;
    };
  }
})();
const EventEmitter = require("events");
const logger = require("../../../func/logger");
const { parseAndCheckLogin } = require("../../utils/client");
const { buildProxy, buildStream } = require("./detail/buildStream");
const { topics } = require("./detail/constants");
const createParseDelta = require("./core/parseDelta");
const createListenMqtt = require("./core/connectMqtt");
const createGetSeqID = require("./core/getSeqID");
const getTaskResponseData = require("./core/getTaskResponseData");
const createEmitAuth = require("./core/emitAuth");
const createMiddlewareSystem = require("./middleware");

const CYCLE_MS_DEFAULT = 6 * 60 * 60 * 1000;
const RECONNECT_DELAY_MS_DEFAULT = 8000;
const UNSUB_ALL_TIMEOUT_MS = 5000;
const MAX_MQTT_RECONNECT_DELAY_MS = 60000;
const MAX_MQTT_RECONNECT_COOLDOWN_MS = 15 * 60 * 1000  ;
const MAX_MQTT_RECONNECT_ATTEMPTS = 10;
const HEARTBEAT_INTERVAL_MS = 45000
const HEARTBEAT_TIMEOUT_MS = 15000

const parseDelta = createParseDelta({ parseAndCheckLogin });
const emitAuth = createEmitAuth({ logger });
const listenMqtt = createListenMqtt({
    WebSocket,
    mqtt,
    HttpsProxyAgent,
    buildProxy,
    buildStream,
    topics,
    parseDelta,
    getTaskResponseData,
    logger,
    emitAuth
});
const getSeqIDFactory = createGetSeqID({ parseAndCheckLogin, listenMqtt, logger, emitAuth });

const MQTT_DEFAULTS = {
    cycleMs: CYCLE_MS_DEFAULT,
    reconnectDelayMs: RECONNECT_DELAY_MS_DEFAULT,
    autoReconnect: true,
    reconnectAfterStop: false,
    maxReconnectAttempts: MAX_MQTT_RECONNECT_ATTEMPTS,
    heartbeatInterval: HEARTBEAT_INTERVAL_MS,
    heartbeatTimeout: HEARTBEAT_TIMEOUT_MS
};

function mqttConf(ctx, overrides) {
    ctx._mqttOpt = Object.assign({}, MQTT_DEFAULTS, ctx._mqttOpt || {}, overrides || {});
    if (typeof ctx._mqttOpt.autoReconnect === "boolean") {
        ctx.globalOptions.autoReconnect = ctx._mqttOpt.autoReconnect;
    }
    return ctx._mqttOpt;
}

module.exports = function (defaultFuncs, api, ctx, opts) {
    const identity = function () { };
    let globalCallback = identity;
    let heartbeatTimer = null;
    let lastPongTime = Date.now();

    if (!ctx._middleware) {
        ctx._middleware = createMiddlewareSystem();
    }
    const middleware = ctx._middleware;

    function installPostGuard() {
        if (ctx._postGuarded) return defaultFuncs.post;
        const rawPost = defaultFuncs.post && defaultFuncs.post.bind(defaultFuncs);
        if (!rawPost) return defaultFuncs.post;

        function postSafe(...args) {
            return rawPost(...args).catch(err => {
                const msg = (err && err.error) || (err && err.message) || String(err || "");

                if (/blocked the login|Checkpoint/i.test(msg)) {
                    emitAuth(
                        ctx,
                        api,
                        globalCallback,
                        /blocked|checkpoint/i.test(msg) ? "login_blocked" : "auth_error",
                        msg
                    );
                }
                throw err;
            });
        }
        defaultFuncs.post = postSafe;
        ctx._postGuarded = true;
        return postSafe;
    }

    let conf = mqttConf(ctx, opts);
    let reconnectAttempts = 0;
    let isReconnecting = false;

    function getReconnectDelay() {

        const immediate = process.env.FCA_NX_MQTT_IMMEDIATE_RECONNECT === "1";
        if (immediate) {
            if (reconnectAttempts <= 1) return 0;
            const fast = Math.min(1000 * Math.pow(2, reconnectAttempts - 2), MAX_MQTT_RECONNECT_DELAY_MS);
            const j = Math.floor(Math.random() * Math.min(500, fast * 0.2));
            return Math.min(fast + j, MAX_MQTT_RECONNECT_DELAY_MS);
        }
        const base = conf.reconnectDelayMs || RECONNECT_DELAY_MS_DEFAULT;
        const exp = Math.min(base * Math.pow(2, reconnectAttempts), MAX_MQTT_RECONNECT_DELAY_MS);

        const jitter = Math.floor(Math.random() * Math.min(4000, exp * 0.4));
        return Math.min(exp + jitter, MAX_MQTT_RECONNECT_DELAY_MS);
    }

    function getSeqIDWrapper() {
        if (ctx._ending && !ctx._cycling) {
            logger("mqtt getSeqID skipped - ending", "warn");
            return Promise.resolve();
        }

        if (ctx._getSeqIDInFlight) {
            logger("mqtt getSeqID skipped - already in flight", "warn");
            return ctx._getSeqIDInFlight;
        }

        const form = {
            av: ctx.globalOptions.pageID || ctx.userID,
            fb_dtsg: ctx.fb_dtsg,
            jazoest: ctx.jazoest,
            queries: JSON.stringify({
                o0: {
                    doc_id: "3336396659757871",
                    query_params: {
                        limit: 1,
                        before: null,
                        tags: ["INBOX", "PENDING", "OTHER"],
                        includeDeliveryReceipts: false,
                        includeSeqID: true
                    }
                }
            })
        };

        logger("mqtt getSeqID call", "info");
        const _seqP = Promise.resolve().then(function () {
            return getSeqIDFactory(defaultFuncs, api, ctx, globalCallback, form);
        }).finally(function () { ctx._getSeqIDInFlight = null; });
        ctx._getSeqIDInFlight = _seqP;
        return _seqP
            .then(() => {
                logger("mqtt getSeqID done", "info");
                ctx._cycling = false;
                reconnectAttempts = 0;
                isReconnecting = false;
                startHeartbeat();
            })
            .catch(e => {
                ctx._cycling = false;
                const errMsg = e && e.message ? e.message : String(e || "Unknown error");
                logger(`mqtt getSeqID error: ${errMsg}`, "error");

                if (ctx._ending) return;

                if (ctx.globalOptions.autoReconnect !== false) {
                    reconnectAttempts++;
                    const maxAttempts = conf.maxReconnectAttempts || MAX_MQTT_RECONNECT_ATTEMPTS;

                    if (reconnectAttempts > maxAttempts) {
                        const cooldownMs = MAX_MQTT_RECONNECT_COOLDOWN_MS;
                        logger(`mqtt getSeqID: max reconnect attempts exceeded, backing off ${Math.round(cooldownMs / 60000)}min before trying again (not giving up)`, "error");
                        globalCallback({ type: "stop_listen", error: "Max reconnect attempts exceeded - will retry after cooldown" }, null);
                        reconnectAttempts = 0;
                        ctx._reconnectTimer = setTimeout(() => {
                            if (!ctx._ending) {
                                isReconnecting = false;
                                getSeqIDWrapper();
                            }
                        }, cooldownMs);
                        return;
                    }

                    const delay = getReconnectDelay();
                    logger(`mqtt getSeqID will retry in ${delay}ms (attempt ${reconnectAttempts}/${maxAttempts})`, "warn");

                    if (ctx._reconnectTimer) {
                        clearTimeout(ctx._reconnectTimer);
                        ctx._reconnectTimer = null;
                    }

                    ctx._reconnectTimer = setTimeout(() => {
                        if (!ctx._ending) {
                            isReconnecting = false;
                            getSeqIDWrapper();
                        }
                    }, delay);
                }
            });
    }

    function isConnected() {
        return !!(ctx.mqttClient && ctx.mqttClient.connected);
    }

    function startHeartbeat() {
        stopHeartbeat();
        if (!isConnected()) return;

        lastPongTime = Date.now();

        const hbBase = conf.heartbeatInterval || HEARTBEAT_INTERVAL_MS;
        const hbEvery = hbBase + Math.floor(Math.random() * Math.min(8000, hbBase * 0.25));
        let missedPongs = 0;
        heartbeatTimer = setInterval(() => {
            if (!isConnected()) {
                stopHeartbeat();
                return;
            }

            const now = Date.now();
            const limit = (conf.heartbeatTimeout || HEARTBEAT_TIMEOUT_MS) * 5;
            if (now - lastPongTime > limit) {
                missedPongs += 1;

                if (missedPongs >= 2) {
                    logger("mqtt heartbeat: no response x2, forcing reconnect", "warn");
                    missedPongs = 0;
                    forceCycle();
                    return;
                }
                logger("mqtt heartbeat: pong late, waiting one more cycle", "warn");
            } else {
                missedPongs = 0;
            }

            if (process.env.FCA_NX_MQTT_APP_PING === "1") {
                try {
                    ctx.mqttClient.publish("/ping", JSON.stringify({ timestamp: Date.now() }), { qos: 0 });
                    logger("mqtt heartbeat sent", "debug");
                } catch (err) {
                    logger(`mqtt heartbeat error: ${err.message}`, "warn");
                }
            }
        }, hbEvery);
    }

    function stopHeartbeat() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    function unsubAll(cb) {
        if (!isConnected()) {
            if (cb) setTimeout(cb, 0);
            return;
        }

        let pending = topics.length;
        if (!pending) {
            if (cb) setTimeout(cb, 0);
            return;
        }

        let fired = false;
        const timeout = setTimeout(() => {
            if (!fired) {
                fired = true;
                logger("unsubAll timeout, proceeding anyway", "warn");
                if (cb) cb();
            }
        }, UNSUB_ALL_TIMEOUT_MS);

        topics.forEach(t => {
            try {
                ctx.mqttClient.unsubscribe(t, () => {
                    if (--pending === 0 && !fired) {
                        clearTimeout(timeout);
                        fired = true;
                        if (cb) cb();
                    }
                });
            } catch (err) {
                logger(`unsubAll error for topic ${t}: ${err && err.message ? err.message : String(err)}`, "warn");
                if (--pending === 0 && !fired) {
                    clearTimeout(timeout);
                    fired = true;
                    if (cb) cb();
                }
            }
        });
    }

    function endQuietly(next) {
        stopHeartbeat();

        const finish = () => {
            try {
                if (ctx.mqttClient) {
                    ctx.mqttClient.removeAllListeners();
                }
            } catch (_) { }

            ctx.mqttClient = undefined;
            ctx.lastSeqId = null;
            ctx.syncToken = undefined;
            ctx.t_mqttCalled = false;
            ctx._ending = false;
            ctx._cycling = false;

            if (ctx._reconnectTimer) {
                clearTimeout(ctx._reconnectTimer);
                ctx._reconnectTimer = null;
            }
            if (ctx._rTimeout) {
                clearTimeout(ctx._rTimeout);
                ctx._rTimeout = null;
            }

            if (ctx.tasks && ctx.tasks instanceof Map) {
                ctx.tasks.clear();
            }

            if (ctx._userInfoIntervals && Array.isArray(ctx._userInfoIntervals)) {
                ctx._userInfoIntervals.forEach(interval => {
                    try { clearInterval(interval); } catch (_) { }
                });
                ctx._userInfoIntervals = [];
            }

            if (ctx._autoSaveInterval && Array.isArray(ctx._autoSaveInterval)) {
                ctx._autoSaveInterval.forEach(interval => {
                    try { clearInterval(interval); } catch (_) { }
                });
                ctx._autoSaveInterval = [];
            }

            if (ctx._scheduler && typeof ctx._scheduler.destroy === "function") {
                try { ctx._scheduler.destroy(); } catch (_) { }
                ctx._scheduler = undefined;
            }

            reconnectAttempts = 0;
            isReconnecting = false;

            if (next) next();
        };

        try {
            if (ctx.mqttClient) {
                if (isConnected()) {
                    try {
                        ctx.mqttClient.publish("/browser_close", "{}", { qos: 0 });
                    } catch (_) { }
                }
                ctx.mqttClient.end(true, finish);
            } else {
                finish();
            }
        } catch (_) {
            finish();
        }
    }

    function delayedReconnect() {
        if (ctx._ending) return;

        if (ctx._reconnectTimer) {
            logger("mqtt reconnect already scheduled - debounce", "warn");
            return;
        }
        let d = getReconnectDelay();

        const nowTs = Date.now();
        ctx._reconnectStamps = (ctx._reconnectStamps || []).filter(t => nowTs - t < 10 * 60 * 1000);
        ctx._reconnectStamps.push(nowTs);
        if (ctx._reconnectStamps.length > 4) {
            d = Math.max(d, 10 * 60 * 1000);
            logger(`mqtt reconnect flapping (${ctx._reconnectStamps.length} in 10min) - cooling down ${Math.round(d / 60000)}min`, "error");
            ctx._reconnectStamps = [];
        }

        if (d > 0) d += Math.floor(Math.random() * 1500);
        logger(d === 0 ? "mqtt reconnecting immediately" : `mqtt reconnect in ${d}ms`, "info");

        ctx._reconnectTimer = setTimeout(() => {
            ctx._reconnectTimer = null;
            if (!ctx._ending) {
                isReconnecting = false;
                getSeqIDWrapper();
            }
        }, d);
    }

    function forceCycle()   {
        if (ctx._cycling) {
            logger("mqtt force cycle already in progress", "warn");
            return;
        }
        if (ctx._ending) {
            logger("mqtt force cycle skipped - ending", "warn");
            return;
        }

        const now = Date.now();
        if (ctx._lastForceCycleAt && (now - ctx._lastForceCycleAt) < 90000) {
            logger("mqtt force cycle skipped - too soon since last cycle", "warn");
            return;
        }
        ctx._lastForceCycleAt = now;

        ctx._cycling = true;
        ctx._ending = true;
        logger("mqtt force cycle begin", "warn");

        stopHeartbeat();

        const finish = () => {
            ctx._ending = false;
            ctx._cycling = false;
            if (conf.reconnectAfterStop || conf.autoReconnect !== false) {
                delayedReconnect();
            }
        };

        unsubAll(() => {
            try {
                endQuietly(finish);
            } catch (e) {
                logger(`mqtt force cycle endQuietly error: ${e && e.message ? e.message : e}`, "warn");
                finish();
            }
        });
    }

    function rewrapCallbackIfNeeded() {
        if (!ctx.mqttClient || ctx._ending) return;

        const hasMiddleware = middleware.count > 0;
        const isWrapped = ctx._globalCallbackWrapped || false;

        if (hasMiddleware && !isWrapped) {
            ctx._globalCallbackWrapped = true;
            globalCallback = middleware.wrapCallback(ctx._originalCallback || globalCallback);
            logger("Middleware added - callback re-wrapped", "info");
        } else if (!hasMiddleware && isWrapped) {
            ctx._globalCallbackWrapped = false;
            globalCallback = ctx._originalCallback || globalCallback;
            logger("All middleware removed - callback unwrapped", "info");
        }
    }

    function attachClientListeners() {
        if (!ctx.mqttClient) return;

        ctx.mqttClient.removeAllListeners("packetreceive");
        ctx.mqttClient.removeAllListeners("close");
        ctx.mqttClient.removeAllListeners("error");

        ctx.mqttClient.on("packetreceive", (packet) => {
            lastPongTime = Date.now();
            if (packet && packet.cmd === "pingresp") {
                logger("mqtt pong received", "debug");
            }
        });

        ctx.mqttClient.once("close", () => {
            logger("mqtt connection closed", "warn");
            stopHeartbeat();
            if (!ctx._ending && ctx.globalOptions.autoReconnect !== false) {
                if (!isReconnecting) {
                    isReconnecting = true;
                    delayedReconnect();
                }
            }
        });

        ctx.mqttClient.once("error", (err) => {
            logger(`mqtt error: ${err.message}`, "error");
            if (!ctx._ending && ctx.globalOptions.autoReconnect !== false) {
                if (!isReconnecting) {
                    isReconnecting = true;
                    forceCycle();
                }
            }
        });
    }

    return function (callback) {
        class MessageEmitter extends EventEmitter {
            stopListening(callback2) {
                const cb = callback2 || function () { };
                logger("mqtt stop requested", "info");

                globalCallback = identity;
                ctx._ending = true;
                stopHeartbeat();

                if (ctx._autoCycleTimer) {
                    clearInterval(ctx._autoCycleTimer);
                    ctx._autoCycleTimer = null;
                    logger("mqtt auto-cycle cleared", "info");
                }

                if (ctx._reconnectTimer) {
                    clearTimeout(ctx._reconnectTimer);
                    ctx._reconnectTimer = null;
                }

                unsubAll(() => {
                    endQuietly(() => {
                        logger("mqtt stopped", "info");
                        cb();
                        conf = mqttConf(ctx, conf);
                        if (conf.reconnectAfterStop) {
                            delayedReconnect();
                        }
                    });
                });
            }

            async stopListeningAsync() {
                return new Promise(resolve => {
                    this.stopListening(resolve);
                });
            }
        }

        const msgEmitter = new MessageEmitter();

        ctx._originalCallback = callback || function (error, message) {
            if (error) {
                logger("mqtt emit error", "error");
                return msgEmitter.emit("error", error);
            }
            msgEmitter.emit("message", message);
        };

        if (middleware.count > 0) {
            ctx._globalCallbackWrapped = true;
            globalCallback = middleware.wrapCallback(ctx._originalCallback);
        } else {
            ctx._globalCallbackWrapped = false;
            globalCallback = ctx._originalCallback;
        }

        conf = mqttConf(ctx, conf);

        installPostGuard();

        if (!ctx.firstListen) ctx.lastSeqId = null;
        ctx.syncToken = undefined;
        ctx.t_mqttCalled = false;

        if (ctx._autoCycleTimer) {
            clearInterval(ctx._autoCycleTimer);
            ctx._autoCycleTimer = null;
        }

        if (conf.cycleMs && conf.cycleMs > 0) {

            (function scheduleCycle() {
                const j = conf.cycleMs * (0.85 + Math.random() * 0.3);
                ctx._autoCycleTimer = setTimeout(function () {
                    if (!ctx._ending) forceCycle();
                    if (ctx._autoCycleTimer) scheduleCycle();
                }, j);
            })();
            logger(`mqtt auto-cycle enabled ${conf.cycleMs}ms`, "info");
        } else {
            logger("mqtt auto-cycle disabled", "info");
        }

        if (!ctx.firstListen || !ctx.lastSeqId) {
            getSeqIDWrapper();
        } else {
            logger("mqtt starting listenMqtt", "info");
            listenMqtt(defaultFuncs, api, ctx, globalCallback);
            attachClientListeners();
            startHeartbeat();
        }

        api.stopListening = msgEmitter.stopListening;
        api.stopListeningAsync = msgEmitter.stopListeningAsync;
        api.forceReconnect = forceCycle;
        api.isMqttConnected = isConnected;

        api.useMiddleware = function (middlewareFn, fn) {
            const result = middleware.use(middlewareFn, fn);
            rewrapCallbackIfNeeded();
            return result;
        };

        api.removeMiddleware = function (identifier) {
            const result = middleware.remove(identifier);
            rewrapCallbackIfNeeded();
            return result;
        };

        api.clearMiddleware = function () {
            const result = middleware.clear();
            rewrapCallbackIfNeeded();
            return result;
        };

        api.listMiddleware = function () {
            return middleware.list();
        };

        api.setMiddlewareEnabled = function (name, enabled) {
            const result = middleware.setEnabled(name, enabled);
            rewrapCallbackIfNeeded();
            return result;
        };

        const existingMiddlewareCount = Object.getOwnPropertyDescriptor(api, "middlewareCount");
        if (!existingMiddlewareCount) {
            Object.defineProperty(api, "middlewareCount", {
                configurable: true,
                enumerable: false,
                get: function () {
                    return (ctx._middleware && ctx._middleware.count) || 0;
                }
            });
        } else if (existingMiddlewareCount.configurable) {
            Object.defineProperty(api, "middlewareCount", {
                configurable: true,
                enumerable: existingMiddlewareCount.enumerable,
                get: function () {
                    return (ctx._middleware && ctx._middleware.count) || 0;
                }
            });
        }

        return msgEmitter;
    };
};