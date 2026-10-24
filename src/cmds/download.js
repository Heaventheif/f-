"use strict";
// تجميع أوامر التنزيل مع الحفاظ على إعدادات كل أمر وأسمائه البديلة.
// ملاحظة: autodl.js يبقى منفصلًا لأنه يعتمد على onChat وله تحميل خاص به.
import yt from "./_modules/yt.js";
import ytmp3 from "./_modules/ytmp3.js";
import song from "./_modules/song.js";
import fyp from "./_modules/fyp.js";
import random from "./_modules/random.js";

export const commands = [yt, ytmp3, song, fyp, random];
