"use strict";
// تجميع مزوّدات الذكاء الاصطناعي (مع إبقاء onChat وonReply لكل مزوّد) وخدمات الصوت stt/tts.
import gemini from "./_modules/gemini.js";
import gptx from "./_modules/gptx.js";
import groq from "./_modules/groq.js";
import stt from "./_modules/stt.js";
import tts from "./_modules/tts.js";

export const commands = [gemini, gptx, groq, stt, tts];
