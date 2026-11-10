"use strict";

const { isStream } = require("./helpers");
const { CookieJar } = require("./cookiejar");

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function headersToObject(headers) {
  const out = {};
  let setCookie = [];
  try {
    if (headers && typeof headers.getSetCookie === "function") {
      setCookie = headers.getSetCookie();
    }
  } catch (_) {   }
  if (!setCookie.length && headers) {
    const sc = headers.get("set-cookie");
    if (sc) setCookie = [sc];
  }
  if (headers && typeof headers.forEach === "function") {
    headers.forEach((value, name) => {
      const n = String(name).toLowerCase();
      if (n === "set-cookie") return;
      out[n] = Array.isArray(value) ? value.join(", ") : String(value);
    });
  }
  if (setCookie.length) out["set-cookie"] = setCookie;
  return out;
}

function parseParams(params) {
  if (!params) return "";
  if (typeof params === "string") return params.startsWith("?") ? params : "?" + params;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, String(item));
    } else {
      sp.append(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? "?" + s : "";
}

function buildRequestUrl(config, extraParams) {
  let url = config.url || "/";
  if (config.baseURL && !/^https?:\/\//i.test(url)) {
    url = String(config.baseURL).replace(/\/+$/, "") + "/" + String(url).replace(/^\/+/, "");
  }
  const paramsStr = parseParams(extraParams);
  if (paramsStr) {

    url += url.includes("?") ? "&" + paramsStr.slice(1) : paramsStr;
  }
  return url;
}

async function buildBody(data, headers) {
  if (data === undefined || data === null) return { body: undefined };

  if (typeof data === "string") {
    return { body: data };
  }
  if (Buffer.isBuffer(data) || data instanceof Uint8Array || data instanceof ArrayBuffer) {
    return { body: data };
  }

  if (
    typeof data === "object" &&
    (data.__isBunFcaFormData ||
      (typeof FormData !== "undefined" && data instanceof FormData))
  ) {
    if (data.__isBunFcaFormData) {
      const { body, contentType } = await data.toFetchBody();
      headers["content-type"] = contentType;
      return { body };
    }
    return { body: data };
  }

  if (isStream(data)) {
    const buf = await streamToBuffer(data);
    return { body: buf };
  }

  if (typeof data === "object") {
    headers["content-type"] = headers["content-type"] || "application/json";
    return { body: JSON.stringify(data) };
  }

  return { body: String(data) };
}

function toAbortSignal(timeoutMs, externalSignal) {
  const signals = [];
  if (timeoutMs) {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      signals.push(AbortSignal.timeout(timeoutMs));
    }
  }
  if (externalSignal) signals.push(externalSignal);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }
  return signals[0];
}

function createNetworkError(message, cause, config) {
  const err = new Error(message);
  err.code = (cause && cause.code) || "ERR_NETWORK";
  err.cause = cause;
  if (config) err.config = config;
  return err;
}

function createClient(jar) {
  const defaultJar = jar;

  async function request(config) {
    const maxRedirects = config.maxRedirects === undefined ? 5 : config.maxRedirects;
    const activeJar = config.jar || defaultJar;
    const timeoutMs = config.timeout || 60000;
    const signal = toAbortSignal(timeoutMs, config.signal);

    let url = buildRequestUrl(config, config.params);
    let method = String(config.method || "GET").toUpperCase();
    let headers = { ...(config.headers || {}) };
    let bodyInfo = await buildBody(config.data, headers);

    const fetchOptions = {
      method,
      headers,
      redirect: "manual",
      signal,
      credentials: "omit",
      cache: "no-store"
    };
    if (bodyInfo.body !== undefined) fetchOptions.body = bodyInfo.body;
    if (config.dispatcher) fetchOptions.dispatcher = config.dispatcher;
    if (config.proxy && typeof config.proxy === "string") fetchOptions.proxy = config.proxy;

    let currentHop = 0;
    let response;

    const explicitCookie = !!(config.headers && (config.headers.Cookie || config.headers.cookie));
    for (;;) {

      if (!explicitCookie && activeJar && typeof activeJar.getCookieStringSync === "function") {
        try {
          const jarStr = activeJar.getCookieStringSync(url);
          if (jarStr) headers["cookie"] = jarStr;
          else delete headers["cookie"];
        } catch (_) { }
      }
      let res;
      try {
        res = await fetch(url, fetchOptions);
      } catch (e) {
        if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
          const err = createNetworkError(`timeout of ${timeoutMs}ms exceeded`, e, config);
          err.code = "ECONNABORTED";
          throw err;
        }
        throw createNetworkError("Network Error", e, config);
      }

      const resHeaders = headersToObject(res.headers);
      const setCookies = resHeaders["set-cookie"];
      if (activeJar && Array.isArray(setCookies) && setCookies.length) {
        for (const c of setCookies) {
          try {
            activeJar.setCookieSync(c, url);
          } catch (_) {   }
        }
      }

      const status = res.status;
      const location = resHeaders["location"];
      const isRedirect =
        (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) &&
        location !== undefined;

      if (!isRedirect || currentHop >= maxRedirects || maxRedirects === 0) {
        const resHeadersFinal = resHeaders;

        if (config.responseType === "stream" && res.body) {
          const { Readable } = require("stream");
          const nodeStream =
            typeof Readable.fromWeb === "function" ? Readable.fromWeb(res.body) : null;
          if (nodeStream) {
            response = {
              data: nodeStream,
              status,
              statusText: res.statusText || "",
              headers: resHeadersFinal,
              config: { ...config, url, method },
              request: { res: { responseUrl: url } },
              ok: status >= 200 && status < 300
            };
            break;
          }
        }
        const resText = await res.text();
        let data = resText;
        const contentType = String(resHeadersFinal["content-type"] || "");
        if (contentType.includes("json")) {
          try {
            data = JSON.parse(resText);
          } catch (_) {   }
        } else if (contentType.includes("text/plain")) {

          const t = resText.trim();
          if (t.startsWith("{") || t.startsWith("[")) {
            try {
              data = JSON.parse(t);
            } catch (_) {   }
          }
        }
        response = {
          data,
          status,
          statusText: res.statusText || "",
          headers: resHeadersFinal,
          config: { ...config, url, method },
          request: { res: { responseUrl: url } },
          ok: status >= 200 && status < 300
        };
        break;
      }

      const nextUrl = new URL(location, url).toString();
      if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
        method = "GET";
        fetchOptions.method = "GET";
        fetchOptions.body = undefined;
        delete headers["content-type"];
        delete headers["content-length"];
      }

      if (new URL(nextUrl).host !== new URL(url).host) {
        delete headers.cookie;
      }
      url = nextUrl;
      currentHop++;
    }

    const validate = config.validateStatus;
    if (typeof validate === "function" && !validate(response.status)) {
      const err = new Error(`Request failed with status code ${response.status}`);
      err.response = response;
      err.config = response.config;
      err.status = response.status;
      throw err;
    }

    return response;
  }

  const client = {
    defaults: {
      jar: defaultJar,
      timeout: 60000,
      headers: {},
      httpAgent: undefined,
      httpsAgent: undefined,
      proxy: false,
      baseURL: ""
    },

    request,

    async get(url, config = {}) {
      return request({ ...config, url, method: "GET" });
    },

    async post(url, data, config = {}) {
      return request({ ...config, url, data, method: "POST" });
    },

    create(cfg = {}) {
      return createClient(cfg.jar || defaultJar);
    }
  };

  return client;
}

const defaultJar = new CookieJar();
const client = createClient(defaultJar);

module.exports = { createClient, client, jar: defaultJar, delay, headersToObject, buildRequestUrl, streamToBuffer };