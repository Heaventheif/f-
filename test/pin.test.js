import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sendImageBatches } from "../src/cmds/_modules/pin.js";

async function withImages(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sunken-pin-send-test-"));
  const files = [path.join(directory, "one.jpg"), path.join(directory, "two.jpg")];
  await Promise.all(files.map(file => writeFile(file, Buffer.from("image"))));
  try {
    await run(files);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function consume(stream) {
  return new Promise((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
    stream.resume();
  });
}

test("Pinterest retries a rejected multi-image batch as individual sends", async () => {
  await withImages(async files => {
    const calls = [];
    const fakeApi = {
      async sendMessage(message) {
        calls.push(message);
        if (typeof message === "string") return;
        const streams = Array.isArray(message.attachment) ? message.attachment : [message.attachment];
        if (streams.length > 1) throw new Error("simulated attachment-count limit");
        await consume(streams[0]);
      },
    };

    const result = await sendImageBatches(fakeApi, "thread-1", files, [], { batchSize: 2, pauseMs: 0 });
    expect(result).toEqual({ sent: 2, failures: [] });
    expect(calls).toHaveLength(3);
    expect(calls.slice(1).every(call => !Array.isArray(call.attachment))).toBe(true);
  });
});

test("failed individual uploads notify the user with source links", async () => {
  await withImages(async files => {
    const messages = [];
    const fakeApi = {
      async sendMessage(message, threadID) {
        messages.push({ message, threadID });
        if (typeof message !== "string") throw new Error("simulated Facebook upload failure");
      },
    };
    const sourceUrls = ["https://source.example/image-one", "https://source.example/image-two"];

    const result = await sendImageBatches(fakeApi, "thread-1", files, sourceUrls, {
      batchSize: 2,
      pauseMs: 0,
    });

    expect(result.sent).toBe(0);
    expect(result.failures).toHaveLength(2);
    const notices = messages.filter(({ message }) => typeof message === "string");
    expect(notices).toHaveLength(1);
    expect(notices[0].threadID).toBe("thread-1");
    expect(notices[0].message).toContain("تعذّر رفع 2");
    for (const url of sourceUrls) expect(notices[0].message).toContain(url);
  });
});
