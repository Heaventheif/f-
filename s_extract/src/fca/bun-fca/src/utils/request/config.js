"use strict";

const { sanitizeHeaders } = require("./sanitize");
const { jar, client } = require("./client");
const { getDispatcherForProxy } = require("./proxy");

function cfg(base = {}) {
  const { reqJar, headers, params, agent, timeout, proxyUrl } = base;

  const dispatcher = agent || getDispatcherForProxy(proxyUrl);
  return {
    headers: sanitizeHeaders(headers),
    params,
    jar: reqJar || jar,
    timeout: timeout || 60000,
    dispatcher: dispatcher || undefined,
    proxy: (!dispatcher && proxyUrl) || undefined,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 600
  };
}

module.exports = {
  cfg,
};