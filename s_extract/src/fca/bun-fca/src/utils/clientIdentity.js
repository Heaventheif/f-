"use strict";

const CHROME_VERSION = "131.0.6778.205";
const CHROME_MAJOR = CHROME_VERSION.split(".")[0];

const DEFAULT_IDENTITY = Object.freeze({
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`,
  acceptLanguage: "en-US,en;q=0.9,bn;q=0.8",
  secChUa: `"Chromium";v="${CHROME_MAJOR}", "Not;A=Brand";v="24", "Google Chrome";v="${CHROME_MAJOR}"`,
  secChUaMobile: "?0",
  secChUaPlatform: '"Windows"',
  secChUaArch: '"x86"',
  secChUaBitness: '"64"',
  secChUaFullVersionList: `"Chromium";v="${CHROME_VERSION}", "Not;A=Brand";v="24.0.0.0", "Google Chrome";v="${CHROME_VERSION}"`,
  secChUaPlatformVersion: '"15.0.0"'
});

function extractChromeVersion(userAgent) {
  if (typeof userAgent !== "string") return null;
  const m = userAgent.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { full: `${m[1]}.${m[2]}.${m[3]}.${m[4]}`, major: m[1] };
}

function getIdentity(customUserAgent) {
  if (!customUserAgent || customUserAgent === DEFAULT_IDENTITY.userAgent) {
    return DEFAULT_IDENTITY;
  }

  const parsed = extractChromeVersion(customUserAgent);
  if (!parsed) {

    return Object.freeze({
      userAgent: customUserAgent,
      acceptLanguage: DEFAULT_IDENTITY.acceptLanguage,
      secChUa: undefined,
      secChUaMobile: undefined,
      secChUaPlatform: undefined,
      secChUaArch: undefined,
      secChUaBitness: undefined,
      secChUaFullVersionList: undefined,
      secChUaPlatformVersion: undefined
    });
  }

  return Object.freeze({
    userAgent: customUserAgent,
    acceptLanguage: DEFAULT_IDENTITY.acceptLanguage,
    secChUa: `"Chromium";v="${parsed.major}", "Not;A=Brand";v="24", "Google Chrome";v="${parsed.major}"`,
    secChUaMobile: "?0",
    secChUaPlatform: DEFAULT_IDENTITY.secChUaPlatform,
    secChUaArch: DEFAULT_IDENTITY.secChUaArch,
    secChUaBitness: DEFAULT_IDENTITY.secChUaBitness,
    secChUaFullVersionList: `"Chromium";v="${parsed.full}", "Not;A=Brand";v="24.0.0.0", "Google Chrome";v="${parsed.full}"`,
    secChUaPlatformVersion: DEFAULT_IDENTITY.secChUaPlatformVersion
  });
}

function getSessionIdentity(ctx) {
  if (ctx && ctx._identity) return ctx._identity;
  const identity = getIdentity(ctx && ctx.globalOptions && ctx.globalOptions.userAgent);
  if (ctx) ctx._identity = identity;
  return identity;
}

module.exports = {
  CHROME_VERSION,
  DEFAULT_IDENTITY,
  getIdentity,
  getSessionIdentity
};