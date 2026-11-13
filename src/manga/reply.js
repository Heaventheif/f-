// Numbered-choice replies: send a list, register a reply handler for the sender.
export function formatChoices(header, labels, footer = "↩️ ردّ برقم الخيار.") {
  return `${header}\n\n${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n\n${footer}`;
}

export function parsePickNumber(text, max) {
  const m = String(text || "").replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632).trim().match(/^\d{1,2}$/);
  if (!m) return null;
  const n = Number(m[0]);
  return n >= 1 && n <= max ? n - 1 : null;
}

// Returns true if the choice prompt was registered.
export function askChoice({ api, message, event, header, labels, onPick }) {
  const body = formatChoices(header, labels);
  return new Promise((resolve) => {
    global.safeSend(
      api,
      body,
      event.threadID,
      (err, info) => {
        if (err || !info?.messageID || typeof message?.registerReply !== "function") return resolve(false);
        message.registerReply(
          info.messageID,
          { commandName: undefined },
          async ({ event: ev }) => {
            const idx = parsePickNumber(ev?.body, labels.length);
            if (idx === null) {
              await global.safeSend(api, "❗ اختيار غير صالح. أعد الأمر للمحاولة من جديد.", ev.threadID, null, ev.messageID);
              return;
            }
            await onPick(idx, ev);
          },
          event.senderID,
        );
        resolve(true);
      },
      event.messageID,
    );
  });
}
