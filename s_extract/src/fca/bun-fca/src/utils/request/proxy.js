"use strict";

let warned = false;
let undiciProxyAgent = null;
let undiciLoaded = false;

const dispatcherCache = new Map();

async function loadUndiciProxyAgent() {
  if (undiciLoaded) return undiciProxyAgent;
  undiciLoaded = true;
  try {

    const mod = await Promise.resolve().then(() => require("undici"));
    undiciProxyAgent = mod && mod.ProxyAgent ? mod.ProxyAgent : null;
  } catch (_) {
    undiciProxyAgent = null;
  }
  return undiciProxyAgent;
}

function getDispatcherForProxy(proxyUrl) {
  const key = proxyUrl || "";
  if (!key) return undefined;
  if (dispatcherCache.has(key)) return dispatcherCache.get(key);

  const ProxyAgent = undiciProxyAgent;
  if (!ProxyAgent) {
    if (!warned) {
      warned = true;
      try {
        const logger = require("../../../func/logger");
        logger(
          "proxy requested but `undici` is not installed — install it (`npm i undici`) to enable proxy support on Node. On Bun, native proxy handling is used automatically.",
          "warn"
        );
      } catch (_) { }
    }
    return undefined;
  }
  const dispatcher = new ProxyAgent(key);
  dispatcherCache.set(key, dispatcher);
  return dispatcher;
}

async function primeProxySupport() {
  await loadUndiciProxyAgent();
}

let globalProxyUrl = "";

function setProxy(proxyUrl) {
  globalProxyUrl = proxyUrl || "";
  primeProxySupport().catch(() => { });
}

function getGlobalProxy() {
  return globalProxyUrl;
}

module.exports = {
  getDispatcherForProxy,
  primeProxySupport,
  setProxy,
  getGlobalProxy,
};