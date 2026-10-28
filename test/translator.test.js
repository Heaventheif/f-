import assert from "node:assert/strict";
import { test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setGoogletransClientForTests, translateTextStrict } from "../src/utils/translator.js";

test("googletrans translates once, caches the result, and accepts at most 15,000 characters", async () => {
  const calls = [];
  setGoogletransClientForTests(async (text, options) => {
    calls.push({ text, options });
    return { text: `translated:${options.to}:${text}` };
  });

  try {
    const input = `hello-${randomUUID()}`;
    assert.equal(await translateTextStrict(input, "ar"), `translated:ar:${input}`);
    assert.equal(await translateTextStrict(input, "ar"), `translated:ar:${input}`);
    assert.equal(calls.length, 1, "a repeated translation should use the cache");
    assert.deepEqual(calls[0].options, { to: "ar", raw: false });

    const suffix = randomUUID();
    const boundaryText = "x".repeat(15_000 - suffix.length) + suffix;
    const boundaryResult = await translateTextStrict(boundaryText, "en");
    assert.ok(boundaryResult.startsWith("translated:en:"));
    assert.equal(calls.at(-1).text.length, 15_000);

    const callsBeforeOversize = calls.length;
    assert.equal(await translateTextStrict("x".repeat(15_001), "en"), null);
    assert.equal(calls.length, callsBeforeOversize, "oversized input must not reach googletrans");
  } finally {
    setGoogletransClientForTests();
  }
});

test("HTTP 429 opens a cooldown instead of repeatedly contacting Google", async () => {
  let calls = 0;
  setGoogletransClientForTests(async () => {
    calls += 1;
    throw {
      response: {
        status: 429,
        headers: { "retry-after": "3600" },
      },
    };
  });

  try {
    assert.equal(await translateTextStrict(`limited-${randomUUID()}`, "ar"), null);
    assert.equal(await translateTextStrict(`during-cooldown-${randomUUID()}`, "ar"), null);
    assert.equal(calls, 1, "do not send another request while the cooldown is active");
  } finally {
    setGoogletransClientForTests();
  }
});
