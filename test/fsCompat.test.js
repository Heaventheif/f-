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
    await run(filePath, directory);
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

test("fsCompat uses Promise APIs by default for filesystem operations", async () => {
  await withTempFile(async (filePath, directory) => {
    await fs.writeFile(filePath, "promise-bytes");
    assert.equal(await fs.readFile(filePath, "utf8"), "promise-bytes");
    assert.deepEqual(await fs.readdir(directory), ["media.mp3"]);
    const childDirectory = await fs.mkdtemp(path.join(directory, "child-"));
    assert.equal((await fs.stat(childDirectory)).isDirectory(), true);
    const disposableFile = path.join(directory, "disposable.txt");
    await fs.writeFile(disposableFile, "temporary");
    await fs.unlink(disposableFile);
    assert.equal(await fs.pathExists(disposableFile), false);
    assert.equal(typeof fs.writeFileSync, "undefined");
    assert.equal(typeof fs.readdirSync, "undefined");
  });
});

test("fsCompat still delegates explicit callbacks to Node fs", async () => {
  await withTempFile(async (filePath) => {
    await new Promise((resolve, reject) => {
      const returned = fs.writeFile(filePath, "callback-bytes", (error) => {
        if (error) return reject(error);
        resolve();
      });
      assert.equal(returned, undefined);
    });
    assert.equal(await fs.readFile(filePath, "utf8"), "callback-bytes");
  });
});
