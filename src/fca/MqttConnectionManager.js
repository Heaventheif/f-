import { EventEmitter } from "node:events";

const DEFAULTS = {
  staleAfterMs: 8 * 60_000,
  initialGraceMs: 2 * 60_000,
  watchdogIntervalMs: 30_000,
  stableWindowMs: 5 * 60_000,
  reconnectBaseMs: 2_000,
  reconnectCapMs: 5 * 60_000,
  cooldownMs: 15 * 60_000,
  authBlockCooldownMs: 90 * 60_000,  // ← 90 دقيقة انتظار عند login_blocked
  maxFastAttempts: 10,
  pingIntervalMs: 120_000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getErrorText(error) {
  return String(error?.message || error || "unknown error");
}

export function classifyMqttError(error) {
  const text = getErrorText(error).toLowerCase();
  const status = Number(error?.statusCode ?? error?.status ?? error?.code);

  // login_blocked = حجب مؤقت من فيسبوك — يُعالَج بانتظار طويل لا بإيقاف دائم
  if (/login_blocked/.test(text)) return "AUTH_FAILED";

  if (
    status === 401 || status === 403 ||
    /not logged in|blocked the login|checkpoint|invalid.*session|not.*authenticated|session.*expired|credentials.*invalid/.test(text)
  ) return "AUTH_FAILED";

  if (/rate.?limit|too many requests|429/.test(text)) return "RATE_LIMITED";
  if (/timeout|keep.?alive|socket|econnreset|enetunreach|eai_again|connection refused|closed|disconnect/.test(text)) {
    return "TRANSIENT";
  }
  return "UNKNOWN";
}

function fullJitter(attempt, baseMs, capMs) {
  const ceiling = Math.min(capMs, baseMs * (2 ** Math.min(attempt, 12)));
  // Minimum 500 ms so the first reconnect never fires at 0 ms (avoids FB rate-limit).
  return Math.max(500, Math.floor(Math.random() * Math.max(baseMs, ceiling)));
}

export class MqttConnectionManager extends EventEmitter {
  constructor(api, options = {}) {
    super();
    this.api = api;
    this.label = options.label || "MQTT";
    this.botIndex = options.botIndex ?? null;
    this.options = { ...DEFAULTS, ...options };

    this.listener = null;
    this.started = false;
    this.stopped = true;
    this.state = "STOPPED";
    this.reconnectPromise = null;
    this.watchdogTimer = null;
    this.pingTimer = null;
    this.cooldownUntil = 0;
    this.connectedSince = 0;
    this.lastEventAt = 0;
    this.lastPingAt = 0;
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
    this.lastEventAt = Date.now();
    this._scheduleWatchdog();
    this._schedulePing();
    void this._connectOnce("startup");
    return this;
  }

  async stop() {
    this.stopped = true;
    this.started = false;
    this.state = "STOPPED";
    clearTimeout(this.watchdogTimer);
    clearTimeout(this.pingTimer);
    this.watchdogTimer = null;
    this.pingTimer = null;
    await this._stopListener();
    this._emitState();
  }

  reconnect(reason = "manual") {
    if (this.stopped) return false;
    if (this.reconnectPromise) return this.reconnectPromise;
    this.lastReconnectReason = reason;
    this.reconnectPromise = this._reconnect(reason).finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }

  health() {
    const now = Date.now();
    const client = this._mqttClient();
    const socketConnected = client?.connected === true;
    const lastActivityAt = Math.max(this.lastEventAt, this.lastPingAt);
    const staleForMs = lastActivityAt ? Math.max(0, now - lastActivityAt) : null;
    const stableForMs = this.connectedSince ? Math.max(0, now - this.connectedSince) : 0;
    const healthy = !this.stopped && this.state === "CONNECTED" && socketConnected &&
      staleForMs !== null && staleForMs < this.options.staleAfterMs;

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
      lastDisconnectAt: this.lastDisconnectAt ? new Date(this.lastDisconnectAt).toISOString() : null,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
      lastErrorClass: this.lastErrorClass,
      lastError: this.lastError,
      lastReconnectReason: this.lastReconnectReason,
      reconnectAttempts: this.reconnectAttempts,
      totalReconnects: this.totalReconnects,
      consecutiveErrors: this.consecutiveErrors,
      eventsReceived: this.eventsReceived,
      lastEventType: this.lastEventType,
      cooldownUntil: this.cooldownUntil > now ? new Date(this.cooldownUntil).toISOString() : null,
    };
  }

  metrics() {
    return this.health();
  }

  _mqttClient() {
    return this.api?._mqttClient ?? this.api?._ctx?.mqttClient ?? this.api?._ctx?.mqtt ?? this.api?._mqtt ?? null;
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
          this._recordError(handlerError, "EVENT_HANDLER");
        }
      });

      this.connectedSince = Date.now();
      this.lastConnectAt = this.connectedSince;
      // Keep lastEventAt current so the watchdog doesn't fire immediately;
      // state moves to CONNECTED on the first real event from _recordEvent().
      this.lastEventAt = this.connectedSince;
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

    // عند login_blocked: توقف تام لمدة 90 دقيقة ثم إعادة محاولة واحدة
    if (kind === "AUTH_FAILED") {
      const now = Date.now();
      if (!this._authBlockedUntil) {
        this._authBlockedUntil = now + this.options.authBlockCooldownMs;
        const waitMin = Math.round(this.options.authBlockCooldownMs / 60_000);
        console.warn(`[MQTT:${this.label}] 🔒 login_blocked — إيقاف مؤقت ${waitMin} دقيقة ثم إعادة محاولة`);
        this.state = "AUTH_FAILED";
        this._emitState();
        this.emit("auth_failed", this.health());
        // جدول إعادة محاولة واحدة بعد الانتظار
        setTimeout(() => {
          if (this.stopped) return;
          console.log(`[MQTT:${this.label}] ⏰ انتهى وقت الانتظار — إعادة محاولة الاتصال`);
          this._authBlockedUntil = null;
          this.lastErrorClass = null;
          this.reconnectAttempts = 0;
          void this._connectOnce("auth_block_retry");
        }, this.options.authBlockCooldownMs);
        return false;
      }
      if (now < this._authBlockedUntil) return false; // لا تزال في فترة الانتظار
    }

    if (Date.now() < this.cooldownUntil) {
      this.state = "RECONNECT_WAIT";
      this._emitState();
      return false;
    }

    const attempt = ++this.reconnectAttempts;
    const delay = fullJitter(attempt - 1, this.options.reconnectBaseMs, this.options.reconnectCapMs);
    this.state = "RECONNECT_WAIT";
    this._emitState();
    await sleep(delay);
    if (this.stopped) return false;

    await this._stopListener();
    this.state = "RECONNECTING";
    this._emitState();
    const ok = await this._connectOnce(reason);
    this.totalReconnects++;

    if (!ok && this.reconnectAttempts >= this.options.maxFastAttempts) {
      this.cooldownUntil = Date.now() + this.options.cooldownMs;
      this.state = "RECONNECT_WAIT";
      this.emit("cooldown", this.health());
    }
    return ok;
  }

  async _stopListener() {
    const old = this.listener;
    this.listener = null;
    if (!old) return;
    this.lastDisconnectAt = Date.now();
    try {
      if (typeof old.stopListeningAsync === "function") await old.stopListeningAsync();
      else await old.stopListening?.();
    } catch (error) {
      this._recordError(error, "STOP_LISTENER");
    }
  }

  _recordEvent(event) {
    this.lastEventAt = Date.now();
    this.eventsReceived++;
    this.lastEventType = event?.type || "unknown";
    if (this.connectedSince && Date.now() - this.connectedSince >= this.options.stableWindowMs) {
      this.reconnectAttempts = 0;
      this.cooldownUntil = 0;
      // Reset consecutive error count once the session has been stable for stableWindowMs.
      this.consecutiveErrors = 0;
    }
    this.state = "CONNECTED";
    this._emitState();
  }

  _recordError(error, forcedClass = null) {
    const message = getErrorText(error).slice(0, 300);
    const errorClass = forcedClass || classifyMqttError(error);
    this.errors++;
    this.consecutiveErrors++;
    this.lastErrorAt = Date.now();
    this.lastError = message;
    this.lastErrorClass = errorClass;
    this.lastDisconnectAt = Date.now();
    if (errorClass === "AUTH_FAILED") this.state = "AUTH_FAILED";
    else if (this.state !== "STOPPED") this.state = "DEGRADED";
    this.emit("error_observed", { errorClass, message, at: this.lastErrorAt });
    this._emitState();
  }

  _scheduleWatchdog() {
    clearTimeout(this.watchdogTimer);
    if (this.stopped) return;
    this.watchdogTimer = setTimeout(async () => {
      try {
        const lastActivityAt = Math.max(this.lastEventAt, this.lastPingAt);
        const staleFor = Date.now() - lastActivityAt;
        // CRITICAL-03 FIX: لا تُطلق الـ watchdog أثناء CONNECTING / AUTH_FAILED / STOPPED.
        // المشكلة السابقة: إذا استغرق handshake MQTT أكثر من initialGraceMs (دقيقتان)،
        // كان الـ watchdog يقتل الجلسة الصحيحة لأن _socketAlive() يعيد false ريثما
        // يُكمل fcanew-r3nz75 إعداد مُوكّل الأحداث الداخلي.
        if (this.state === "CONNECTING" || this.state === "AUTH_FAILED" || this.state === "STOPPED") {
          return; // انتظر الدورة القادمة — المعالجات الداخلية ستُبلِّغ عن أي خطأ حقيقي
        }
        const settling = this.connectedSince > 0 &&
          Date.now() - this.connectedSince < this.options.initialGraceMs;
        // The FCA listener may expose its MQTT client a little after listenMqtt()
        // returns. Do not tear down a new, otherwise error-free session during
        // that settling window; the transport's own error/close handlers remain
        // responsible for immediate failures.
        if (!settling && (!this._socketAlive() || staleFor >= this.options.staleAfterMs)) {
          await this.reconnect(this._socketAlive() ? "stale" : "socket_not_alive");
        }
      } catch (error) {
        this._recordError(error, "WATCHDOG");
      } finally {
        this._scheduleWatchdog();
      }
    }, this.options.watchdogIntervalMs);
    this.watchdogTimer.unref?.();
  }

  _schedulePing() {
    clearTimeout(this.pingTimer);
    if (this.stopped) return;
    this.pingTimer = setTimeout(() => {
      if (this._socketAlive()) {
        this.lastPingAt = Date.now();
        // A quiet account may not emit an application event after connect.
        // The transport ping is still a valid readiness signal; otherwise a
        // healthy idle bot would remain stuck in CONNECTING forever.
        if (this.state !== "AUTH_FAILED" && this.state !== "CONNECTED") {
          this.state = "CONNECTED";
          this._emitState();
        }
        this._resetReconnectBudgetIfStable();
        this.emit("ping_ok", this.health());
      }
      else if (this.state !== "AUTH_FAILED") void this.reconnect("ping_failed");
      this._schedulePing();
    }, this.options.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  _emitState() {
    try { this._onState?.(this.health()); } catch (_) {}
  }

  _resetReconnectBudgetIfStable() {
    if (!this.connectedSince) return;
    if (Date.now() - this.connectedSince < this.options.stableWindowMs) return;
    this.reconnectAttempts = 0;
    this.cooldownUntil = 0;
    this.consecutiveErrors = 0;
  }
}

export function createMqttConnectionManager(api, options) {
  return new MqttConnectionManager(api, options);
}

export default MqttConnectionManager;
