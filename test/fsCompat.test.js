import assert from "node:assert/strict";
import nodeFsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import fs from "../src/utils/fsCompat.js";

async function withTempFile(run) {
  const directory = await nodeFsp.mkdtemp(path.join(os.tmpdir(), "sunkenbot-fscompat-"));
  const filePath = path.join(directory, "media.mp3");
  await nodeFsp.writeFile(filePath, "audio-bytes");

  try {
    await run(filePath);
  } finally {
    await nodeFsp.rm(directory, { recursive: true, force: true });
  }
}

test("fsCompat.stat returns a Promise when no callback is supplied", async () => {
  await withTempFile(async (filePath) => {
    const stats = await fs.stat(filePath);

    assert.equal(stats.isFile(), true);
    assert.equal(stats.size, Buffer.byteLength("audio-bytes"));
  });
});

test("fsCompat.stat preserves Node callback signatures", async () => {
  await withTempFile(async (filePath) => {
    const stats = await new Promise((resolve, reject) => {
      const returned = fs.stat(filePath, { bigint: false }, (error, callbackStats) => {
        if (error) return reject(error);
        resolve(callbackStats);
      });

      assert.equal(returned, undefined);
    });

    assert.equal(stats.isFile(), true);
    assert.equal(stats.size, Buffer.byteLength("audio-bytes"));
  });
});

test("fsCompat.stat keeps the callback-only overload", async () => {
  await withTempFile(async (filePath) => {
    const stats = await new Promise((resolve, reject) => {
      fs.stat(filePath, (error, callbackStats) => {
        if (error) return reject(error);
        resolve(callbackStats);
      });
    });

    assert.equal(stats.isFile(), true);
  });
});
