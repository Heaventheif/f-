"use strict";

const TEXT_EFFECTS = Object.freeze({
  hearts: "1",
  heart: "1",
  love: "1",
  gift: "2",
  present: "2",
  box: "2",
  giftbox: "2",
  fire: "3",
  flame: "3",
  hot: "3",
  confetti: "4",
  confecti: "4",
  party: "4",
  celebrate: "4",
  celebration: "4",
  sparkles: "5",
  sparkle: "5",
  star: "5",
  stars: "5",
  magic: "5"
});

const EFFECT_PROPERTIES = [
  "textEffect",
  "text_effect",
  "text_effect_id",
  "textEffectId",
  "textEffectID",
  "effect",
  "effect_id",
  "effectID",
  "text_effect_name",
  "effectName",
  "effect_name"
];

function toTextEffectId(effect) {
  if (effect === null || effect === undefined) return null;
  if (typeof effect === "number" && Number.isFinite(effect)) return String(effect);
  if (typeof effect !== "string") return null;

  const value = effect.trim();
  if (!value) return null;
  return TEXT_EFFECTS[value.toLowerCase()] || value;
}

function getTextEffectId(message) {
  if (!message || typeof message !== "object") return null;
  for (const property of EFFECT_PROPERTIES) {
    if (message[property] !== undefined && message[property] !== null) {
      const effectID = toTextEffectId(message[property]);
      if (effectID) return effectID;
    }
  }

  const rawIDs = Array.isArray(message.text_effect_ids)
    ? message.text_effect_ids
    : [message.text_effect_ids];
  for (const rawID of rawIDs) {
    const effectID = toTextEffectId(rawID);
    if (effectID) return effectID;
  }
  return null;
}

function getTextEffectIds(message) {
  if (!message || typeof message !== "object") return [];
  const rawIDs = Array.isArray(message.text_effect_ids)
    ? message.text_effect_ids
    : [message.text_effect_ids];
  const ids = rawIDs
    .map(toTextEffectId)
    .filter(Boolean);

  if (!ids.length) {
    const single = getTextEffectId(message);
    if (single) ids.push(single);
  }
  return ids;
}

module.exports = {
  EFFECT_PROPERTIES,
  TEXT_EFFECTS,
  getTextEffectId,
  getTextEffectIds,
  toTextEffectId
};