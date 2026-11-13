import { runMangaCommand } from "../../manga/command.js";
export { MAX_PAGES } from "../../manga/deliver.js";

export default {
  config: {
    name: "manga",
    aliases: ["مانجا2"],
    version: "4.0.0",
    author: "Sunken",
    countDown: 15,
    role: 0,
    category: "مانجا وروايات",
    description:
      "قراءة فصول المانجا (صور، مع مصدر بديل عربي تلقائي)، أو عرض نطاق الفصول العربية المتوفرة/المفقودة إن لم يُذكر رقم فصل",
    usage: [
      "{pn}مانجا <اسم المانجا> <رقم الفصل> — مثال: {pn}مانجا one piece 13",
      "{pn}مانجا <اسم المانجا> <رقم الفصل> <لغة> — مثال: {pn}مانجا naruto 5 en",
      "{pn}مانجا <اسم المانجا> <لغة> — مثال: {pn}مانجا naruto en",
      "{pn}مانجا <اسم المانجا> (بدون رقم فصل) — يعرض نطاقات الفصول العربية المتوفرة/المفقودة",
    ],
  },
  onStart: ({ api, event, args, signal }) => runMangaCommand({ api, event, args, signal, kind: "manga" }),
};
