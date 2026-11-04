/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { BetterDiscordLibraryId } from "./userPlugins";

interface LibraryProfile {
    name: string;
    version: string;
    repository: string;
    revision: string;
    entry: string;
    files: Record<string, { source: string; sha?: string; }>;
}

export const BETTER_DISCORD_LIBRARIES: Readonly<Record<BetterDiscordLibraryId, LibraryProfile>> = {
    zeres: {
        name: "ZeresPluginLibrary", version: "2.0.23", repository: "zerebos/BDPluginLibrary",
        revision: "a375c48d7af5e1a000ce0d97a6cbbcf77a9461cc", entry: "0PluginLibrary.plugin.js",
        files: {
            "0PluginLibrary.plugin.js": { source: "release/0PluginLibrary.plugin.js", sha: "2520495bcfad67bfb53c221039cb3cdeb7aee696" },
            "LICENSE": { source: "LICENSE" }
        }
    },
    bdfdb: {
        name: "BDFDB", version: "4.5.8", repository: "mwittrien/BetterDiscordAddons",
        revision: "2cda4b90248e93558fe41311ba33af3cfc1261e8", entry: "0BDFDB.plugin.js",
        files: {
            "0BDFDB.plugin.js": { source: "Library/0BDFDB.plugin.js", sha: "1bed09c9163aa6f07bddc6ca1a2f5056aecb70c1" },
            "0BDFDB.data.json": { source: "Library/_res/0BDFDB.data.json", sha: "94581c73cb544376717aa6d4fed78c858504e94b" },
            "0BDFDB.raw.css": { source: "Library/_res/0BDFDB.raw.css", sha: "b4bc90405cbf0cf08a5dd049c7dc2bc705ef2079" },
            "LICENSE": { source: "LICENSE" }
        }
    }
};
