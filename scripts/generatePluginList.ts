/*
 * Noyucord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { existsSync, readdirSync, writeFileSync } from "fs";
import { getEntryPoint, isPluginFile, parseDevs, parseEquicordDevs, parseFile, parseNoyucordDevs, PluginData } from "./utils";

(async () => {
    parseDevs();
    parseEquicordDevs();
    parseNoyucordDevs();

    const args = process.argv.slice(2);

    const equicordFlag = args.includes("--equicord");
    const vencordFlag = args.includes("--vencord");
    const noyucordFlag = args.includes("--noyucord");

    let dirs: string[];

    if (equicordFlag) {
        dirs = ["src/plugins/equicord/_core", "src/plugins/equicord"];
    } else if (vencordFlag) {
        dirs = ["src/plugins/vencord", "src/plugins/vencord/_core"];
    } else if (noyucordFlag) {
        dirs = ["src/noyucordplugins", "src/noyucordplugins/_core"];
    } else {
        dirs = ["src/plugins/vencord", "src/plugins/vencord/_core", "src/plugins/equicord/_core", "src/plugins/equicord", "src/noyucordplugins", "src/noyucordplugins/_core"];
    }

    const outputPath = args.find(a => !a.startsWith("--")) ?? null;

    const plugins = [] as PluginData[];

    await Promise.all(
        dirs.filter(existsSync).flatMap(dir =>
            readdirSync(dir, { withFileTypes: true })
                .filter(isPluginFile)
                .map(async dirent => {
                    const [data] = await parseFile(await getEntryPoint(dir, dirent));
                    plugins.push(data);
                })
        )
    );

    const data = JSON.stringify(plugins.sort((a, b) => a.name.localeCompare(b.name)));

    if (outputPath) {
        writeFileSync(outputPath, data);
    } else {
        console.log(data);
    }
})();
