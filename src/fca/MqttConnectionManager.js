import { redactText } from "./runtimeEnv.js";
import { EventEmitter } from "node:events";
const DEFAULTS = {
  // Staleness is measured from the last INBOUND event only (pings are ours, not proof of life).
  staleAfterMs: (Number(process.env.MQTT_STALE_MIN) || 15) * 6e4,
  connectTimeoutMs: 2 * 6e4,
  initialGraceMs: 2 * 6e4,
  watchdogIntervalMs: 3e4,
  stableWindowMs: 5 * 6e4,
  reconnectBaseMs: 2e3,
  reconnectCapMs: 5 * 6e4,
  cooldownMs: 15 * 6e4,
  authBlockCooldownMs: 90 * 6e4,
  maxFastAttempts: 10,
  pingIntervalMs: 12e4,
};
function getErrorText(error) {
  return String(error?.message || error || "unknown error");
}
export function classifyMqttError(error) {
  const text = getErrorText(error).toLowerCase();
  const status = Number(error?.statusCode ?? error?.status ?? error?.code);
  if (/login_blocked/.test(text)) return "AUTH_FAILED";
  if (
    status === 401 ||
    status === 403 ||
    /not logged in|blocked the login|checkpoint|invalid.*session|not.*authenticated|session.*expired|credentials.*invalid/.test(
      text,
    )
  )
    return "AUTH_FAILED";
  if (/rate.?limit|too many requests|\b429\b/.test(text)) return "RATE_LIMITED";
  if (
    /timeout|keep.?alive|socket|econnreset|enetunreach|eai_again|connection refused|closed|disconnect/.test(
      text,
    )
  ) {
    return "TRANSIENT";
  }
  return "UNKNOWN";
}
export function fullJitter(attempt, baseMs, capMs, random = Math.random) {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 12));
  return Math.max(500, Math.floor(random() * Math.max(baseMs, ceiling)));
}
export class MqttConnectionManager extends EventEmitter {
  constructor(api, options = {}) {
    super();
    this.api = api;
    this.label = options.label || "MQTT";
    this.botIndex = options.botIndex ?? null;
    this.options = { ...DEFAULTS, ...options };
    // Injected for tests: clock, timers, randomness.
    this._now = options.now ?? (() => this._now());
    this._setT = options.setTimeout ?? ((...a) => globalThis.setTimeout(...a));
    this._clearT = options.clearTimeout ?? ((...a) => globalThis.clearTimeout(...a));
    this._random = options.random ?? Math.random;
    this.authTimer = null;
    this._authBlockedUntil = null;
    this.handlerErrors = 0;
    this.listener = null;
    this.started = false;
    this.stopped = true;
    this.state = "STOPPED";
    this.reconnectPromise = null;
    this.watchdogTimer = null;
    this.pingTimer = null;
    this.cooldownUntil = 0;
    this.connectedSince = 0;
    this.lastEventAt = 0; // last inbound event only
    this.lastPingAt = 0; // informational, never used for staleness
    this.lastConnectAt = 0;
    this.lastDisconnectAt = null;
    this.lastErrorAt = null;
    this.lastError = null;
    this.lastErrorClass = null;
    this.lastReconnectReason = null;
    this.reconnectAttempts = 0;
    this.totalReconnects = 0;
    this.eventsReceived = 0;
    this.errors = 0;
    this.consecutiveErrors = 0;
    this.lastEventType = null;
    this._onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
    this._onState = typeof options.onState === "function" ? options.onState : null;
  }
  start() {
    if (this.started && !this.stopped) return this;
    this.started = true;
    this.stopped = false;
    this.state = "RECONNECTING";
    this._scheduleWatchdog();
    this._schedulePing();
    void this._connectOnce("startup");
    return this;
  }
  async stop() {
    this.stopped = true;
    this.started = false;
    this.state = "STOPPED";
    this._clearT(this.watchdogTimer);
    this._clearT(this.pingTimer);
    this._clearT(this.authTimer);
    this.watchdogTimer = this.pingTimer = this.authTimer = null;
    this._authBlockedUntil = null;
    await this._stopListener();
    this._emitState();
  }
  reconnect(reason = "manual") {
    if (this.stopped) return Promise.resolve(false);
    if (this.reconnectPromise) return this.reconnectPromise;
    this.lastReconnectReason = reason;
    this.reconnectPromise = this._reconnect(reason)
      .catch((error) => {
        this._recordError(error);
        return false;
      })
      .finally(() => {
        this.reconnectPromise = null;
      });
    return this.reconnectPromise;
  }
  health() {
    const now = this._now();
    const client = this._mqttClient();
    const socketConnected = client?.connected === true;
    const lastInboundAt = this._lastInboundRef();
    const staleForMs = lastInboundAt ? Math.max(0, now - lastInboundAt) : null;
    const stableForMs = this.connectedSince ? Math.max(0, now - this.connectedSince) : 0;
    const healthy =
      !this.stopped &&
      this.state === "CONNECTED" &&
      socketConnected &&
      staleForMs !== null &&
      staleForMs < this.options.staleAfterMs;
    return {
      ok: healthy,
      state: this.state,
      socketConnected,
      staleForMs,
      stableForMs,
      connectedSince: this.connectedSince ? new Date(this.connectedSince).toISOString() : null,
      lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
      lastPingAt: this.lastPingAt ? new Date(this.lastPingAt).toISOString() : null,
      lastConnectAt: this.lastConnectAt ? new Date(this.lastConnectAt).toISOString() : null,
      lastDisconnectAt: this.lastDisconnectAt
        ? new Date(this.lastDisconnectAt).toISOString()
        : null,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
      lastErrorClass: this.lastErrorClass,
      lastError: this.lastError,
      lastReconnectReason: this.lastReconnectReason,
      reconnectAttempts: this.reconnectAttempts,
      totalReconnects: this.totalReconnects,
      consecutiveErrors: this.consecutiveErrors,
      eventsReceived: this.eventsReceived,
      lastEventType: this.lastEventType,
      handlerErrors: this.handlerErrors,
      cooldownUntil: this.cooldownUntil > now ? new Date(this.cooldownUntil).toISOString() : null,
    };
  }
  // Reference point for staleness: last inbound event, or the connect time before the first one.
  _lastInboundRef() {
    return this.lastEventAt || this.connectedSince || 0;
  }
  metrics() {
    return this.health();
  }
  _mqttClient() {
    return (
      this.api?._mqttClient ??
      this.api?._ctx?.mqttClient ??
      this.api?._ctx?.mqtt ??
      this.api?._mqtt ??
      null
    );
  }
  _socketAlive() {
    const client = this._mqttClient();
    return client?.connected === true && client?.disconnecting !== true && client?.closed !== true;
  }
  async _connectOnce(reason) {
    if (this.stopped || this.listener) return true;
    this.state = "RECONNECTING";
    this._emitState();
    try {
      this.listener = this.api.listenMqtt((error, event) => {
        if (error) {
          this._recordError(error);
          void this.reconnect("listener_error");
          return;
        }
        this._recordEvent(event);
        try {
          this._onEvent?.(event);
        } catch (handlerError) {
          // A buggy command handler is not a connection fault: never feeds
          // error counters, state, or the reconnect logic.
          this.handlerErrors++;
          this.emit("handler_error", { message: getErrorText(handlerError) });
        }
      });
      this.connectedSince = this._now();
      this.lastConnectAt = this.connectedSince;
      this.state = "CONNECTING";
      this.consecutiveErrors = 0;
      this._emitState();
      this.emit("connected", { reason });
      return true;
    } catch (error) {
      this._recordError(error);
      await this._stopListener();
      return false;
    }
  }
  async _reconnect(reason) {
    if (this.stopped) return false;
    const kind = this.lastErrorClass;
    if (kind === "AUTH_FAILED") {
      const now = this._now();
      if (!this._authBlockedUntil) {
        this._authBlockedUntil = now + this.options.authBlockCooldownMs;
        const waitMin = Math.round(this.options.authBlockCooldownMs / 6e4);
        console.warn(
          `[MQTT:${this.label}] 🔒 login_blocked — إيقاف مؤقت ${waitMin} دقيقة ثم إعادة محاولة`,
        );
        this.state = "AUTH_FAILED";
        this._emitState();
        this.emit("auth_failed", this.health());
        this._clearT(this.authTimer);
        this.authTimer = this._setT(() => {
          this.authTimer = null;
          if (this.stopped) return;
          console.log(`[MQTT:${this.label}] ⏰ انتهى وقت الانتظار — إعادة محاولة الاتصال`);
          this._authBlockedUntil = null;
          this.lastErrorClass = null;
          this.reconnectAttempts = 0;
          void this._stopListener().then(() => this._connectOnce("auth_block_retry"));
        }, this.options.authBlockCooldownMs);
        this.authTimer?.unref?.();
        return false;
      }
      if (now < this._authBlockedUntil) return false;
    }
    if (this._now() < this.cooldownUntil) {
      this.state = "RECONNECT_WAIT";
      this._emitState();
      return false;
    }
    const attempt = ++this.reconnectAttempts;
    const delay = fullJitter(
      attempt - 1,
      this.options.reconnectBaseMs,
      this.options.reconnectCapMs,
      this._random,
    );
    this.state = "RECONNECT_WAIT";
    this._emitState();
    await this._sleep(delay);
    if (this.stopped) return false;
    await this._stopListener();
    this.state = "RECONNECTING";
    this._emitState();
    const ok = await this._connectOnce(reason);
    this.totalReconnects++;
    if (!ok && this.reconnectAttempts >= this.options.maxFastAttempts) {
      this.cooldownUntil = this._now() + this.options.cooldownMs;
      this.state = "RECONNECT_WAIT";
      this.emit("cooldown", this.health());
    }
    return ok;
  }
  _sleep(ms) {
    return new Promise((resolve) => {
      const t = this._setT(resolve, ms);
      t?.unref?.();
    });
  }
  async _stopListener() {
    const old = this.listener;
    this.listener = null;
    if (!old) return;
    this.lastDisconnectAt = this._now();
    try {
      if (typeof old.stopListeningAsync === "function") await old.stopListeningAsync();
      else await old.stopListening?.();
    } catch (error) {
      this._recordError(error, "STOP_LISTENER");
    }
  }
  _recordEvent(event) {
    this.lastEventAt = this._now();
    this.eventsReceived++;
    this.lastEventType = event?.type || "unknown";
    if (this.connectedSince && this._now() - this.connectedSince >= this.options.stableWindowMs) {
      this.reconnectAttempts = 0;
      this.cooldownUntil = 0;
      this.consecutiveErrors = 0;
    }
    this.state = "CONNECTED";
    this._emitState();
  }
  _recordError(error, forcedClass = null) {
    const message = redactText(getErrorText(error)).slice(0, 300);
    const errorClass = forcedClass || classifyMqttError(error);
    this.errors++;
    this.consecutiveErrors++;
    this.lastErrorAt = this._now();
    this.lastError = message;
    this.lastErrorClass = errorClass;
    this.lastDisconnectAt = this._now();
    if (errorClass === "AUTH_FAILED") this.state = "AUTH_FAILED";
    else if (this.state !== "STOPPED") this.state = "DEGRADED";
    this.emit("error_observed", { errorClass, message, at: this.lastErrorAt });
    this._emitState();
  }
  _scheduleWatchdog() {
    this._clearT(this.watchdogTimer);
    if (this.stopped) return;
    this.watchdogTimer = this._setT(async () => {
      try {
        await this._watchdogTick();
      } catch (error) {
        this._recordError(error, "WATCHDOG");
      } finally {
        this._scheduleWatchdog();
      }
    }, this.options.watchdogIntervalMs);
    this.watchdogTimer?.unref?.();
  }
  async _watchdogTick() {
    const now = this._now();
    if (this.state === "AUTH_FAILED" || this.state === "STOPPED" || this.reconnectPromise) return;
    const alive = this._socketAlive();
    if (this.state === "CONNECTING") {
      // Socket is up but no event yet: promote. Otherwise give up after connectTimeoutMs.
      if (alive) {
        this.state = "CONNECTED";
        this._emitState();
      } else if (now - this.connectedSince >= this.options.connectTimeoutMs) {
        await this.reconnect("connect_timeout");
      }
      return;
    }
    const settling = this.connectedSince > 0 && now - this.connectedSince < this.options.initialGraceMs;
    if (settling) return;
    const staleFor = now - this._lastInboundRef();
    if (!alive || staleFor >= this.options.staleAfterMs) {
      await this.reconnect(alive ? "stale" : "socket_not_alive");
    }
  }
  _schedulePing() {
    this._clearT(this.pingTimer);
    if (this.stopped) return;
    this.pingTimer = this._setT(() => {
      if (this._socketAlive()) {
        this.lastPingAt = this._now(); // informational only
        this._resetReconnectBudgetIfStable();
        this.emit("ping_ok", this.health());
      }
      this._schedulePing();
    }, this.options.pingIntervalMs);
    this.pingTimer?.unref?.();
  }
  _emitState() {
    try {
      this._onState?.(this.health());
    } catch (_) {}
  }
  _resetReconnectBudgetIfStable() {
    if (!this.connectedSince) return;
    if (this._now() - this.connectedSince < this.options.stableWindowMs) return;
    this.reconnectAttempts = 0;
    this.cooldownUntil = 0;
    this.consecutiveErrors = 0;
  }
}
export function createMqttConnectionManager(api, options) {
  return new MqttConnectionManager(api, options);
}
export default MqttConnectionManager;
