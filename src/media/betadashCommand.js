// Shared factory for Betadash image commands (canva, slap): rotation, fallback, labelled send, cleanup.
import fs from "../utils/fsCompat.js";
import { fetchImageWithFallback, formatProviderError } from "../utils/betadash.js";
import { KeyedMutex } from "../infra/limiter.js";
import { withTempDir, writeTmp } from "../io/tmp.js";
import { sendPayload } from "./common.js";

const rotationLock = new KeyedMutex();

// Atomic round-robin: concurrent callers each get a distinct slot (read-modify-write under a mutex).
export async function nextDesign(globalData, indexKey, designs, requested) {
  const byName = designs.find((d) => d.name === requested);
  if (byName) return byName;
  return rotationLock.run(indexKey, async () => {
    const index = Number(await globalData?.get(indexKey));
    const safe = Number.isInteger(index) && index >= 0 && index < designs.length ? index : 0;
    await globalData?.set(indexKey, (safe + 1) % designs.length);
    return designs[safe];
  });
}
// The label of the design that actually produced the image (a fallback may have won).
export const labelFor = (designs, endpoint, fallback) => designs.find((d) => d.name === endpoint)?.label || fallback;

/**
 * prepare({ event, args, parsed, design }) -> { error: string } | { candidates: [{endpoint, params}] }
 */
export function createBetadashCommand({ config, designs, indexKey, tag, parseArgs, listText, prepare }) {
  return {
    config,
    onStart: async ({ api, event, args, message, globalData }) => {
      const parsed = parseArgs(args);
      if (parsed.list) return message.reply(listText);
      const design = await nextDesign(globalData, indexKey, designs, parsed.design);
      const prep = await prepare({ event, args, parsed, design });
      if (prep.error) return message.reply(prep.error);
      try {
        const result = await fetchImageWithFallback(prep.candidates);
        const label = labelFor(designs, result.candidate.endpoint, design.label);
        await withTempDir(async (dir) => {
          const file = await writeTmp(dir, result.data, result.ext || "png");
          await sendPayload(api, event.threadID, { body: label, attachment: fs.createReadStream(file) }, event.messageID);
        }, tag);
      } catch (error) {
        console.error(`[${tag.toUpperCase()}]`, error.details || error.message);
        await message.reply(`❌ ${formatProviderError(error)}`);
      }
    },
  };
}
