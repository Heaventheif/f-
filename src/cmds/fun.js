"use strict";
import { discoverCommands } from "../core/Loader.js";
export const commands = await discoverCommands(import.meta.url, ["animal", "chess"]);
