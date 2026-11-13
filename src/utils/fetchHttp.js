"use strict";
// Axios-like facade over net/safeFetch (SSRF guard, deadline, byte cap on every call).
import { Readable } from "node:stream";
import { isPrivateIp, assertSafeUrl } from "./ssrfGuard.js";
import { safeFetch } from "../net/safeFetch.js";
import { AppError } from "../infra/errors.js";

export { isPrivateIp, assertSafeUrl };

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const defaults = { baseURL: "", headers: {} };
const interceptors = { request: [], response: [] };

export function buildUrl(url, params, baseURL) {
  const isAbsolute = /^https?:\/\//i.test(String(url));
  let finalUrl = String(url);
  if (!isAbsolute && baseURL) {
    finalUrl = baseURL.replace(/\/+$/, "") + "/" + finalUrl.replace(/^\/+/, "");
  }
  if (!params) return finalUrl;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) qs.append(key, v);
    else qs.set(key, String(value));
  }
  const queryString = qs.toString();
  if (!queryString) return finalUrl;
  return finalUrl + (finalUrl.includes("?") ? "&" : "?") + queryString;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRetryable = (err) =>
  err.code === "ECONNABORTED" || err.code === "ENETWORK" || (err.response?.status ?? 0) >= 500;

function wrapError(e, timeout) {
  if (e instanceof AppError && e.code === "timeout") {
    const err = new Error(`timeout of ${timeout}ms exceeded`, { cause: e });
    err.code = "ECONNABORTED";
    err.appCode = "timeout";
    return err;
  }
  if (e instanceof AppError) {
    // blocked_url keeps its original "[SSRF] ..." message; too_large etc. stay typed.
    if (e.code === "upstream" && e.status) {
      const err = new Error(`Request failed with status code ${e.status}`, { cause: e });
      err.code = `ERR_BAD_STATUS_${e.status}`;
      err.appCode = e.code;
      err.response = { status: e.status, data: undefined, headers: {} };
      return err;
    }
    return e;
  }
  if (e?.name === "AbortError") {
    const err = new Error(timeout ? `timeout of ${timeout}ms exceeded` : "request aborted", { cause: e });
    err.code = "ECONNABORTED";
    return err;
  }
  const err = new Error(e?.message || "Network Error", { cause: e?.cause || e });
  err.code = e?.cause?.code || e?.code || "ENETWORK";
  return err;
}

async function readBody(res, maxBytes) {
  const len = Number(res.headers.get("content-length"));
  if (maxBytes && len > maxBytes) {
    await res.body?.cancel().catch(() => {});
    res.__done?.();
    throw new AppError("too_large", "content_length");
  }
  if (!res.body) { res.__done?.(); return Buffer.alloc(0); }
  const chunks = [];
  let total = 0;
  try {
    for await (const c of Readable.fromWeb(res.body)) {
      total += c.length;
      if (maxBytes && total > maxBytes) throw new AppError("too_large", "stream_cap");
      chunks.push(c);
    }
  } finally { res.__done?.(); }
  return Buffer.concat(chunks);
}

function parseText(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function performRequest(config) {
  const {
    url, method = "GET", headers = {}, params, data, timeout = DEFAULT_TIMEOUT_MS, signal,
    responseType = "json", validateStatus = (s) => s >= 200 && s < 300,
    baseURL = defaults.baseURL, maxBytes = DEFAULT_MAX_BYTES, allowHosts, allowPrivate,
  } = config;
  if (!url) throw new Error("fetchHttp: 'url' مطلوب");
  const finalHeaders = { ...defaults.headers, ...headers };
  const upper = method.toUpperCase();
  let body;
  if (data !== undefined && upper !== "GET" && upper !== "HEAD") {
    const plain =
      data !== null && typeof data === "object" && !(data instanceof Uint8Array) &&
      !(data instanceof URLSearchParams) && !(typeof FormData !== "undefined" && data instanceof FormData) &&
      !(data instanceof ArrayBuffer) && !(typeof Blob !== "undefined" && data instanceof Blob);
    if (plain) {
      body = JSON.stringify(data);
      if (!Object.keys(finalHeaders).some((h) => h.toLowerCase() === "content-type")) finalHeaders["Content-Type"] = "application/json";
    } else body = data;
  }
  let res;
  try {
    res = await safeFetch(buildUrl(url, params, baseURL), {
      method: upper, headers: finalHeaders, body, timeoutMs: timeout || DEFAULT_TIMEOUT_MS, signal,
      allowErrorStatus: true, allowHosts, allowPrivate,
    });
  } catch (e) { throw wrapError(e, timeout); }
  const status = res.status;
  const resHeaders = Object.fromEntries(res.headers.entries());
  try {
    if (!validateStatus(status)) {
      let errData;
      try { errData = parseText((await readBody(res, 1024 * 1024)).toString("utf8")); } catch { errData = undefined; }
      const err = new Error(`Request failed with status code ${status}`);
      err.code = `ERR_BAD_STATUS_${status}`;
      err.response = { status, statusText: res.statusText, headers: resHeaders, data: errData };
      throw err;
    }
    if (responseType === "stream") {
      const stream = Readable.fromWeb(res.body);
      stream.once("close", () => res.__done?.());
      return { data: stream, status, statusText: res.statusText, headers: resHeaders };
    }
    const buf = await readBody(res, maxBytes);
    let out;
    if (responseType === "arraybuffer") out = buf;
    else if (responseType === "text") out = buf.toString("utf8");
    else out = parseText(buf.toString("utf8"));
    return { data: out, status, statusText: res.statusText, headers: resHeaders };
  } catch (e) {
    res.__done?.();
    throw e.response ? e : wrapError(e, timeout);
  }
}

async function request(config = {}) {
  let finalConfig = config;
  for (const fn of interceptors.request) finalConfig = (await fn(finalConfig)) || finalConfig;
  const retries = String(finalConfig.method || "GET").toUpperCase() === "GET" ? finalConfig.retries ?? 0 : 0;
  const retryDelay = finalConfig.retryDelay ?? 300;
  for (let attempt = 0; ; attempt++) {
    try {
      let res = await performRequest(finalConfig);
      for (const fn of interceptors.response) res = (await fn(res)) || res;
      return res;
    } catch (err) {
      if (attempt < retries && isRetryable(err)) { await sleep(retryDelay * (attempt + 1)); continue; }
      throw err;
    }
  }
}
const get = (url, config = {}) => request({ ...config, url, method: "GET" });
const post = (url, data, config = {}) => request({ ...config, url, method: "POST", data });
const put = (url, data, config = {}) => request({ ...config, url, method: "PUT", data });
const del = (url, config = {}) => request({ ...config, url, method: "DELETE" });

export default Object.assign(request, { get, post, put, delete: del, request, defaults, interceptors });
