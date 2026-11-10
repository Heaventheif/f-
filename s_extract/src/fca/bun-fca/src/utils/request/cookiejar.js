"use strict";

const MAX_COOKIES = 3000;

function defaultPath(urlPath) {
  if (!urlPath || urlPath.charAt(0) !== "/") return "/";
  const i = urlPath.lastIndexOf("/");
  return i === 0 ? "/" : urlPath.slice(0, i);
}

function parseUrlSafe(url) {
  try {
    return new URL(String(url));
  } catch (_) {
    return null;
  }
}

function normalizeTimestampMs(value) {
  // Facebook appstate exports carry `expires`/`expirationDate` as UNIX SECONDS.
  // Treating them as milliseconds yields 1970 dates => cookies considered expired
  // => silently dropped from every request => FB answers 1357001 (login blocked).
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return n < 1e12 ? n * 1000 : n;
}

function parseExpires(value) {
  if (value === undefined || value === null) return null;
  if (value === "Infinity" || value === "infinity") return "Infinity";
  if (typeof value === "number") {
    const ms = normalizeTimestampMs(value);
    return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
  }
  if (typeof value === "string" && /^\d{9,14}$/.test(value.trim())) {
    const ms = normalizeTimestampMs(value.trim());
    return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

function maxAgeToExpires(value) {
  const secs = Number(value);
  if (!Number.isFinite(secs) || secs <= 0) return new Date(0);
  return new Date(Date.now() + secs * 1000);
}

function parseSetCookieString(str) {
  const raw = String(str || "").trim();
  if (!raw) return null;
  const segments = raw.split(";");
  const pair = segments.shift().trim();
  const eq = pair.indexOf("=");
  let key, value;
  if (eq <= 0) {
    key = pair;
    value = "";
  } else {
    key = pair.slice(0, eq).trim();
    value = pair.slice(eq + 1).trim();
  }
  if (!key) return null;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }

  const attrs = { secure: false, httpOnly: false, sameSite: null };
  for (const seg of segments) {
    const s = seg.trim();
    if (!s) continue;
    const i = s.indexOf("=");
    const name = (i === -1 ? s : s.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? "" : s.slice(i + 1).trim();
    switch (name) {
      case "expires":
        attrs.expires = parseExpires(val);
        break;
      case "max-age":
        attrs.expires = maxAgeToExpires(val);
        break;
      case "domain":
        attrs.domain = val.replace(/^\./, "").toLowerCase();
        break;
      case "path":
        attrs.path = val || "/";
        break;
      case "secure":
        attrs.secure = true;
        break;
      case "httponly":
        attrs.httpOnly = true;
        break;
      case "samesite":
        attrs.sameSite = val.toLowerCase() || null;
        break;
      default:
        break;
    }
  }
  return { key, value, attrs };
}

function domainMatch(host, cookieDomain) {
  if (!host || !cookieDomain) return false;
  host = host.toLowerCase();
  cookieDomain = cookieDomain.toLowerCase().replace(/^\./, "");
  if (!cookieDomain) return false;
  if (host === cookieDomain) return true;
  return host.endsWith("." + cookieDomain);
}

function pathMatch(requestPath, cookiePath) {
  if (!requestPath) requestPath = "/";
  if (requestPath === cookiePath) return true;
  if (requestPath.startsWith(cookiePath)) {
    if (cookiePath.endsWith("/")) return true;
    if (requestPath.charAt(cookiePath.length) === "/") return true;
  }
  return false;
}

function nowMs() {
  return Date.now();
}

class Cookie {
  constructor(data) {
    this.key = data.key;
    this.value = data.value;
    this.domain = data.domain || "";
    this.path = data.path || "/";
    this.hostOnly = !!data.hostOnly;
    this.secure = !!data.secure;
    this.httpOnly = !!data.httpOnly;
    this.sameSite = data.sameSite || null;
    this.creation = data.creation instanceof Date ? data.creation : new Date(data.creation || nowMs());
    this.lastAccessed = data.lastAccessed instanceof Date ? data.lastAccessed : new Date(data.lastAccessed || nowMs());
    const exp = data.expires === undefined ? "Infinity" : data.expires;
    this.expires = parseExpires(exp);
    if (this.expires === null) this.expires = "Infinity";
  }

  get name() {
    return this.key;
  }

  set name(v) {
    this.key = v;
  }

  isExpired() {
    return this.expires !== "Infinity" && this.expires.getTime() <= nowMs();
  }

  toString() {
    return `${this.key}=${this.value}`;
  }
}

class CookieJar {
  constructor(store) {
    this.store = Array.isArray(store) ? store.map((c) => new Cookie(c)) : [];
  }

  toJSON() {
    return {
      cookies: this.store.map((c) => ({
        key: c.key,
        value: c.value,
        domain: c.domain,
        path: c.path,
        hostOnly: c.hostOnly,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        creation: c.creation.toISOString(),
        lastAccessed: c.lastAccessed.toISOString(),
        expires: c.expires === "Infinity" ? "Infinity" : c.expires.toISOString()
      }))
    };
  }

  static fromJSON(json) {
    const obj = typeof json === "string" ? JSON.parse(json) : json;
    return new CookieJar((obj && obj.cookies) || []);
  }

  _upsert(cookie) {
    const now = new Date();
    cookie.lastAccessed = now;
    for (let i = 0; i < this.store.length; i++) {
      const c = this.store[i];
      if (
        c.key === cookie.key &&
        c.domain.toLowerCase() === cookie.domain.toLowerCase() &&
        c.path === cookie.path
      ) {
        cookie.creation = c.creation;
        this.store[i] = cookie;
        return cookie;
      }
    }
    if (this.store.length >= MAX_COOKIES) {

      this.store.sort((a, b) => a.lastAccessed - b.lastAccessed);
      this.store.splice(0, Math.floor(MAX_COOKIES / 10));
    }
    this.store.push(cookie);
    return cookie;
  }

  setCookieSync(strOrCookie, url) {
    const u = parseUrlSafe(url);
    if (!u) return null;

    let key, value, attrs;
    if (strOrCookie && typeof strOrCookie === "object") {
      key = strOrCookie.key || strOrCookie.name;
      value = strOrCookie.value;
      attrs = {
        domain: strOrCookie.domain ? String(strOrCookie.domain).replace(/^\./, "").toLowerCase() : undefined,
        path: strOrCookie.path || undefined,
        expires: strOrCookie.expires !== undefined ? strOrCookie.expires : undefined,
        secure: !!strOrCookie.secure,
        httpOnly: !!strOrCookie.httpOnly,
        sameSite: strOrCookie.sameSite || null
      };
      if (attrs.expires && attrs.expires !== "Infinity") {
        if (typeof attrs.expires === "number") {
          const ms = normalizeTimestampMs(attrs.expires);
          attrs.expires = Number.isFinite(ms) ? new Date(ms) : undefined;
        } else if (typeof attrs.expires === "string" && /^\d{9,14}$/.test(attrs.expires.trim())) {
          const ms = normalizeTimestampMs(attrs.expires.trim());
          attrs.expires = Number.isFinite(ms) ? new Date(ms) : undefined;
        }
      }
    } else {
      const parsed = parseSetCookieString(strOrCookie);
      if (!parsed) return null;
      key = parsed.key;
      value = parsed.value;
      attrs = parsed.attrs;
    }
    if (!key) return null;

    const host = u.hostname.toLowerCase();
    let domain;
    let hostOnly;
    if (attrs.domain) {

      domain = attrs.domain;
      hostOnly = false;
      if (!domainMatch(host, domain)) {
        const err = new Error(`Cookie not in this host's domain: ${host} != ${domain}`);
        err.code = "ERR_DOMAIN_MISMATCH";
        throw err;
      }
    } else {
      domain = host;
      hostOnly = true;
    }

    const path = attrs.path || defaultPath(u.pathname);
    const expires = attrs.expires !== undefined ? attrs.expires : "Infinity";

    return this._upsert(
      new Cookie({
        key,
        value,
        domain,
        path,
        hostOnly,
        secure: attrs.secure,
        httpOnly: attrs.httpOnly,
        sameSite: attrs.sameSite,
        expires
      })
    );
  }

  setCookie(strOrCookie, url) {
    try {
      return Promise.resolve(this.setCookieSync(strOrCookie, url));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  getCookiesSync(url) {
    const u = parseUrlSafe(url);
    if (!u) return [];
    const host = u.hostname.toLowerCase();
    const reqPath = u.pathname || "/";
    const secureReq = u.protocol === "https:";
    const now = nowMs();
    const matched = [];
    for (const c of this.store) {
      if (c.isExpired()) continue;
      if (c.secure && !secureReq) continue;
      if (c.hostOnly) {
        if (host !== c.domain.toLowerCase()) continue;
      } else if (!domainMatch(host, c.domain)) {
        continue;
      }
      if (!pathMatch(reqPath, c.path)) continue;
      c.lastAccessed = new Date(now);
      matched.push(c);
    }

    matched.sort((a, b) => {
      const dl = b.path.length - a.path.length;
      if (dl !== 0) return dl;
      return a.creation.getTime() - b.creation.getTime();
    });
    return matched;
  }

  getCookies(url) {
    return Promise.resolve(this.getCookiesSync(url));
  }

  getCookieStringSync(url) {
    return this.getCookiesSync(url)
      .map((c) => `${c.key}=${c.value}`)
      .join("; ");
  }

  getCookieString(url) {
    return Promise.resolve(this.getCookieStringSync(url));
  }

  removeAllCookiesSync() {
    this.store.length = 0;
  }

  get length() {
    return this.store.length;
  }
}

function createJar() {
  return new CookieJar();
}

module.exports = { CookieJar, Cookie, createJar };