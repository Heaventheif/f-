import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadImagesWithLimit, savePinterestImage } from "../src/utils/pinterestProviders.js";

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sunken-pin-test-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("Pinterest image downloads use Promise-based writes and return saved files", async () => {
  const image = Buffer.alloc(1200, 0x5a);
  await withTempDir(async directory => {
    const files = await downloadImagesWithLimit(
      ["https://images.example/photo.png"],
      directory,
      1,
      { get: async () => ({ data: image }) },
    );
    expect(files).toHaveLength(1);
    expect(path.extname(files[0])).toBe(".png");
    expect(await readFile(files[0])).toEqual(image);
  });
});

test("Pinterest image helper saves bytes using the Promise filesystem API", async () => {
  const image = Buffer.from("valid-test-image-bytes");
  await withTempDir(async directory => {
    const file = await savePinterestImage(directory, "https://images.example/photo.webp", image);
    expect(path.extname(file)).toBe(".webp");
    expect(await readFile(file)).toEqual(image);
  });
});
