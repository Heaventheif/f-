"use strict";

const { formatID } = require("../../../utils/format");
const { getSessionIdentity } = require("../../../utils/clientIdentity");

const DEFAULT_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 60000;
const MAX_RECONNECT_ATTEMPTS = 8
const MAX_RECONNECT_COOLDOWN_MS = 15 * 60 * 1000  ;
const T_MS_WAIT_TIMEOUT_MS = 5000;

function isImmediateReconnect(ctx) {

  if (process.env.FCA_NX_MQTT_IMMEDIATE_RECONNECT === "1") return true;
  if (ctx && ctx._mqttOpt && ctx._mqttOpt.immediateReconnect === true) return true;
  return false;
}

function computeBackoff(ctx, baseMs) {
  const attempt = (ctx._reconnectAttempts || 0);
  if (isImmediateReconnect(ctx)) {
    if (attempt <= 1) return 0;
    const fast = Math.min(1000 * Math.pow(2, attempt - 2), MAX_RECONNECT_DELAY_MS);
    const j = Math.floor(Math.random() * Math.min(500, fast * 0.2));
    return Math.min(fast + j, MAX_RECONNECT_DELAY_MS);
  }
  const exp = Math.min(baseMs * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS);
  const jitter = Math.floor(Math.random() * Math.min(4000, exp * 0.4));
  return Math.min(exp + jitter, MAX_RECONNECT_DELAY_MS);
}

module.exports = function createListenMqtt(deps) {
  const { WebSocket, mqtt, HttpsProxyAgent, buildStream, buildProxy,
    topics, parseDelta, getTaskResponseData, logger, emitAuth
  } = deps;

  return function listenMqtt(defaultFuncs, api, ctx, globalCallback) {

    function scheduleReconnect(delayMs) {
      const base = (ctx._mqttOpt && ctx._mqttOpt.reconnectDelayMs) || DEFAULT_RECONNECT_DELAY_MS;
      if (ctx._reconnectTimer) {
        logger("mqtt reconnect already scheduled", "warn");
        return;
      }
      if (ctx._ending) {

        logger("mqtt reconnect skipped - ending", "warn");
        return;
      }
      ctx._reconnectAttempts = (ctx._reconnectAttempts || 0) + 1;
      if (ctx._reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {

        const cooldownMs = MAX_RECONNECT_COOLDOWN_MS;
        logger(`mqtt reconnect attempts exceeded (${MAX_RECONNECT_ATTEMPTS}); backing off ${Math.round(cooldownMs / 60000)}min before trying again (not giving up)`, "error");
        globalCallback({ type: "stop_listen", error: "Max reconnect attempts exceeded - will retry after cooldown" }, null);
        ctx._reconnectAttempts = 0;
        ctx._reconnectTimer = setTimeout(() => {
          ctx._reconnectTimer = null;
          if (!ctx._ending) {
            listenMqtt(defaultFuncs, api, ctx, globalCallback);
          }
        }, cooldownMs);
        return;
      }
      const ms = typeof delayMs === "number" ? delayMs : computeBackoff(ctx, base);
      logger(`mqtt ${ms === 0 ? "reconnecting immediately" : "will reconnect in " + ms + "ms"} (attempt ${ctx._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, "warn");
      ctx._reconnectTimer = setTimeout(() => {
        ctx._reconnectTimer = null;
        if (!ctx._ending) {
          listenMqtt(defaultFuncs, api, ctx, globalCallback);
        }
      }, ms);
    }
    function isEndingLikeError(msg) {
      return /No subscription existed|client disconnecting|socket hang up|ECONNRESET/i.test(msg || "");
    }

    if (ctx.mqttClient) {
      try {
        ctx.mqttClient.removeAllListeners();
        if (ctx.mqttClient.connected) ctx.mqttClient.end(true);
      } catch (_) { }
      ctx.mqttClient = undefined;
    }

    const identity = getSessionIdentity(ctx);

    if (!ctx.clientId || ctx.clientId === "") {
      ctx.clientId = ctx.clientID || ((""+Math.random()).slice(2) + Date.now()).slice(0, 16);
    }

    const chatOn = ctx.globalOptions.online === true;
    const sessionID = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
    const username = {
      u: ctx.userID, s: sessionID, chat_on: chatOn, fg: false, d: ctx.clientId,
      ct: "websocket", aid: 219994525426954, aids: null, mqtt_sid: "",
      cp: 3, ecp: 10, st: [], pm: [], dc: "", no_auto_fg: true, gas: null, pack: [], p: null, php_override: ""
    };

    const cookies = api.getCookies();
    let host;
    if (ctx.mqttEndpoint) host = `${ctx.mqttEndpoint}&sid=${sessionID}&cid=${ctx.clientId}`;
    else if (ctx.region) host = `wss://edge-chat.facebook.com/chat?region=${ctx.region.toLowerCase()}&sid=${sessionID}&cid=${ctx.clientId}`;
    else host = `wss://edge-chat.facebook.com/chat?sid=${sessionID}&cid=${ctx.clientId}`;

    const options = {
      clientId: "mqttwsclient",
      protocolId: "MQIsdp",
      protocolVersion: 3,
      username: JSON.stringify(username),
      clean: true,
      wsOptions: {
        headers: {
          Cookie: cookies,
          Origin: "https://www.facebook.com",
          "User-Agent": identity.userAgent,
          Referer: "https://www.facebook.com/",
          Host: "edge-chat.facebook.com",
          Connection: "Upgrade",
          Pragma: "no-cache",
          "Cache-Control": "no-cache",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Accept-Encoding": "gzip, deflate, br",

          "Accept-Language": identity.acceptLanguage,
          "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits"
        },
        origin: "https://www.facebook.com",
        protocolVersion: 13,
        binaryType: "arraybuffer"
      },
      keepalive: 30,
      reschedulePings: true,
      reconnectPeriod: 0,
      connectTimeout: 5000
    };
    if (ctx.globalOptions.proxy !== undefined) {
      const agent = new HttpsProxyAgent(ctx.globalOptions.proxy);
      options.wsOptions.agent = agent;
    }

    ctx.mqttClient = new mqtt.Client(
      () => buildStream(options, new WebSocket(host, options.wsOptions), buildProxy()),
      options
    );
    const mqttClient = ctx.mqttClient;

    mqttClient.on("error", function (err) {
      const msg = String(err && err.message ? err.message : err || "");
      if ((ctx._ending || ctx._cycling) && /No subscription existed|client disconnecting/i.test(msg)) {
        logger(`mqtt expected during shutdown: ${msg}`, "info");
        return;
      }

      if (/Invalid header flag bits|must be 0x0 for puback/i.test(msg)) {
        logger(`mqtt puback ignored: ${msg}`, "warn");
        return;
      }

      if (/Not logged in|Not logged in.|blocked the login|401|403/i.test(msg)) {
        try {
          if (mqttClient && mqttClient.connected) {
            mqttClient.end(true);
          }
        } catch (_) { }

        if (/blocked the login/i.test(msg)) {
          return emitAuth(ctx, api, globalCallback, "login_blocked", msg);
        }

        logger(`mqtt transient auth error; refreshing session then reconnecting (no logout): ${msg}`, "warn");
        (async () => {
          try {
            if (api && typeof api.refreshFb_dtsg === "function") {
              await api.refreshFb_dtsg();
            }
          } catch (_) {}
          try {
            const { get } = require("../../../utils/request");
            const { saveCookies } = require("../../../utils/client");
            await get("https://www.facebook.com/", ctx.jar, null, ctx.globalOptions, ctx).then(saveCookies(ctx.jar));
          } catch (_) {}
          if (!ctx._ending && ctx.globalOptions && ctx.globalOptions.autoReconnect !== false) {
            scheduleReconnect();
          }
        })();
        return;
      }
      logger(`mqtt error: ${msg}`, "error");
      try {
        if (mqttClient && mqttClient.connected) {
          mqttClient.end(true);
        }
      } catch (_) { }
      if (ctx._ending || ctx._cycling) return;

      if (ctx.globalOptions && ctx.globalOptions.autoReconnect !== false && !ctx._ending) {

        scheduleReconnect();
      } else {
        globalCallback({ type: "stop_listen", error: msg || "Connection refused" }, null);
      }
    });

    mqttClient.on("connect", function () {
      if (process.env.OnStatus === undefined) {
        logger("fca-unofficial", "info");
        process.env.OnStatus = true;
      }
      ctx._cycling = false;
      ctx.loggedIn = true;
      ctx._sessionRecovering = false;

      ctx._reconnectAttempts = 0;

      topics.forEach(t => mqttClient.subscribe(t));

      const queue = {
        sync_api_version: 11, max_deltas_able_to_process: 100, delta_batch_size: 500,
        encoding: "JSON", entity_fbid: ctx.userID, initial_titan_sequence_id: ctx.lastSeqId, device_params: null
      };
      const topic = ctx.syncToken ? "/messenger_sync_get_diffs" : "/messenger_sync_create_queue";
      if (ctx.syncToken) { queue.last_seq_id = ctx.lastSeqId; queue.sync_token = ctx.syncToken; }
      mqttClient.publish(topic, JSON.stringify(queue), { qos: 1, retain: false });

      mqttClient.publish("/foreground_state", JSON.stringify({ foreground: !!chatOn }), { qos: 1 });
      if (chatOn) {
        mqttClient.publish("/set_client_settings", JSON.stringify({ make_user_available_when_in_foreground: true }), { qos: 1 });
      }
      let rTimeout = setTimeout(function () {
        rTimeout = null;
        if (ctx._ending) {
          logger("mqtt t_ms timeout skipped - ending", "warn");
          return;
        }
        logger("mqtt t_ms timeout, cycling", "warn");
        try {
          if (mqttClient && mqttClient.connected) {
            mqttClient.end(true);
          }
        } catch (_) { }
        scheduleReconnect();
      }, T_MS_WAIT_TIMEOUT_MS);

      ctx._rTimeout = rTimeout;

      ctx.tmsWait = function () {
        if (rTimeout) {
          clearTimeout(rTimeout);
          rTimeout = null;
        }
        if (ctx._rTimeout) {
          delete ctx._rTimeout;
        }
        if (ctx.globalOptions.emitReady) globalCallback({ type: "ready", error: null });
        delete ctx.tmsWait;
      };
    });

    mqttClient.on("message", function (topic, message) {
      if (ctx._ending) return;
      try {
        let jsonMessage = Buffer.isBuffer(message) ? Buffer.from(message).toString() : message;
        try {
          jsonMessage = JSON.parse(jsonMessage);
        } catch (parseErr) {
          logger(`mqtt message parse error for topic ${topic}: ${parseErr && parseErr.message ? parseErr.message : String(parseErr)}`, "warn");
          jsonMessage = {};
        }

        if (jsonMessage.type === "jewel_requests_add") {
          globalCallback(null, { type: "friend_request_received", actorFbId: jsonMessage.from.toString(), timestamp: Date.now().toString() });
        } else if (jsonMessage.type === "jewel_requests_remove_old") {
          globalCallback(null, { type: "friend_request_cancel", actorFbId: jsonMessage.from.toString(), timestamp: Date.now().toString() });
        } else if (topic === "/t_ms") {
          if (ctx.tmsWait && typeof ctx.tmsWait == "function") ctx.tmsWait();
          if (jsonMessage.firstDeltaSeqId && jsonMessage.syncToken) {
            ctx.lastSeqId = jsonMessage.firstDeltaSeqId;
            ctx.syncToken = jsonMessage.syncToken;
          }
          if (jsonMessage.lastIssuedSeqId) ctx.lastSeqId = parseInt(jsonMessage.lastIssuedSeqId);
          for (const dlt of (jsonMessage.deltas || [])) {
            parseDelta(defaultFuncs, api, ctx, globalCallback, { delta: dlt });
          }
        } else if (topic === "/thread_typing" || topic === "/orca_typing_notifications") {
          const typ = {
            type: "typ",
            isTyping: !!jsonMessage.state,
            from: jsonMessage.sender_fbid.toString(),
            threadID: formatID((jsonMessage.thread || jsonMessage.sender_fbid).toString())
          };
          globalCallback(null, typ);
        } else if (topic === "/orca_presence") {
          if (!ctx.globalOptions.updatePresence) {
            for (const data of (jsonMessage.list || [])) {
              const presence = { type: "presence", userID: String(data.u), timestamp: data.l * 1000, statuses: data.p };
              globalCallback(null, presence);
            }
          }
        } else if (topic === "/ls_resp") {
          const parsedPayload = JSON.parse(jsonMessage.payload);
          const reqID = jsonMessage.request_id;
          const tasks = ctx.tasks;
          if (tasks && tasks instanceof Map && tasks.has(reqID)) {
            const taskData = tasks.get(reqID);
            const { type: taskType, callback: taskCallback } = taskData;
            const taskRespData = getTaskResponseData(taskType, parsedPayload);
            if (taskRespData == null) taskCallback("error", null);
            else taskCallback(null, Object.assign({ type: taskType, reqID }, taskRespData));
          }
        }
      } catch (ex) {
        const errMsg = ex && ex.message ? ex.message : String(ex || "Unknown error");
        logger(`mqtt message handler error: ${errMsg}`, "error");

      }
    });

    mqttClient.on("close", function () {
      if (ctx._ending || ctx._cycling) {
        logger("mqtt close expected", "info");
        return;
      }
      logger("mqtt connection closed", "warn");
      if (ctx.globalOptions && ctx.globalOptions.autoReconnect !== false && !ctx._ending) {
        scheduleReconnect();
      }
    });

    mqttClient.on("disconnect", () => {
      if (ctx._ending || ctx._cycling) {
        logger("mqtt disconnect expected", "info");
        return;
      }
      logger("mqtt disconnected", "warn");
      if (ctx.globalOptions && ctx.globalOptions.autoReconnect !== false && !ctx._ending) {
        scheduleReconnect();
      }
    });
  };
};