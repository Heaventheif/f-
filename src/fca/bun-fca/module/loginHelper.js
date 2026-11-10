"use strict";
const fs = require("fs");
const path = require("path");
const chalk = require("../func/colors");
const EventEmitter = require("events");
const appstateStore = require("../src/store/appstateStore");
const logger = require("../func/logger");
const { get, post, makeDefaults, client } = require("../src/utils/request");
const { CookieJar } = require("../src/utils/request/cookiejar");
const { saveCookies, getAppState } = require("../src/utils/client");
const { getFrom } = require("../src/utils/constants");
const { loadConfig } = require("./config");
const { config } = loadConfig();
const regions = [
  { code: "PRN", name: "Pacific Northwest Region", location: "Khu vực Tây Bắc Thái Bình Dương" },
  { code: "VLL", name: "Valley Region", location: "Valley" },
  { code: "ASH", name: "Ashburn Region", location: "Ashburn" },
  { code: "DFW", name: "Dallas/Fort Worth Region", location: "Dallas/Fort Worth" },
  { code: "LLA", name: "Los Angeles Region", location: "Los Angeles" },
  { code: "FRA", name: "Frankfurt", location: "Frankfurt" },
  { code: "SIN", name: "Singapore", location: "Singapore" },
  { code: "NRT", name: "Tokyo", location: "Japan" },
  { code: "HKG", name: "Hong Kong", location: "Hong Kong" },
  { code: "SYD", name: "Sydney", location: "Sydney" },
  { code: "PNB", name: "Pacific Northwest - Beta", location: "Pacific Northwest " }
];

const REGION_MAP = new Map(regions.map(r => [r.code, r]));

function parseRegion(html) {
  try {
    const m1 = html.match(/"endpoint":"([^"]+)"/);
    const m2 = m1 ? null : html.match(/endpoint\\":\\"([^\\"]+)\\"/);
    const raw = (m1 && m1[1]) || (m2 && m2[1]);
    if (!raw) return "PRN";
    const endpoint = raw.replace(/\\\//g, "/");
    const url = new URL(endpoint);
    const rp = url.searchParams ? url.searchParams.get("region") : null;
    return rp ? rp.toUpperCase() : "PRN";
  } catch {
    return "PRN";
  }
}

function mask(s, keep = 3) {
  if (!s) return "";
  const n = s.length;
  return n <= keep ? "*".repeat(n) : s.slice(0, keep) + "*".repeat(Math.max(0, n - keep));
}

async function loginViaAPI(email, password, twoFactor = null, apiBaseUrl = null, apiKey = null) {
  try {

    const baseUrl = apiBaseUrl || config.apiServer || null;
    if (!baseUrl) {
      const msg = "loginViaAPI: no apiServer configured. Refusing to send credentials to a default third-party endpoint. Set config.apiServer (or pass apiBaseUrl) explicitly, or log in with an appstate/cookie instead of email+password.";
      logger(chalk.italic(` API-LOGIN: ${msg}`), "error");
      return { ok: false, message: msg };
    }
    logger(chalk.italic(` API-LOGIN: sending credentials for ${mask(email, 2)} to external server ${baseUrl} — only do this if you trust that server.`), "warn");
    const endpoint = `${baseUrl}/api/v1/facebook/login_ios`;
    const xApiKey = apiKey || config.apiKey || null;

    const body = {
      email,
      password
    };

    if (twoFactor && typeof twoFactor === "string" && twoFactor.trim()) {

      body.twoFactor = twoFactor.replace(/\s+/g, "").toUpperCase();
    }

    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json"
    };

    if (xApiKey) {
      headers["x-api-key"] = xApiKey;
    }

    logger(chalk.italic(` API-LOGIN: Attempting login for ${mask(email, 2)} via iOS API`), "info");

    const response = await client.request({
      method: "POST",
      url: endpoint,
      headers,
      data: body,
      timeout: 60000,
      validateStatus: () => true
    });
    if (response.status === 200 && response.data) {
      const data = response.data;

      if (data.error) {
        logger(chalk.italic(` API-LOGIN: Login failed - ${data.error}`), "error");
        return { ok: false, message: data.error };
      }

      const uid = data.uid || data.user_id || data.userId || null;
      const accessToken = data.access_token || data.accessToken || null;
      const cookie = data.cookie || data.cookies || null;

      if (!uid && !accessToken && !cookie) {
        logger("API-LOGIN: Response missing required fields (uid, access_token, cookie)", "warn");
        return { ok: false, message: "Invalid response from API" };
      }

      logger(chalk.italic(` API-LOGIN: Login successful for UID: ${uid || "unknown"}`), "info");

      let cookies = [];
      if (typeof cookie === "string") {

        const pairs = cookie.split(";").map(p => p.trim()).filter(Boolean);
        for (const pair of pairs) {
          const eq = pair.indexOf("=");
          if (eq > 0) {
            const key = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            cookies.push({
              key,
              value,
              domain: ".facebook.com",
              path: "/"
            });
          }
        }
      } else if (Array.isArray(cookie)) {

        cookies = cookie.map(c => ({
          key: c.key || c.name,
          value: c.value,
          domain: c.domain || ".facebook.com",
          path: c.path || "/"
        }));
      }

      return {
        ok: true,
        uid,
        access_token: accessToken,
        cookies,
        cookie: typeof cookie === "string" ? cookie : null
      };
    }

    const errorMsg = response.data && response.data.error
      ? response.data.error
      : response.data && response.data.message
        ? response.data.message
        : `HTTP ${response.status}`;

    logger(chalk.italic(` API-LOGIN: Login failed - ${errorMsg}`), "error");
    return { ok: false, message: errorMsg };

  } catch (error) {
    const errMsg = error && error.message ? error.message : String(error);
    logger(chalk.italic(` API-LOGIN: Request failed - ${errMsg}`), "error");
    return { ok: false, message: errMsg };
  }
}

async function tokensViaAPI(email, password, twoFactor = null, apiBaseUrl = null) {
  const t0 = process.hrtime.bigint();

  if (!email || !password) {
    return { status: false, message: "Please provide email and password" };
  }

  logger(chalk.italic(` API-LOGIN: Initialize login ${mask(email, 2)}`), "info");

  const res = await loginViaAPI(email, password, twoFactor, apiBaseUrl);

  if (res && res.ok) {
    logger(chalk.italic(` API-LOGIN: Login success - UID: ${res.uid}`), "info");
    const t1 = Number(process.hrtime.bigint() - t0) / 1e6;
    logger(chalk.italic(`⏱ Done API login ${Math.round(t1)}ms`), "info");

    return {
      status: true,
      cookies: res.cookies,
      uid: res.uid,
      access_token: res.access_token,
      cookie: res.cookie
    };
  }

  return {
    status: false,
    message: res && res.message ? res.message : "Login failed"
  };
}

function normalizeCookieHeaderString(s) {
  let str = String(s || "").trim();
  if (!str) return [];
  if (/^cookie\s*:/i.test(str)) str = str.replace(/^cookie\s*:/i, "").trim();
  str = str.replace(/\r?\n/g, " ").replace(/\s*;\s*/g, ";");
  const parts = str.split(";").map(v => v.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
    if (!k) continue;
    out.push(`${k}=${v}`);
  }
  return out;
}

function setJarFromPairs(j, pairs, domain) {
  const expires = new Date(Date.now() + 31536e6).toUTCString();

  const urls = [
    "https://www.facebook.com",
    "https://facebook.com",
    "https://m.facebook.com",
    "http://www.facebook.com",
    "http://facebook.com",
    "http://m.facebook.com"
  ];

  for (const kv of pairs) {
    const cookieStr = `${kv}; expires=${expires}; domain=${domain}; path=/;`;

    for (const url of urls) {
      try {
        if (typeof j.setCookieSync === "function") {
          j.setCookieSync(cookieStr, url);
        } else if (typeof j.setCookie === "function") {
          j.setCookie(cookieStr, url);
        }
      } catch (err) {

      }
    }
  }
}

function cookieHeaderFromJar(j) {
  const urls = ["https://www.facebook.com"];
  const seen = new Set();
  const parts = [];
  for (const u of urls) {
    let s = "";
    try {
      s = typeof j.getCookieStringSync === "function" ? j.getCookieStringSync(u) : "";
    } catch { }
    if (!s) continue;
    for (const kv of s.split(";")) {
      const t = kv.trim();
      const name = t.split("=")[0];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      parts.push(t);
    }
  }
  return parts.join("; ");
}

async function backupAppState(j, userID) {
  try {
    const appJson = getAppState(j);
    const ck = cookieHeaderFromJar(j);
    await appstateStore.upsertBackup(userID, "appstate", JSON.stringify(appJson));
    await appstateStore.upsertBackup(userID, "cookie", ck);
    logger("Session backup stored locally", "info");
  } catch (e) {
    logger(`Failed to save appstate backup ${e && e.message ? e.message : String(e)}`, "warn");
  }
}

async function getLatestBackup(userID, type) {
  return appstateStore.getLatestBackup(userID, type);
}

async function getLatestBackupAny(type) {
  return appstateStore.getLatestBackupAny(type);
}

async function setJarCookies(j, appstate) {
  const tasks = [];
  for (const c of appstate) {
    const cookieName = c.name || c.key;
    const cookieValue = c.value;
    if (!cookieName || cookieValue === undefined) continue;

    const cookieDomain = c.domain || ".facebook.com";
    const cookiePath = c.path || "/";
    const dom = cookieDomain.replace(/^\./, "");

    let expiresStr = "";
    const toExpiryDate = (raw) => {
      // appstate exports use UNIX SECONDS (< 1e12) or milliseconds (>= 1e12) or ISO strings.
      if (typeof raw === "number" || /^\d{9,14}$/.test(String(raw).trim())) {
        const n = Number(String(raw).trim());
        return new Date(n < 1e12 ? n * 1000 : n);
      }
      return new Date(raw);
    };
    if (c.expirationDate !== undefined && c.expirationDate !== null) {
      try {
        const expiresDate = toExpiryDate(c.expirationDate);
        if (!isNaN(expiresDate.getTime())) expiresStr = `; expires=${expiresDate.toUTCString()}`;
      } catch (_) { }
    } else if (c.expires !== undefined && c.expires !== null) {
      try {
        if (c.expires === "Infinity" || c.expires === "infinity") {
          expiresStr = "";
        } else {
          const expiresDate = toExpiryDate(c.expires);
          if (!isNaN(expiresDate.getTime())) expiresStr = `; expires=${expiresDate.toUTCString()}`;
        }
      } catch (_) { }
    }

    const buildCookieString = (domainOverride = null) => {
      const domain = domainOverride || cookieDomain;
      let cookieParts = [`${cookieName}=${cookieValue}${expiresStr}`];
      cookieParts.push(`Domain=${domain}`);
      cookieParts.push(`Path=${cookiePath}`);

      if (c.secure === true) {
        cookieParts.push("Secure");
      }

      if (c.httpOnly === true) {
        cookieParts.push("HttpOnly");
      }

      if (c.sameSite) {
        const sameSiteValue = String(c.sameSite).toLowerCase();
        if (["strict", "lax", "none"].includes(sameSiteValue)) {
          cookieParts.push(`SameSite=${sameSiteValue.charAt(0).toUpperCase() + sameSiteValue.slice(1)}`);
        }
      }

      return cookieParts.join("; ");
    };
    const cookieConfigs = [];
    if (cookieDomain === ".facebook.com" || cookieDomain === "facebook.com") {
      cookieConfigs.push({ url: `http://${dom}${cookiePath}`, cookieStr: buildCookieString() });
      cookieConfigs.push({ url: `https://${dom}${cookiePath}`, cookieStr: buildCookieString() });
      cookieConfigs.push({ url: `http://www.${dom}${cookiePath}`, cookieStr: buildCookieString() });
      cookieConfigs.push({ url: `https://www.${dom}${cookiePath}`, cookieStr: buildCookieString() });
    } else {
      cookieConfigs.push({ url: `http://${dom}${cookiePath}`, cookieStr: buildCookieString() });
      cookieConfigs.push({ url: `https://${dom}${cookiePath}`, cookieStr: buildCookieString() });
      cookieConfigs.push({ url: `http://www.${dom}${cookiePath}`, cookieStr: buildCookieString() });
      cookieConfigs.push({ url: `https://www.${dom}${cookiePath}`, cookieStr: buildCookieString() });
    }

    for (const config of cookieConfigs) {
      tasks.push(j.setCookie(config.cookieStr, config.url).catch((err) => {
        if (err && err.message && err.message.includes("Cookie not in this host's domain")) {
          return;
        }
        return;
      }));
    }
  }
  await Promise.all(tasks);
}

async function tokens(username, password, twofactor = null) {
  return tokensViaAPI(username, password, twofactor);
}

async function hydrateJarFromDB(userID, jar) {
  try {
    let ck = null;
    let app = null;
    if (userID) {
      ck = await getLatestBackup(userID, "cookie");
      app = await getLatestBackup(userID, "appstate");
    } else {
      ck = await getLatestBackupAny("cookie");
      app = await getLatestBackupAny("appstate");
    }
    if (ck) {
      const pairs = normalizeCookieHeaderString(ck);
      if (pairs.length) {
        setJarFromPairs(jar, pairs, ".facebook.com");
        return true;
      }
    }
    if (app) {
      let parsed = null;
      try {
        parsed = JSON.parse(app);
      } catch { }
      if (Array.isArray(parsed)) {
        const pairs = parsed.map(c => [c.name || c.key, c.value].join("="));
        setJarFromPairs(jar, pairs, ".facebook.com");
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function tryAutoLoginIfNeeded(currentHtml, currentCookies, globalOptions, ctxRef, hadAppStateInput = false, jar) {

  const isValidUID = uid => uid && uid !== "0" && /^\d+$/.test(uid) && parseInt(uid, 10) > 0;

  const getUID = cs =>
    cs.find(c => c.key === "i_user")?.value ||
    cs.find(c => c.key === "c_user")?.value ||
    cs.find(c => c.name === "i_user")?.value ||
    cs.find(c => c.name === "c_user")?.value;
  const htmlUID = body => {
    const s = typeof body === "string" ? body : String(body ?? "");
    return s.match(/"USER_ID"\s*:\s*"(\d+)"/)?.[1] || s.match(/\["CurrentUserInitialData",\[\],\{.*?"USER_ID":"(\d+)".*?\},\d+\]/)?.[1];
  };

  let userID = getUID(currentCookies);

  if (!isValidUID(userID)) {
    userID = htmlUID(currentHtml);
  }

  if (isValidUID(userID)) {
    return { html: currentHtml, cookies: currentCookies, userID };
  }

  logger("tryAutoLoginIfNeeded: No valid userID found, attempting recovery...", "warn");

  if (hadAppStateInput) {
    const isCheckpoint = currentHtml.includes("/checkpoint/block/?next");
    if (!isCheckpoint) {
      try {
        const refreshedCookies = await Promise.resolve(jar.getCookies("https://www.facebook.com"));
        userID = getUID(refreshedCookies);
        if (isValidUID(userID)) {
          return { html: currentHtml, cookies: refreshedCookies, userID };
        }
      } catch { }
    }
  }

  const hydrated = await hydrateJarFromDB(null, jar);
  if (hydrated) {
    logger("tryAutoLoginIfNeeded: Trying backup from DB...", "info");
    try {
      const initial = await get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
      const resB = (await ctxRef.bypassAutomation(initial, jar)) || initial;
      const htmlB = resB && resB.data ? resB.data : "";
      if (!htmlB.includes("/checkpoint/block/?next")) {
        const htmlUserID = htmlUID(htmlB);
        if (isValidUID(htmlUserID)) {
          const cookiesB = await Promise.resolve(jar.getCookies("https://www.facebook.com"));
          logger(`tryAutoLoginIfNeeded: DB backup session valid, USER_ID=${htmlUserID}`, "info");
          return { html: htmlB, cookies: cookiesB, userID: htmlUserID };
        } else {
          logger(`tryAutoLoginIfNeeded: DB backup session dead (HTML USER_ID=${htmlUserID || "empty"}), will try API login...`, "warn");
        }
      }
    } catch (dbErr) {
      logger(`tryAutoLoginIfNeeded: DB backup failed - ${dbErr && dbErr.message ? dbErr.message : String(dbErr)}`, "warn");
    }
  }

  if (config.autoLogin === false || config.autoLogin === "false") {
    throw new Error("AppState expired — Auto-login is disabled");
  }

  const u = config.credentials?.email || config.email;
  const p = config.credentials?.password || config.password;
  const tf = config.credentials?.twofactor || config.twofactor || null;

  if (!u || !p) {
    logger("tryAutoLoginIfNeeded: No credentials configured for auto-login!", "error");
    throw new Error("Missing credentials for auto-login (email/password not configured in fca-config.json)");
  }

  logger(`tryAutoLoginIfNeeded: Attempting API login for ${u.slice(0, 3)}***...`, "info");

  const r = await tokens(u, p, tf);
  if (!r || !r.status) {
    throw new Error(r && r.message ? r.message : "API Login failed");
  }

  logger(`tryAutoLoginIfNeeded: API login successful! UID: ${r.uid}`, "info");

  let cookiePairs = [];

  if (typeof r.cookies === "string") {
    cookiePairs = normalizeCookieHeaderString(r.cookies);
  }

  else if (Array.isArray(r.cookies)) {
    cookiePairs = r.cookies.map(c => {
      if (typeof c === "string") {

        return c;
      } else if (c && typeof c === "object") {

        return `${c.key || c.name}=${c.value}`;
      }
      return null;
    }).filter(Boolean);
  }

  if (cookiePairs.length === 0 && r.cookie) {
    if (typeof r.cookie === "string") {
      cookiePairs = normalizeCookieHeaderString(r.cookie);
    } else if (Array.isArray(r.cookie)) {
      cookiePairs = r.cookie.map(c => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") return `${c.key || c.name}=${c.value}`;
        return null;
      }).filter(Boolean);
    }
  }

  if (cookiePairs.length === 0) {
    logger("tryAutoLoginIfNeeded: No cookies found in API response", "warn");
    throw new Error("API login returned no cookies");
  } else {
    logger(`tryAutoLoginIfNeeded: Parsed ${cookiePairs.length} cookies from API response`, "info");
    setJarFromPairs(jar, cookiePairs, ".facebook.com");
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  let html2 = "";
  let res2 = null;
  let retryCount = 0;
  const maxRetries = 3;
  const urlsToTry = ["https://m.facebook.com/", "https://www.facebook.com/"];

  while (retryCount < maxRetries) {
    try {

      const urlToUse = retryCount === 0 ? urlsToTry[0] : urlsToTry[retryCount % urlsToTry.length];
      logger(`tryAutoLoginIfNeeded: Refreshing ${urlToUse} (attempt ${retryCount + 1}/${maxRetries})...`, "info");

      const initial2 = await get(urlToUse, jar, null, globalOptions).then(saveCookies(jar));
      res2 = (await ctxRef.bypassAutomation(initial2, jar)) || initial2;
      html2 = res2 && res2.data ? res2.data : "";

      if (html2.includes("/checkpoint/block/?next")) {
        throw new Error("Checkpoint after API login");
      }

      const htmlUserID = htmlUID(html2);
      if (isValidUID(htmlUserID)) {
        logger(`tryAutoLoginIfNeeded: Found valid USER_ID in HTML from ${urlToUse}: ${htmlUserID}`, "info");
        break;
      }

      if (retryCount < maxRetries - 1) {
        logger(`tryAutoLoginIfNeeded: No valid USER_ID in HTML from ${urlToUse} (attempt ${retryCount + 1}/${maxRetries}), retrying...`, "warn");
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        retryCount++;
      } else {
        logger("tryAutoLoginIfNeeded: No valid USER_ID found in HTML after retries", "warn");
        break;
      }
    } catch (err) {
      if (err.message && err.message.includes("Checkpoint")) {
        throw err;
      }
      if (retryCount < maxRetries - 1) {
        logger(`tryAutoLoginIfNeeded: Error refreshing page (attempt ${retryCount + 1}/${maxRetries}): ${err && err.message ? err.message : String(err)}`, "warn");
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        retryCount++;
      } else {
        throw err;
      }
    }
  }

  const cookies2 = await Promise.resolve(jar.getCookies("https://www.facebook.com"));
  const uid2 = getUID(cookies2);
  const htmlUserID2 = htmlUID(html2);

  let finalUID = null;
  if (isValidUID(htmlUserID2)) {
    finalUID = htmlUserID2;
    logger(`tryAutoLoginIfNeeded: Using USER_ID from HTML: ${finalUID}`, "info");
  } else if (isValidUID(uid2)) {
    finalUID = uid2;
    logger(`tryAutoLoginIfNeeded: Using USER_ID from cookies: ${finalUID}`, "info");
  } else if (isValidUID(r.uid)) {
    finalUID = r.uid;
    logger(`tryAutoLoginIfNeeded: Using USER_ID from API response: ${finalUID}`, "info");
  }

  if (!isValidUID(finalUID)) {
    logger(`tryAutoLoginIfNeeded: HTML check - USER_ID from HTML: ${htmlUserID2 || "none"}, from cookies: ${uid2 || "none"}, from API: ${r.uid || "none"}`, "error");
    throw new Error("Login failed - could not get valid userID after API login. HTML may indicate session is not established.");
  }

  if (!isValidUID(htmlUserID2)) {
    logger("tryAutoLoginIfNeeded: WARNING - HTML does not show valid USER_ID, but proceeding with cookie-based UID", "warn");
  }

  return { html: html2, cookies: cookies2, userID: finalUID };
}

function makeLogin(j, email, password, globalOptions) {
  return async function () {
    const u = email || config.credentials?.email;
    const p = password || config.credentials?.password;
    const tf = config.credentials?.twofactor || null;
    if (!u || !p) return;
    const r = await tokens(u, p, tf);
    if (r && r.status && Array.isArray(r.cookies)) {
      const pairs = r.cookies.map(c => `${c.key || c.name}=${c.value}`);
      setJarFromPairs(j, pairs, ".facebook.com");
      await get("https://www.facebook.com/", j, null, globalOptions).then(saveCookies(j));
    } else {
      throw new Error(r && r.message ? r.message : "Login failed");
    }
  };
}

function loginHelper(appState, Cookie, email, password, globalOptions, callback) {
  try {

    const jar = new CookieJar();
    const domain = ".facebook.com";

    const extractUIDFromAppState = (appStateInput) => {
      if (!appStateInput) return null;
      let parsed = appStateInput;
      if (typeof appStateInput === "string") {
        try {
          parsed = JSON.parse(appStateInput);
        } catch {
          return null;
        }
      }
      if (Array.isArray(parsed)) {
        const cUser = parsed.find(c => (c.key === "c_user" || c.name === "c_user"));
        if (cUser) return cUser.value;
        const iUser = parsed.find(c => (c.key === "i_user" || c.name === "i_user"));
        if (iUser) return iUser.value;
      }
      return null;
    };
    let userIDFromAppState = extractUIDFromAppState(appState);
    (async () => {
      try {

        try {
          const lk = require("../src/utils/instanceLock").acquire(userIDFromAppState);
          if (!lk.ok) {
            return callback(new Error("Another bot process is already running this account (pid " + lk.pid + "). Refusing to start a second session. Set FCA_NX_INSTANCE_LOCK=off to disable."));
          }
        } catch (_) {}

        try {
          const ipRes = await require("../src/utils/ipGuard").checkLoginIP(require("../src/utils/request").client, userIDFromAppState);
          if (!ipRes.ok) {
            return callback(new Error("Login refused: public IP changed (" + ipRes.previous + " -> " + ipRes.ip + ") and FCA_NX_IP_GUARD=block"));
          }
        } catch (_) {   }
        if (appState) {

          if (Array.isArray(appState) && appState.some(c => c.name)) {

            appState = appState.map(c => {
              if (c.name && !c.key) {
                c.key = c.name;
                delete c.name;
              }
              return c;
            });
          } else if (typeof appState === "string") {

            let parsed = appState;
            try {
              parsed = JSON.parse(appState);
            } catch { }

            if (Array.isArray(parsed)) {

              appState = parsed;
            } else {

              const arrayAppState = [];
              appState.split(';').forEach(c => {
                const [key, value] = c.split('=');
                if (key && value) {
                  arrayAppState.push({
                    key: key.trim(),
                    value: value.trim(),
                    domain: ".facebook.com",
                    path: "/",
                    expires: new Date().getTime() + 1000 * 60 * 60 * 24 * 365
                  });
                }
              });
              appState = arrayAppState;
            }
          }

          if (Array.isArray(appState)) {
            await setJarCookies(jar, appState);
          } else {
            throw new Error("Invalid appState format");
          }
        }
        if (Cookie) {
          let cookiePairs = [];
          if (typeof Cookie === "string") cookiePairs = normalizeCookieHeaderString(Cookie);
          else if (Array.isArray(Cookie)) cookiePairs = Cookie.map(String).filter(Boolean);
          else if (Cookie && typeof Cookie === "object") cookiePairs = Object.entries(Cookie).map(([k, v]) => `${k}=${v}`);
          if (cookiePairs.length) setJarFromPairs(jar, cookiePairs, domain);
        }
      } catch (e) {
        return callback(e);
      }
      const ctx = { globalOptions, options: globalOptions, reconnectAttempts: 0 };
      ctx.bypassAutomation = async function (resp, j) {
        global.fca = global.fca || {};
        global.fca.BypassAutomationNotification = this.bypassAutomation.bind(this);
        const s = x => (typeof x === "string" ? x : String(x ?? ""));
        const u = r => r?.request?.res?.responseUrl || (r?.config?.baseURL ? new URL(r.config.url || "/", r.config.baseURL).toString() : r?.config?.url || "");
        const isCp = r => typeof u(r) === "string" && u(r).includes("checkpoint/601051028565049");
        const cookieUID = async () => {
          try {
            const cookies = typeof j?.getCookies === "function" ? await j.getCookies("https://www.facebook.com") : [];
            return cookies.find(c => c.key === "i_user")?.value || cookies.find(c => c.key === "c_user")?.value;
          } catch { return undefined; }
        };
        const htmlUID = body => s(body).match(/"USER_ID"\s*:\s*"(\d+)"/)?.[1] || s(body).match(/\["CurrentUserInitialData",\[\],\{.*?"USER_ID":"(\d+)".*?\},\d+\]/)?.[1];
        const getUID = async body => (await cookieUID()) || htmlUID(body);
        const refreshJar = async () => get("https://www.facebook.com/", j, null, this.options).then(saveCookies(j));
        const bypass = async body => {
          const b = s(body);
          const UID = await getUID(b);
          const fb_dtsg = getFrom(b, '"DTSGInitData",[],{"token":"', '",') || b.match(/name="fb_dtsg"\s+value="([^"]+)"/)?.[1];
          const jazoest = getFrom(b, 'name="jazoest" value="', '"') || getFrom(b, "jazoest=", '",') || b.match(/name="jazoest"\s+value="([^"]+)"/)?.[1];
          const lsd = getFrom(b, '["LSD",[],{"token":"', '"}') || b.match(/name="lsd"\s+value="([^"]+)"/)?.[1];
          const form = { av: UID, fb_dtsg, jazoest, lsd, fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: "FBScrapingWarningMutation", variables: "{}", server_timestamps: true, doc_id: 6339492849481770 };
          await post("https://www.facebook.com/api/graphql/", j, form, null, this.options).then(saveCookies(j));
          logger(" Facebook automation detected — bypassing...", "warn");
          this.reconnectAttempts = 0;
        };
        try {
          if (resp) {
            if (isCp(resp)) {
              await bypass(s(resp.data));
              const refreshed = await refreshJar();
              if (isCp(refreshed)) logger("Checkpoint still present after refresh", "warn");
              else logger(" Bypass complete — session restored.", "info");
              return refreshed;
            }
            return resp;
          }
          const first = await get("https://www.facebook.com/", j, null, this.options).then(saveCookies(j));
          if (isCp(first)) {
            await bypass(s(first.data));
            const refreshed = await refreshJar();
            if (!isCp(refreshed)) logger(" Bypass complete — session restored.", "info");
            else logger("Checkpoint still present after refresh", "warn");
            return refreshed;
          }
          return first;
        } catch (e) {
          logger(`Bypass automation error: ${e && e.message ? e.message : String(e)}`, "error");
          return resp;
        }
      };
      if (appState || Cookie) {
        const initial = await get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
        return (await ctx.bypassAutomation(initial, jar)) || initial;
      }
      const hydrated = await hydrateJarFromDB(null, jar);
      if (hydrated) {
        logger(chalk.italic(" AppState backup found — restoring session..."), "info");
        const initial = await get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
        return (await ctx.bypassAutomation(initial, jar)) || initial;
      }
      logger(chalk.italic(" AppState expired — logging in with credentials..."), "warn");
      return get("https://www.facebook.com/", null, null, globalOptions)
        .then(saveCookies(jar))
        .then(makeLogin(jar, email, password, globalOptions))
        .then(function () {
          return get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
        });
    })()
      .then(async function (res) {
        const ctx = {};
        ctx.options = globalOptions;
        ctx.bypassAutomation = async function (resp, j) {
          global.fca = global.fca || {};
          global.fca.BypassAutomationNotification = this.bypassAutomation.bind(this);
          const s = x => (typeof x === "string" ? x : String(x ?? ""));
          const u = r => r?.request?.res?.responseUrl || (r?.config?.baseURL ? new URL(r.config.url || "/", r.config.baseURL).toString() : r?.config?.url || "");
          const isCp = r => typeof u(r) === "string" && u(r).includes("checkpoint/601051028565049");
          const cookieUID = async () => {
            try {
              const cookies = typeof j?.getCookies === "function" ? await j.getCookies("https://www.facebook.com") : [];
              return cookies.find(c => c.key === "i_user")?.value || cookies.find(c => c.key === "c_user")?.value;
            } catch { return undefined; }
          };
          const htmlUID = body => s(body).match(/"USER_ID"\s*:\s*"(\d+)"/)?.[1] || s(body).match(/\["CurrentUserInitialData",\[\],\{.*?"USER_ID":"(\d+)".*?\},\d+\]/)?.[1];
          const getUID = async body => (await cookieUID()) || htmlUID(body);
          const refreshJar = async () => get("https://www.facebook.com/", j, null, this.options).then(saveCookies(j));
          const bypass = async body => {
            const b = s(body);
            const UID = await getUID(b);
            const fb_dtsg = getFrom(b, '"DTSGInitData",[],{"token":"', '",') || b.match(/name="fb_dtsg"\s+value="([^"]+)"/)?.[1];
            const jazoest = getFrom(b, 'name="jazoest" value="', '"') || getFrom(b, "jazoest=", '",') || b.match(/name="jazoest"\s+value="([^"]+)"/)?.[1];
            const lsd = getFrom(b, '["LSD",[],{"token":"', '"}') || b.match(/name="lsd"\s+value="([^"]+)"/)?.[1];
            const form = { av: UID, fb_dtsg, jazoest, lsd, fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: "FBScrapingWarningMutation", variables: "{}", server_timestamps: true, doc_id: 6339492849481770 };
            await post("https://www.facebook.com/api/graphql/", j, form, null, this.options).then(saveCookies(j));
            logger(" Facebook automation detected — bypassing...", "warn");
          };
          try {
            if (res && isCp(res)) {
              await bypass(s(res.data));
              const refreshed = await refreshJar();
              if (!isCp(refreshed)) logger(" Bypass complete — session restored.", "info");
              return refreshed;
            }
            logger(" No checkpoint detected — session is clean.", "info");
            return res;
          } catch {
            return res;
          }
        };
        const processed = (await ctx.bypassAutomation(res, jar)) || res;
        let html = processed && processed.data ? processed.data : "";
        let cookies = await Promise.resolve(jar.getCookies("https://www.facebook.com"));
        const getUIDFromCookies = cs =>
          cs.find(c => c.key === "i_user")?.value ||
          cs.find(c => c.key === "c_user")?.value ||
          cs.find(c => c.name === "i_user")?.value ||
          cs.find(c => c.name === "c_user")?.value;
        const getUIDFromHTML = body => {
          const s = typeof body === "string" ? body : String(body ?? "");
          return s.match(/"USER_ID"\s*:\s*"(\d+)"/)?.[1] || s.match(/\["CurrentUserInitialData",\[\],\{.*?"USER_ID":"(\d+)".*?\},\d+\]/)?.[1];
        };

        const isValidUID = uid => uid && uid !== "0" && /^\d+$/.test(uid) && parseInt(uid, 10) > 0;

        let userID = getUIDFromCookies(cookies);

        if (!isValidUID(userID)) {
          userID = getUIDFromHTML(html);
        }

        if (!isValidUID(userID) && userIDFromAppState && isValidUID(userIDFromAppState)) {
          userID = userIDFromAppState;
        }

        if (!isValidUID(userID)) {
          logger("Invalid userID detected (missing or 0), attempting auto-login...", "warn");

          const retried = await tryAutoLoginIfNeeded(html, cookies, globalOptions, ctx, !!(appState || Cookie), jar);
          html = retried.html;
          cookies = retried.cookies;
          userID = retried.userID;

          const htmlUserIDAfterLogin = getUIDFromHTML(html);
          if (!isValidUID(htmlUserIDAfterLogin)) {
            logger("After auto-login, HTML still does not contain valid USER_ID. Session may not be established.", "error");

            try {
              const refreshRes = await get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
              const refreshedHtml = refreshRes && refreshRes.data ? refreshRes.data : "";
              const refreshedHtmlUID = getUIDFromHTML(refreshedHtml);
              if (isValidUID(refreshedHtmlUID)) {
                html = refreshedHtml;
                userID = refreshedHtmlUID;
                logger(`After refresh, found valid USER_ID in HTML: ${userID}`, "info");
              } else {
                throw new Error("Login failed - HTML does not show valid USER_ID after auto-login and refresh");
              }
            } catch (refreshErr) {
              throw new Error(`Login failed - Could not establish valid session. HTML USER_ID check failed: ${refreshErr && refreshErr.message ? refreshErr.message : String(refreshErr)}`);
            }
          } else {

            userID = htmlUserIDAfterLogin;
            logger(`After auto-login, using USER_ID from HTML: ${userID}`, "info");
          }
        }
        if (html.includes("/checkpoint/block/?next")) {
          logger(chalk.italic(" Session expired! Please update your appstate."), "error");
          throw new Error("Checkpoint");
        }

        let finalHtmlUID = getUIDFromHTML(html);
        if (!isValidUID(finalHtmlUID)) {

          if (isValidUID(userID)) {
            logger(`HTML shows USER_ID=${finalHtmlUID || "none"} but cookies have valid UID=${userID}. Attempting to activate session...`, "warn");

            try {

              await new Promise(resolve => setTimeout(resolve, 1000));

              logger("Trying to activate session via m.facebook.com/home.php...", "info");
              const activateRes = await get("https://m.facebook.com/home.php", jar, null, globalOptions).then(saveCookies(jar));
              const activateHtml = activateRes && activateRes.data ? activateRes.data : "";
              const activateUID = getUIDFromHTML(activateHtml);

              if (isValidUID(activateUID)) {
                html = activateHtml;
                finalHtmlUID = activateUID;
                userID = activateUID;
                logger(`Session activated! Found valid USER_ID in HTML: ${userID}`, "info");
              } else {

                await new Promise(resolve => setTimeout(resolve, 1500));
                logger("Trying to activate session via www.facebook.com/home.php...", "info");
                const activateRes2 = await get("https://www.facebook.com/home.php", jar, null, globalOptions).then(saveCookies(jar));
                const activateHtml2 = activateRes2 && activateRes2.data ? activateRes2.data : "";
                const activateUID2 = getUIDFromHTML(activateHtml2);

                if (isValidUID(activateUID2)) {
                  html = activateHtml2;
                  finalHtmlUID = activateUID2;
                  userID = activateUID2;
                  logger(`Session activated on second try! Found valid USER_ID in HTML: ${userID}`, "info");
                } else {

                  logger(`WARNING: HTML still shows USER_ID=${finalHtmlUID || "none"} but cookies have valid UID=${userID}. Proceeding with cookie-based UID.`, "warn");

                }
              }
            } catch (activateErr) {
              logger(`Failed to activate session: ${activateErr && activateErr.message ? activateErr.message : String(activateErr)}. Proceeding with cookie-based UID.`, "warn");

            }
          } else {

            logger(`Final HTML validation failed - USER_ID from HTML: ${finalHtmlUID || "none"}, from cookies: ${userID || "none"}`, "error");
            throw new Error("Login validation failed - HTML does not contain valid USER_ID. Session may not be properly established.");
          }
        }

        if (!isValidUID(userID)) {
          logger(`No valid USER_ID found - HTML: ${finalHtmlUID || "none"}, Cookies: ${userID || "none"}`, "error");
          throw new Error("Login validation failed - No valid USER_ID found in HTML or cookies.");
        }
        let mqttEndpoint;
        let region = "PRN";
        let fb_dtsg;
        let irisSeqID;
        try {
          const m1 = html.match(/"endpoint":"([^"]+)"/);
          const m2 = m1 ? null : html.match(/endpoint\\":\\"([^\\"]+)\\"/);
          const raw = (m1 && m1[1]) || (m2 && m2[1]);
          if (raw) mqttEndpoint = raw.replace(/\\\//g, "/");
          region = parseRegion(html);
          const rinfo = REGION_MAP.get(region);
          if (rinfo) logger(`Server region ${region} - ${rinfo.name}`, "info");
          else logger(`Server region ${region}`, "info");
        } catch {
          logger("Not MQTT endpoint", "warn");
        }
        try {
          const userDataMatch = String(html).match(/\["CurrentUserInitialData",\[\],({.*?}),\d+\]/);
          if (userDataMatch) {
            const info = JSON.parse(userDataMatch[1]);
            logger(` Logged in as: ${info.NAME} (${info.USER_ID})`, "info");

            if (!isValidUID(info.USER_ID)) {
              logger("Facebook response shows invalid USER_ID (0 or empty), session is dead!", "warn");

              const retried = await tryAutoLoginIfNeeded(html, cookies, globalOptions, ctx, !!(appState || Cookie), jar);
              html = retried.html;
              cookies = retried.cookies;
              userID = retried.userID;

              if (!isValidUID(userID)) {
                throw new Error("Auto-login failed - could not get valid userID");
              }
            }
          } else if (userID) {
            logger(`ID người dùng: ${userID}`, "info");
          }
        } catch (userDataErr) {

          if (userDataErr && userDataErr.message && userDataErr.message.includes("Auto-login failed")) {
            throw userDataErr;
          }

        }
        const tokenMatch = html.match(/DTSGInitialData.*?token":"(.*?)"/);
        if (tokenMatch) fb_dtsg = tokenMatch[1];
        try {
          if (userID) await backupAppState(jar, userID);
        } catch { }
        logger(chalk.italic(" bun-fca | unified Facebook Messenger engine"), "info");
        const emitter = new EventEmitter();
        const ctxMain = {
          userID,
          jar,
          globalOptions,
          loggedIn: true,
          access_token: "NONE",
          clientMutationId: 0,
          mqttClient: undefined,
          lastSeqId: irisSeqID,
          syncToken: undefined,
          mqttEndpoint,
          region,
          firstListen: true,
          fb_dtsg,
          clientID: ((Math.random() * 2147483648) | 0).toString(16),

          clientId: getFrom(html, '["MqttWebDeviceID",[],{"clientID":"', '"}') || ((""+Math.random()).slice(2)+Date.now().toString(16)).slice(0, 16),
          wsReqNumber: 0,
          wsTaskNumber: 0,
          tasks: new Map(),
          _emitter: emitter
        };
        ctxMain.options = globalOptions;
        ctxMain.bypassAutomation = ctx.bypassAutomation.bind(ctxMain);
        ctxMain.performAutoLogin = async () => {
          try {

            try {

              let stillCheckpointed = true;
              let uid = null;
              for (let attempt = 0; attempt < 3 && !uid; attempt++) {
                try {
                  const check = await get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
                  const html = check && check.data ? String(check.data) : "";
                  stillCheckpointed = html.includes("/checkpoint/block/?next") || html.includes("XCheckpointFBScrapingWarningController");
                  const uidMatch = html.match(/"USER_ID"\s*:\s*"(\d+)"/);
                  if (!stillCheckpointed && uidMatch && uidMatch[1] && uidMatch[1] !== "0") {
                    uid = uidMatch[1];
                    break;
                  }
                } catch {

                }
                if (!uid && attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
              }
              if (uid) {
                logger("performAutoLogin: existing cookie session is still valid, continuing without re-login", "info");
                return true;
              }
            } catch {

            }

            const u = config.credentials?.email || email;
            const p = config.credentials?.password || password;
            const tf = config.credentials?.twofactor || null;
            if (!u || !p) return false;

            const cdMs = (Number(process.env.FCA_NX_RELOGIN_COOLDOWN_MIN) || 30) * 60 * 1000;
            const sinceLast = Date.now() - (global.__fcaLastCredLogin || 0);
            if (sinceLast < cdMs) {
              logger("performAutoLogin: credential login skipped (cooldown " + Math.ceil((cdMs - sinceLast) / 60000) + " min left) to avoid repeated-login restrictions", "warn");
              return false;
            }
            global.__fcaLastCredLogin = Date.now();
            const r = await tokens(u, p, tf);
            if (!(r && r.status && Array.isArray(r.cookies))) return false;
            const pairs = r.cookies.map(c => `${c.key || c.name}=${c.value}`);
            setJarFromPairs(jar, pairs, ".facebook.com");
            await get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
            return true;
          } catch {
            return false;
          }
        };
        const api = {
          setOptions: require("./options").setOptions.bind(null, globalOptions),
          setSendDelay: require("../src/utils/sendThrottle").setSendDelay,
          getCookies: function () {
            return cookieHeaderFromJar(jar);
          },
          getAppState: function () {
            return getAppState(jar);
          },
          getLatestAppStateFromDB: async function (uid = userID) {
            const data = await getLatestBackup(uid, "appstate");
            return data ? JSON.parse(data) : null;
          },
          getLatestCookieFromDB: async function (uid = userID) {
            return await getLatestBackup(uid, "cookie");
          },
          on: emitter.on.bind(emitter),
          once: emitter.once.bind(emitter),
          off: emitter.removeListener.bind(emitter),
          removeAllListeners: emitter.removeAllListeners.bind(emitter)
        };
        const defaultFuncs = makeDefaults(html, userID, ctxMain);

        // SunkenBot compat: expose ctx + defaultFuncs on the api object so host
        // integrations (fcaCompat aliases _ctx/_defaultFuncs, session keep-alive,
        // MQTT health via ctx.mqttClient) keep working after switching libraries.
        api.ctx = ctxMain;
        api.defaultFuncs = defaultFuncs;

        ctxMain._touchSessionBackup = (() => {
          let lastTouch = 0;
          return async (msg) => {
            try {
              if (!msg || !msg.threadID) return;
              const now = Date.now();
              if (now - lastTouch < 10 * 60 * 1000) return;
              lastTouch = now;
              await backupAppState(ctxMain.jar, ctxMain.userID);
            } catch (_) { }
          };
        })();
        const srcRoot = path.join(__dirname, "../src/api");
        let loaded = 0;
        let skipped = 0;
        fs.readdirSync(srcRoot, { withFileTypes: true }).forEach((sub) => {
          if (!sub.isDirectory()) return;
          const subDir = path.join(srcRoot, sub.name);
          fs.readdirSync(subDir, { withFileTypes: true }).forEach((entry) => {
            if (!entry.isFile() || !entry.name.endsWith(".js")) return;
            const p = path.join(subDir, entry.name);
            const key = path.basename(entry.name, ".js");
            if (api[key]) {
              skipped++;
              return;
            }
            let mod;
            try {
              mod = require(p);
            } catch (e) {
              logger(`Failed to require API module ${p}: ${e && e.message ? e.message : String(e)}`, "warn");
              skipped++;
              return;
            }
            const factory = typeof mod === "function" ? mod : (mod && typeof mod.default === "function" ? mod.default : null);
            if (!factory) {
              logger(`API module ${p} does not export a function, skipping`, "warn");
              skipped++;
              return;
            }
            api[key] = factory(defaultFuncs, api, ctxMain);
            loaded++;
          });
        });
        logger(`Loaded ${loaded} FCA API methods${skipped ? `, skipped ${skipped} duplicates` : ""}`);
        if (api.listenMqtt) {
          api._listenMqttRaw = api.listenMqtt;
          api.listen = api.listenMqtt;
        }
        if (api.refreshFb_dtsg) {

          setInterval(function () {
            api.refreshFb_dtsg().then(function () {
              logger("Successfully refreshed fb_dtsg");
            }).catch(function (e) {
              logger("An error occurred while refreshing fb_dtsg: " + (e && e.message ? e.message : e), "error");
            });
          }, 6 * 60 * 60 * 1000);

          (function keepaliveLoop() {
            const t = setTimeout(function () {
              try {
                const { get } = require("../src/utils/request");
                const { saveCookies } = require("../src/utils/client");
                if (ctxMain && ctxMain.jar && !ctxMain._ending) {
                  get("https://www.facebook.com/", ctxMain.jar, null, ctxMain.globalOptions, ctxMain)
                    .then(saveCookies(ctxMain.jar))
                    .then(function () { logger("session keepalive ok", "debug"); })
                    .catch(function (e) {
                      logger("session keepalive failed: " + (e && e.message ? e.message : e), "warn");
                    });
                }
              } catch (_) {}
              keepaliveLoop();
            }, (18 + Math.random() * 14) * 60 * 1000);
            if (t.unref) t.unref();
          })();
        }

        try {
          api.sessionGuard = require("../src/api/messaging/sessionGuard")(defaultFuncs, api, ctxMain);
        } catch (e) {
          logger(`sessionGuard init failed (non-fatal): ${e && e.message ? e.message : String(e)}`, "warn");
        }

        try {
          api.sendBroadcast = require("../src/api/messaging/sendBroadcast")(defaultFuncs, api, ctxMain);
        } catch (e) {
          logger(`sendBroadcast init failed (non-fatal): ${e && e.message ? e.message : String(e)}`, "warn");
        }

        try {
          const fcanxSendMsg = require("../src/api/socket/sendMessage")(defaultFuncs, api, ctxMain);
          api.sendMessage = fcanxSendMsg;
          api.sendMessageMqtt = require("../src/api/socket/sendMessageMqtt")(defaultFuncs, api, ctxMain);
          api.OldMessage = require("../src/api/socket/OldMessage")(defaultFuncs, api, ctxMain);
          // [مصحّح وفق donyst 2026-05] sendMessageDM كان يوجّه إلى OldMessage (/messaging/send/)
          // الذي أزالته فيسبوك (404 دائماً). المحادثات الفردية تُرسل عبر MQTT مثل بقية الرسائل،
          // وapi.sendMessage يكتشف نوع المحادثة ويستخدم جسر E2EE تلقائياً عند توفره.
          api.sendMessageDM = (msg, threadID, cb, replyTo) => api.sendMessage(msg, threadID, cb, replyTo, true);
        } catch (e) {
          logger(`sendMessage override failed (non-fatal): ${e && e.message ? e.message : String(e)}`, "warn");
        }

        try {
          const stableListenMqtt = require("../src/api/socket/listenMqtt")(defaultFuncs, api, ctxMain);
          api._listenMqttRaw = stableListenMqtt;
          api.listenMqtt = api.listen = stableListenMqtt;
        } catch (e) {
          logger(`listenMqtt override failed (non-fatal): ${e && e.message ? e.message : String(e)}`, "warn");
        }

        try {
          const { checkForUpdate } = require("../src/utils/versionCheck");
          checkForUpdate(logger);
        } catch (_) {}
        logger(chalk.italic(" Login successful! Bot is ready."));
        callback(null, api);
      })
      .catch(function (e) {
        callback(e);
      });
  } catch (e) {
    callback(e);
  }
}

module.exports = loginHelper;
module.exports.loginHelper = loginHelper;
module.exports.tokensViaAPI = tokensViaAPI;
module.exports.loginViaAPI = loginViaAPI;
module.exports.tokens = tokens;
module.exports.normalizeCookieHeaderString = normalizeCookieHeaderString;
module.exports.setJarFromPairs = setJarFromPairs;