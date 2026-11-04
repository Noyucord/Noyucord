/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { extractFile, listPackage } from "@electron/asar";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const branches = { stable: "Discord", ptb: "DiscordPTB", canary: "DiscordCanary", dev: "DiscordDevelopment" };
const markerName = "noyucord-local.json";
const shimFiles = new Set(["package.json", "index.js", markerName, "nayucord-local.json"]);

function regular(path, directory = false) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
        throw new Error(`Expected a regular ${directory ? "directory" : "file"}: ${path}`);
    return stat;
}

function packageInfo(archive) {
    regular(archive);
    try {
        const pkg = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
        if (typeof pkg.main !== "string" || !pkg.main || !/^discord(?:[-_]|$)/i.test(pkg.name ?? "")) throw new Error("Unknown application.");
        return pkg;
    } catch {
        throw new Error(`This is not a recognized Discord archive: ${archive}`);
    }
}

function literalRequire(source) {
    const text = source.replace(/^\/\/ N[oa]yucord local build injector\r?\n/, "").trim();
    const match = /^require\(("(?:[^"\\]|\\.)*")\);?$/.exec(text);
    if (!match) return null;
    try {
        const target = JSON.parse(match[1]);
        return typeof target === "string" && /(?:[/\\](?:equicord|vencord|noyucord|desktop)\.asar|[/\\]dist[/\\]desktop(?:[/\\]patcher\.js)?|[/\\]patcher\.js)$/i.test(target) ? target : null;
    } catch {
        return null;
    }
}

function isLoader(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return false;
    let pkg;
    let source;
    if (stat.isDirectory()) {
        const names = readdirSync(path);
        if (!names.includes("package.json") || !names.includes("index.js") || names.some(name => !shimFiles.has(name))) return false;
        for (const name of names) if (regular(join(path, name)).size > 16 * 1024) return false;
        pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
        source = readFileSync(join(path, "index.js"), "utf8");
    } else if (stat.isFile() && stat.size <= 128 * 1024) {
        const files = listPackage(path).map(name => name.replace(/^[/\\]/, "")).sort();
        if (files.join(",") !== "index.js,package.json") return false;
        pkg = JSON.parse(extractFile(path, "package.json").toString("utf8"));
        source = extractFile(path, "index.js").toString("utf8");
    } else return false;
    return pkg.name === "discord" && pkg.main === "index.js" && literalRequire(source) !== null;
}

function removeTemporary(path, resources) {
    const absolute = resolve(path);
    if (dirname(absolute) !== resources || !/^\.noyucord-local-[a-f\d-]+$/.test(basename(absolute)))
        throw new Error("Refusing to remove a path outside the local injection staging directory.");
    if (existsSync(absolute)) rmSync(absolute, { recursive: true });
}

export function validateLocalBuild(build = join(repository, "dist", "desktop")) {
    const directory = realpathSync(build);
    regular(directory, true);
    for (const file of ["package.json", "patcher.js", "preload.js", "renderer.js", "renderer.css", "userPluginCompiler.js", "esbuild.wasm"])
        regular(join(directory, file));
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (pkg.main !== "patcher.js") throw new Error("The desktop build has an unexpected entry point. Run pnpm build first.");
    return join(directory, "patcher.js");
}

export function injectResources(input, patcher, { uninstall = false, dryRun = false } = {}) {
    const resources = resolve(input);
    regular(resources, true);
    if (realpathSync(resources).toLowerCase() !== resources.toLowerCase()) throw new Error("Use the real resources path, not a linked directory.");
    if (existsSync(join(resources, "app"))) throw new Error("A resources/app folder already exists. Restore the other client modification before injecting.");
    if (existsSync(join(resources, "app.asar.unpacked")) || existsSync(join(resources, "_app.asar.unpacked")))
        throw new Error("This Discord layout includes unpacked application files and is not supported by the local injector.");
    const app = join(resources, "app.asar");
    const backup = join(resources, "_app.asar");
    const hasBackup = existsSync(backup);
    const hasApp = existsSync(app);
    if (hasBackup) {
        packageInfo(backup);
        if (isLoader(backup)) throw new Error("The backup contains another loader instead of original Discord. Restore Discord before injecting.");
        if (hasApp && !isLoader(app)) throw new Error("The current app.asar is not a recognized loader. The original backup will not be overwritten.");
    } else {
        if (uninstall) throw new Error("There is no original _app.asar backup to restore.");
        if (!hasApp) throw new Error("Discord's app.asar was not found in the selected resources directory.");
        packageInfo(app);
        if (isLoader(app)) throw new Error("A loader is installed but original Discord is missing. Restore Discord before injecting.");
    }
    if (!uninstall) regular(patcher);
    const result = { resources, patcher, action: uninstall ? "restore" : "inject", dryRun };
    if (dryRun) return result;

    const staged = join(resources, `.noyucord-local-${randomUUID()}`);
    const previous = join(resources, `.noyucord-local-${randomUUID()}`);
    let movedOriginal = false;
    let movedLoader = false;
    let committed = false;
    try {
        if (!uninstall) {
            mkdirSync(staged);
            writeFileSync(join(staged, "package.json"), JSON.stringify({ name: "discord", main: "index.js" }));
            writeFileSync(join(staged, "index.js"), `// Noyucord local build injector\nrequire(${JSON.stringify(resolve(patcher))});\n`);
            writeFileSync(join(staged, markerName), JSON.stringify({ schemaVersion: 1, build: dirname(patcher) }));
        }
        if (hasBackup && hasApp) {
            renameSync(app, previous);
            movedLoader = true;
        } else if (!hasBackup) {
            renameSync(app, backup);
            movedOriginal = true;
        }
        renameSync(uninstall ? backup : staged, app);
        committed = true;
    } catch (error) {
        if (movedLoader || movedOriginal) {
            try { renameSync(movedLoader ? previous : backup, app); }
            catch (rollbackError) { throw new AggregateError([error, rollbackError], "Injection failed and could not restore the previous layout. Keep _app.asar and the staging files for recovery."); }
        }
        throw error;
    } finally {
        removeTemporary(staged, resources);
        if (committed) removeTemporary(previous, resources);
    }
    return result;
}

export function findResources(root) {
    const absolute = resolve(root);
    regular(absolute, true);
    if (basename(absolute).toLowerCase() === "resources") return absolute;
    if (existsSync(join(absolute, "resources"))) return join(absolute, "resources");
    const versions = readdirSync(absolute, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^app-\d+(?:\.\d+)*$/.test(entry.name))
        .sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }));
    const latest = versions.find(entry => ["app.asar", "_app.asar"].some(file => existsSync(join(absolute, entry.name, "resources", file))));
    if (!latest) throw new Error(`No Discord app version was found in ${absolute}.`);
    return join(absolute, latest.name, "resources");
}

export function parseArguments(args) {
    const options = { branch: undefined, location: undefined, uninstall: false, dryRun: false, help: false };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--install") continue;
        if (arg === "--uninstall") options.uninstall = true;
        else if (arg === "--dry-run") options.dryRun = true;
        else if (arg === "--help" || arg === "-h") options.help = true;
        else if (arg === "--branch" || arg === "--location") {
            const value = args[++index];
            if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
            if (arg === "--branch") {
                if (!Object.hasOwn(branches, value)) throw new Error("Use stable, ptb, canary, or dev for --branch.");
                options.branch = value;
            } else options.location = value;
        } else throw new Error(`Unknown option: ${arg}`);
    }
    if (options.location && args.includes("--branch")) throw new Error("Use either --branch or --location.");
    return options;
}

export function discoverInstallations(localAppData) {
    const installations = [];
    for (const [branch, name] of Object.entries(branches)) {
        const root = join(localAppData, name);
        if (!existsSync(root)) continue;
        try {
            const resources = findResources(root);
            if (existsSync(join(resources, "app.asar")) || existsSync(join(resources, "_app.asar")))
                installations.push({ branch, name, resources });
        } catch (error) {
            if (error?.code !== "ENOENT" && !String(error?.message).startsWith("No Discord app version")) throw error;
        }
    }
    return installations;
}

export async function selectInstallation(installations, question, write = console.log) {
    if (!installations.length) throw new Error("No Discord installations were found. Use --location to select a custom installation.");
    write("Choose a Discord installation:");
    installations.forEach((installation, index) => write(`  ${index + 1}. ${installation.name} (${basename(dirname(installation.resources))})\n     ${installation.resources}`));
    write("  0. Cancel");
    while (true) {
        let answer;
        try { answer = (await question("Installation number: ")).trim(); }
        catch (error) {
            if (error?.name === "AbortError") return null;
            throw new Error("No installation was selected. Run in an interactive terminal, or use --branch or --location.");
        }
        if (answer === "0") return null;
        const number = /^\d+$/.test(answer) ? Number(answer) : NaN;
        if (Number.isSafeInteger(number) && number >= 1 && number <= installations.length) return installations[number - 1];
        write(`Enter a number from 1 to ${installations.length}, or 0 to cancel.`);
    }
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        console.log("Local Noyucord injector (Windows). No installer downloads.\nRun pnpm inject:local to choose a detected Discord installation.\nUsage: pnpm inject:local [--branch stable|ptb|canary|dev] [--dry-run]\n       pnpm inject:local --location <Discord root, app version, or resources folder>\n       pnpm uninject:local [--branch ... | --location ...]");
        return;
    }
    if (process.platform !== "win32") throw new Error("This local injector currently supports Windows Discord installations.");
    if (!process.env.LOCALAPPDATA && !options.location) throw new Error("LOCALAPPDATA is unavailable. Use --location to select Discord.");
    const patcher = options.uninstall ? "" : validateLocalBuild();
    let resources;
    let branch = options.branch;
    if (options.location) resources = findResources(options.location);
    else if (branch) resources = findResources(join(process.env.LOCALAPPDATA, branches[branch]));
    else {
        const installations = discoverInstallations(process.env.LOCALAPPDATA);
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        const controller = new AbortController();
        terminal.on("SIGINT", () => controller.abort());
        terminal.on("close", () => controller.abort());
        try {
            const selected = await selectInstallation(installations, prompt => terminal.question(prompt, { signal: controller.signal }));
            if (!selected) {
                console.log("Cancelled. No files were changed.");
                return;
            }
            ({ resources, branch } = selected);
        } finally {
            terminal.close();
        }
    }
    if (!options.dryRun) {
        const running = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
        const executable = branch ? branches[branch].toLowerCase() + ".exe" : undefined;
        const discordProcesses = [...running.matchAll(/^"(Discord(?:PTB|Canary|Development)?\.exe)",/gim)].map(match => match[1].toLowerCase());
        if (executable ? discordProcesses.includes(executable) : discordProcesses.length)
            throw new Error(`Quit ${branch ? branches[branch] : "Discord"} completely, including its tray icon, before injecting or restoring.`);
    }
    const result = injectResources(resources, patcher, options);
    console.log(`${result.dryRun ? "Would " : "Completed "}${result.action === "restore" ? "restore original Discord in" : "inject local Noyucord into"} ${resources}`);
    if (!options.uninstall) console.log(`Local build: ${dirname(patcher)}`);
    console.log(result.dryRun ? "No files were changed." : "Reopen Discord. Keep this checkout at its current location while it is injected.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
