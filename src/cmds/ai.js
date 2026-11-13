"use strict";
import { discoverCommands } from "../core/Loader.js";
export const commands = await discoverCommands(import.meta.url, ["gemini", "gptx", "groq", "stt", "tts"]);
