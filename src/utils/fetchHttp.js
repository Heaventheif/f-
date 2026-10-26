"use strict";
import { Readable } from "stream";
import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import { promises as dns } from "dns";
import net from "net";

// ─── SSRF Guard ─────────────────────────────────────────────────
// الفحص السابق كان يغطي IPv4 الأساسي فقط: لا ::ffff:127.0.0.1 ولا fd00::/8 ولا
// عناوين متعددة الإرسال. نحلّل العنوان الآن إلى أرقام ونفحص النطاقات المحجوزة.
function _isPrivateIPv4(p) {
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return true;           // this-net / خاص / loopback
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
  if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;   // IETF + TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;        // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;         // TEST-NET-3
  if (a >= 224) return true;                                  // multicast + reserved + broadcast
  return false;
}

function _parseIPv6(input) {
  let ip = String(input).split("%")[0].toLowerCase();
  if (ip.includes(".")) {                                     // ::ffff:1.2.3.4
    const i = ip.lastIndexOf(":");
    const v4 = ip.slice(i + 1).split(".").map(Number);
    if (v4.length !== 4 || v4.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    ip = `${ip.slice(0, i + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

const _v4FromGroups = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

function _isPrivateIPv6(g) {
  if (g.slice(0, 5).every(x => x === 0)) {
    if (g[5] === 0xffff) return _isPrivateIPv4(_v4FromGroups(g[6], g[7]));   // IPv4-mapped
    if (g[5] === 0)      return true;                                         // ::, ::1, IPv4-compatible
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) // NAT64
    return _isPrivateIPv4(_v4FromGroups(g[6], g[7]));
  if (g[0] === 0x2002) return _isPrivateIPv4(_v4FromGroups(g[1], g[2]));     // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true;     // fc00::/7  (ULA — يشمل fd00::)
  if ((g[0] & 0xffc0) === 0xfe80) return true;     // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;     // fec0::/10 site-local (مهمل)
  if ((g[0] & 0xff00) === 0xff00) return true;     // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;   // documentation
  return false;
}

export function isPrivateIp(rawIp) {
  const ip = String(rawIp).replace(/^\[|\]$/g, "");
  if (net.isIPv6(ip)) {
    const groups = _parseIPv6(ip);
    return groups ? _isPrivateIPv6(groups) : true;   // غير مفهوم → احجب
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return _isPrivateIPv4(parts);
}
const _isPrivateIp = isPrivateIp;

// كاش قصير لنتيجة فحص DNS الآمن لكل hostname — يتجنب lookup على كل طلب
// TTL قصير: كل ثانية إضافية تُطيل نافذة DNS-rebinding (لا نثبّت IP لأن fetch لا يدعم ذلك).
const _DNS_OK_TTL_MS = 10_000;
const _DNS_OK_MAX = 500;
const _dnsOkCache = new Map(); // hostname -> expiresAt

async function _assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`[SSRF] Invalid URL: ${rawUrl}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`[SSRF] Disallowed protocol: ${parsed.protocol}`);
  }
  // WHATWG URL يُبقي الأقواس في عناوين IPv6 ("[::1]") ويحوّل 2130706433 إلى 127.0.0.1
  const bareHost = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bareHost)) {
    if (_isPrivateIp(bareHost)) throw new Error(`[SSRF] Direct private IP blocked: ${parsed.hostname}`);
    return;   // عنوان عام صريح: لا حاجة لـ DNS
  }
  // DNS pre-resolution — block hostnames that resolve to private ranges
  const _host = parsed.hostname.toLowerCase();
  const _cachedUntil = _dnsOkCache.get(_host);
  if (_cachedUntil && _cachedUntil > Date.now()) return;
  let records;
  try {
    records = await dns.lookup(bareHost, { all: true });
  } catch (e) {
    throw new Error(`[SSRF] DNS resolution failed for ${parsed.hostname}: ${e.message}`);
  }
  for (const { address } of records) {
    if (_isPrivateIp(address)) {
      throw new Error(`[SSRF] Hostname ${parsed.hostname} resolves to private IP ${address} — blocked.`);
    }
  }
  // لا نخزّن إلا النتائج الآمنة
  if (_dnsOkCache.size >= _DNS_OK_MAX) _dnsOkCache.delete(_dnsOkCache.keys().next().value);
  _dnsOkCache.set(_host, Date.now() + _DNS_OK_TTL_MS);
}
// ────────────────────────────────────────────────────────────────
const MAX_REDIRECTS = 5;
const _keepAliveAgents = {
  http:  new HttpAgent({ keepAlive: true, maxSockets: 20 }),
  https: new HttpsAgent({ keepAlive: true, maxSockets: 20 }),
};
const defaults = {
  baseURL: "",
  headers: {},
};
const interceptors = {
  request: [],
  response: [],
};
function buildUrl(url, params, baseURL) {
  const isAbsolute = /^https?:\/\//i.test(String(url));
  let finalUrl = url;
  if (!isAbsolute && baseURL) {
    finalUrl = baseURL.replace(/\/+$/, "") + "/" + String(url).replace(/^\/+/, "");
  }
  if (!params) return finalUrl;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, v);
    } else {
      qs.set(key, String(value));
    }
  }
  const queryString = qs.toString();
  if (!queryString) return finalUrl;
  return finalUrl + (finalUrl.includes("?") ? "&" : "?") + queryString;
}
function defaultValidateStatus(status) {
  return status >= 200 && status < 300;
}
function wrapNetworkError(e, timeout) {
  if (e.name === "AbortError") {
    const err = new Error(`timeout of ${timeout}ms exceeded`);
    err.code = "ECONNABORTED";
    err.response = undefined;
    return err;
  }
  const err = new Error(e.message || "Network Error");
  err.code = e.cause?.code || e.code || "ENETWORK";
  err.cause = e.cause || e;
  err.response = undefined;
  return err;
}
function isRetryable(err) {
  if (err.code === "ECONNABORTED" || err.code === "ENETWORK") return true;
  if (err.response && err.response.status >= 500) return true;
  return false;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function performRequest(config) {
  const {
    url,
    method = "GET",
    headers = {},
    params,
    data,
    timeout = 0,
    responseType = "json",
    validateStatus = defaultValidateStatus,
    baseURL = defaults.baseURL,
  } = config;
  if (!url) throw new Error("fetchHttp: 'url' مطلوب");
  const finalUrl = buildUrl(url, params, baseURL);
  const finalHeaders = { ...defaults.headers, ...headers };
  let body;
  const upper = method.toUpperCase();
  if (data !== undefined && upper !== "GET" && upper !== "HEAD") {
    const isPlainObject =
      data !== null &&
      typeof data === "object" &&
      !(data instanceof Buffer) &&
      !(data instanceof URLSearchParams) &&
      !(typeof FormData !== "undefined" && data instanceof FormData) &&
      !(data instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(data);
    if (isPlainObject) {
      body = JSON.stringify(data);
      if (!Object.keys(finalHeaders).some((h) => h.toLowerCase() === "content-type")) {
        finalHeaders["Content-Type"] = "application/json";
      }
    } else {
      body = data;
    }
  }
  const controller = timeout ? new AbortController() : null;
  const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;
  // إعادة التوجيه تُتبَّع يدوياً: fetch الافتراضي كان يتبعها دون إعادة فحص الوجهة،
  // فيكفي رابط عام يحوّل إلى http://169.254.169.254/ لتجاوز الحاجز.
  let currentUrl = finalUrl;
  let currentMethod = upper;
  let currentBody = body;
  let currentHeaders = finalHeaders;
  let res;
  try {
    for (let hop = 0; ; hop++) {
      await _assertSafeUrl(currentUrl);
      res = await fetch(currentUrl, {
        method: currentMethod,
        headers: currentHeaders,
        body: currentBody,
        redirect: "manual",
        signal: controller ? controller.signal : undefined,
        agent: currentUrl.startsWith("https") ? _keepAliveAgents.https : _keepAliveAgents.http,
      });
      const location = res.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(res.status) || !location) break;
      if (hop >= MAX_REDIRECTS) throw new Error(`[SSRF] Too many redirects (>${MAX_REDIRECTS})`);
      try { await res.body?.cancel(); } catch (_) {}
      const next = new URL(location, currentUrl);
      if (next.origin !== new URL(currentUrl).origin) {
        // لا نمرّر بيانات اعتماد إلى أصل آخر
        currentHeaders = Object.fromEntries(Object.entries(currentHeaders)
          .filter(([k]) => !/^(authorization|cookie|proxy-authorization|x-api-key)$/i.test(k)));
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === "POST")) {
        currentMethod = "GET";
        currentBody = undefined;
      }
      currentUrl = next.href;
    }
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e?.message?.startsWith("[SSRF]")) throw e;
    throw wrapNetworkError(e, timeout);
  }
  if (timer) clearTimeout(timer);
  const status = res.status;
  const statusText = res.statusText;
  const resHeaders = Object.fromEntries(res.headers.entries());
  if (!validateStatus(status)) {
    let errData;
    try {
      const text = await res.text();
      try {
        errData = text ? JSON.parse(text) : undefined;
      } catch (_) {
        errData = text;
      }
    } catch (_) {
      errData = undefined;
    }
    const err = new Error(`Request failed with status code ${status}`);
    err.code = `ERR_BAD_STATUS_${status}`;
    err.response = { status, statusText, headers: resHeaders, data: errData };
    throw err;
  }
  let responseData;
  if (responseType === "arraybuffer") {
    responseData = Buffer.from(await res.arrayBuffer());
  } else if (responseType === "stream") {
    responseData = Readable.fromWeb(res.body);
  } else if (responseType === "text") {
    responseData = await res.text();
  } else {
    const text = await res.text();
    if (!text) {
      responseData = null;
    } else {
      try {
        responseData = JSON.parse(text);
      } catch (_) {
        responseData = text;
      }
    }
  }
  return { data: responseData, status, statusText, headers: resHeaders };
}
async function request(config = {}) {
  let finalConfig = config;
  for (const fn of interceptors.request) {
    finalConfig = (await fn(finalConfig)) || finalConfig;
  }
  const retries = finalConfig.retries ?? 0;
  const retryDelay = finalConfig.retryDelay ?? 300;
  let attempt = 0;
  while (true) {
    try {
      let res = await performRequest(finalConfig);
      for (const fn of interceptors.response) {
        res = (await fn(res)) || res;
      }
      return res;
    } catch (err) {
      if (attempt < retries && isRetryable(err)) {
        attempt++;
        await sleep(retryDelay * attempt);
        continue;
      }
      throw err;
    }
  }
}
function get(url, config = {}) {
  return request({ ...config, url, method: "GET" });
}
function post(url, data, config = {}) {
  return request({ ...config, url, method: "POST", data });
}
function put(url, data, config = {}) {
  return request({ ...config, url, method: "PUT", data });
}
function del(url, config = {}) {
  return request({ ...config, url, method: "DELETE" });
}
// Named export so other modules (mediaStream, etc.) can reuse the SSRF guard.
export { _assertSafeUrl as assertSafeUrl };
export default Object.assign(request, {
  get,
  post,
  put,
  delete: del,
  request,
  defaults,
  interceptors,
});
