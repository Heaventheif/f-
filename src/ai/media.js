// Attachment detection and safe image download for AI vision calls.
import { fetchBuffer, sniffImage } from "../net/safeFetch.js";

export const IMAGE_HOSTS = ["fbcdn.net", "facebook.com", "fbsbx.com"];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIME = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
const IMG_EXT = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];
const VID_EXT = ["mp4", "mov", "avi", "mkv", "webm"];

export function listAttachments(event) {
  return [...(event?.attachments || []), ...(event?.messageReply?.attachments || [])].filter(Boolean);
}
const attUrl = (a) =>
  a.largePreviewUrl || a.previewUrl || a.largePreviewUri || a.previewUri || a.url || a.uri || a.thumbnailUrl || a.image?.uri;
const extOf = (a) => String(a.filename || a.name || "").split(".").pop().toLowerCase();

// -> { kind: "image"|"video", url } | null
export function detectAttachment(event, { video = false } = {}) {
  for (const a of listAttachments(event)) {
    const type = String(a.type || a.attachmentType || "").toLowerCase();
    const url = attUrl(a);
    if (!url) continue;
    if (["photo", "image", "sticker", "animated_image"].includes(type)) return { kind: "image", url };
    if (video && ["video", "video_inline"].includes(type)) return { kind: "video", url };
    if (type === "file" || type === "document") {
      if (IMG_EXT.includes(extOf(a))) return { kind: "image", url };
      if (video && VID_EXT.includes(extOf(a))) return { kind: "video", url };
    }
  }
  return null;
}

// Downloads through the SSRF guard with a host allowlist and 8MB cap. Returns null on any failure.
export async function fetchImage(url, fb = fetchBuffer) {
  try {
    const buf = await fb(url, { allowHosts: IMAGE_HOSTS, maxBytes: MAX_IMAGE_BYTES, timeoutMs: 15_000, retries: 1 });
    const ext = sniffImage(buf);
    if (!ext) return null;
    const mime = MIME[ext];
    return { base64: buf.toString("base64"), mime, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
  } catch (e) {
    console.warn("[AI] image download failed:", e?.code || e?.message?.slice(0, 80));
    return null;
  }
}
