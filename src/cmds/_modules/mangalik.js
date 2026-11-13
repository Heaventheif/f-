import { runMangaCommand } from "../../manga/command.js";

// Same engine as `manga`, with the Starz/Mangalik sources first (see src/manga/sources.js).
export default {
  config: {
    name: "mangalik",
    aliases: ["mangalek", "مانجاليك"],
    version: "3.0.0",
    author: "Sunken",
    countDown: 10,
    role: 0,
    category: "مانجا وروايات",
    description: "جلب فصول المانجا؛ StarzManga أولاً لـOne Piece ثم Mangalik، مع تحويل تلقائي لمصادر أخرى عند الفشل",
    usage: ["{pn}mangalik <اسم المانجا> <رقم الفصل> — مثال: {pn}mangalik One Piece 1085"],
  },
  onStart: ({ api, event, args, signal }) => runMangaCommand({ api, event, args, signal, kind: "mangalik" }),
};
