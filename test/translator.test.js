import assert from "node:assert/strict";
import { test } from "bun:test";
import { randomUUID } from "node:crypto";
import { translateTextStrict } from "../src/utils/translator.js";

function restoreEnv(name, original) {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

test("all target languages use the authenticated HF Space translation API", async () => {
  const originalUrl = process.env.HF_SPACE_URL;
  const originalToken = process.env.INTERNAL_TOKEN;
  const originalFetch = globalThis.fetch;
  const arabicInput = `hello-${randomUUID()}`;
  const frenchInput = `bonjour-${randomUUID()}`;
  let requestCount = 0;

  process.env.HF_SPACE_URL = "https://kiyunhai-g.hf.space";
  process.env.INTERNAL_TOKEN = "test-internal-token";

  globalThis.fetch = async (input, options = {}) => {
    requestCount += 1;
    assert.equal(String(input), "https://kiyunhai-g.hf.space/translate");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["X-Internal-Token"], "test-internal-token");

    const body = JSON.parse(options.body);
    assert.equal(body.provider, "go-translate");
    if (body.to === "ar") {
      assert.equal(body.text, arabicInput);
      return new Response(JSON.stringify({ text: "مرحبا" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    assert.equal(body.to, "fr");
    assert.equal(body.text, frenchInput);
    return new Response(JSON.stringify({ text: "bonjour traduit" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    assert.equal(await translateTextStrict(arabicInput, "ar"), "مرحبا");
    assert.equal(await translateTextStrict(frenchInput, "fr"), "bonjour traduit");
    assert.equal(requestCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("HF_SPACE_URL", originalUrl);
    restoreEnv("INTERNAL_TOKEN", originalToken);
  }
});
