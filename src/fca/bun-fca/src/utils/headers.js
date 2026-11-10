"use strict";

const { getIdentity } = require("./clientIdentity");

function sanitizeHeaderValue(value) {
  if (value === null || value === undefined) return "";
  let str = String(value);

  if (str.trim().startsWith("[") && str.trim().endsWith("]")) {

    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {

        return "";
      }
    } catch {

    }
  }

  str = str.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F\r\n\[\]]/g, "").trim();

  return str;
}

function sanitizeHeaderName(name) {
  if (!name || typeof name !== "string") return "";

  return name.replace(/[^\x21-\x7E]/g, "").trim();
}

function getHeaders(url, options, ctx, customHeader) {
  const u = new URL(url);

  const identity = getIdentity(options?.userAgent);
  const ua = identity.userAgent;
  const referer = options?.referer || "https://www.facebook.com/";
  const origin = referer.replace(/\/+$/, "");
  const contentType = options?.contentType || "application/x-www-form-urlencoded";
  const acceptLang = options?.acceptLanguage || identity.acceptLanguage;
  const headers = {
    Host: sanitizeHeaderValue(u.host),
    Origin: sanitizeHeaderValue(origin),
    Referer: sanitizeHeaderValue(referer),
    "User-Agent": sanitizeHeaderValue(ua),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": sanitizeHeaderValue(acceptLang),
    "Accept-Encoding": "gzip, deflate, br",
    "Content-Type": sanitizeHeaderValue(contentType),
    Connection: "keep-alive",
    DNT: "1",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "X-Requested-With": "XMLHttpRequest",
    Pragma: "no-cache",
    "Cache-Control": "no-cache"
  };

  if (identity.secChUa) headers["sec-ch-ua"] = identity.secChUa;
  if (identity.secChUaMobile) headers["sec-ch-ua-mobile"] = identity.secChUaMobile;
  if (identity.secChUaPlatform) headers["sec-ch-ua-platform"] = identity.secChUaPlatform;
  if (identity.secChUaArch) headers["sec-ch-ua-arch"] = identity.secChUaArch;
  if (identity.secChUaBitness) headers["sec-ch-ua-bitness"] = identity.secChUaBitness;
  if (identity.secChUaFullVersionList) headers["sec-ch-ua-full-version-list"] = identity.secChUaFullVersionList;
  if (identity.secChUaPlatformVersion) headers["sec-ch-ua-platform-version"] = identity.secChUaPlatformVersion;
  if (ctx?.region) {
    const regionValue = sanitizeHeaderValue(ctx.region);
    if (regionValue) headers["X-MSGR-Region"] = regionValue;
  }
  if (customHeader && typeof customHeader === "object") {

    for (const [key, value] of Object.entries(customHeader)) {

      if (value === null || value === undefined || typeof value === "function") {
        continue;
      }
      if (typeof value === "object") {

        if (Array.isArray(value)) {
          continue;
        }

        continue;
      }

      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        const sanitizedKey = sanitizeHeaderName(key);
        const sanitizedValue = sanitizeHeaderValue(value);
        if (sanitizedKey && sanitizedValue !== "") {
          headers[sanitizedKey] = sanitizedValue;
        }
      }
    }
  }

  const sanitizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const sanitizedKey = sanitizeHeaderName(key);
    const sanitizedValue = sanitizeHeaderValue(value);
    if (sanitizedKey && sanitizedValue !== "") {
      sanitizedHeaders[sanitizedKey] = sanitizedValue;
    }
  }
  return sanitizedHeaders;
}

module.exports = { getHeaders };