"use strict";
import { discoverCommands } from "../core/Loader.js";
export const commands = await discoverCommands(import.meta.url, ["yt", "ytmp3", "song", "fyp", "random", "vl"]);
