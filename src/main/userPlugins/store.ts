/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BETTER_DISCORD_COMPATIBILITY_VERSION, type InstalledUserPlugin, type UserPluginManifest, type UserPluginSource, type UserPluginStartup, type UserPluginStatus } from "@shared/userPlugins";
import { createHash, randomUUID } from "crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { packagePath } from "./files";
import { PluginFiles, validateManifest } from "./package";

interface PluginRecord extends InstalledUserPlugin {
    current: string;
    backup?: string;
    candidate: string;
}

interface PluginIndex {
    schemaVersion: 1;
    plugins: Record<string, PluginRecord>;
    lastChecked: number;
    retryAt: number;
    error?: string;
}

export interface UserPluginCompilationIdentity {
    target: "desktop" | "discordDesktop" | "equibop";
    apiVersion: number;
    compilerVersion: string;
}

export interface NativeUserPluginBundle {
    id: string;
    name: string;
    code: string;
    filename: string;
    revision: string;
}

export interface PreparedUserPlugin {
    manifest: UserPluginManifest;
    files: PluginFiles;
    code: string;
    source: UserPluginSource;
    candidate: string;
    updating?: boolean;
    native?: { code: string; trusted: boolean; };
    compatibilityTrusted?: boolean;
}

export interface BetterDiscordStartupPackage {
    manifest: UserPluginManifest;
    files: PluginFiles;
    nativeTrusted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validId(value: unknown): value is string {
    return typeof value === "string" && /^[a-z\d][a-z\d._-]{0,99}$/.test(value) && !value.endsWith(".") &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) && !["__proto__", "prototype", "constructor"].includes(value);
}

function parseSource(value: unknown): UserPluginSource {
    if (!isRecord(value) || !["local", "url", "github"].includes(String(value.kind))) throw new Error("The plugin source is invalid.");
    return {
        kind: value.kind === "github" ? "github" : value.kind === "url" ? "url" : "local",
        url: typeof value.url === "string" ? value.url : undefined,
        revision: typeof value.revision === "string" ? value.revision : undefined,
        pinned: value.pinned === true,
        asset: typeof value.asset === "string" ? value.asset : undefined
    };
}

function validVersion(value: unknown): value is string {
    return typeof value === "string" && /^[a-f\d-]{36}$/.test(value);
}

function readJson(path: string): unknown {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("The user-plugin metadata file is invalid or too large.");
    return JSON.parse(readFileSync(path, "utf8"));
}

export function sourceRevision(files: PluginFiles): string {
    const hash = createHash("sha256");
    for (const name of Object.keys(files).sort()) hash.update(name).update("\0").update(files[name]).update("\0");
    return hash.digest("hex");
}

export function createUserPluginStore(root: string, reserved: readonly string[], disabled = false, removeSettings?: (name: string) => void,
    compilation: UserPluginCompilationIdentity = { target: "desktop", apiVersion: 1, compilerVersion: "0.28.1" }) {
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) throw new Error("The user-plugin folder cannot be a symbolic link.");
    const indexPath = join(root, "index.json");
    const startupPath = join(root, "startup.json");
    let index: PluginIndex = { schemaVersion: 1, plugins: Object.create(null), lastChecked: 0, retryAt: 0 };
    let recovery = false;
    let startupRead = false;
    let corruptIndex = false;
    let startupResult: UserPluginStartup | undefined;
    const nativeBundles: NativeUserPluginBundle[] = [];
    const compatibilityPackages = new Map<string, BetterDiscordStartupPackage>();
    const reservedNames = new Set(reserved.map(name => name.toLowerCase()));
    const bundledDependencies = new Set(reserved);
    try { if (existsSync(indexPath)) {
        const raw = readJson(indexPath);
        if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.plugins)) throw new Error("The user-plugin index is invalid. Back it up before resetting it.");
        index.lastChecked = typeof raw.lastChecked === "number" ? raw.lastChecked : 0;
        index.retryAt = typeof raw.retryAt === "number" ? raw.retryAt : 0;
        index.error = typeof raw.error === "string" ? raw.error : undefined;
        for (const [id, value] of Object.entries(raw.plugins)) {
            if (!validId(id) || !isRecord(value) || !isRecord(value.manifest) || value.manifest.id !== id ||
                typeof value.manifest.name !== "string" || !validVersion(value.current) || value.backup !== undefined && !validVersion(value.backup) ||
                typeof value.enabled !== "boolean" || typeof value.candidate !== "string" || !isRecord(value.source) ||
                !["local", "url", "github"].includes(String(value.source.kind)))
                throw new Error("The user-plugin index contains an invalid entry.");
            index.plugins[id] = {
                manifest: validateManifest(value.manifest), source: parseSource(value.source),
                current: value.current, backup: typeof value.backup === "string" ? value.backup : undefined,
                candidate: value.candidate, enabled: value.enabled,
                pendingRemoval: value.pendingRemoval === true, removeData: value.removeData === true,
                installedAt: typeof value.installedAt === "number" ? value.installedAt : 0,
                revision: typeof value.revision === "string" ? value.revision : "",
                hasBackup: typeof value.backup === "string", error: typeof value.error === "string" ? value.error : undefined,
                updateAvailable: value.updateAvailable === true
            };
        }
    } } catch {
        corruptIndex = true;
        recovery = true;
        index = { schemaVersion: 1, plugins: Object.create(null), lastChecked: 0, retryAt: 0, error: "The user-plugin index could not be read. Recovery will back it up before resetting it." };
    }
    if (existsSync(startupPath)) {
        try {
            const marker = readJson(startupPath);
            recovery ||= isRecord(marker) && marker.inProgress === true;
            if (isRecord(marker) && marker.inProgress === true && validId(marker.plugin) && Object.hasOwn(index.plugins, marker.plugin))
                index.plugins[marker.plugin].error = "The previous startup stopped while loading this plugin. Review it before enabling user plugins again.";
        } catch { recovery = true; }
    }

    function atomicJson(path: string, value: unknown) {
        const temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(value, null, 4), { encoding: "utf8", flush: true });
        renameSync(temporary, path);
    }

    function save() {
        if (corruptIndex) throw new Error("The user-plugin index needs recovery before it can be changed.");
        atomicJson(indexPath, index);
    }

    function recordFor(id: string): PluginRecord {
        if (!validId(id) || !Object.hasOwn(index.plugins, id)) throw new Error("The user plugin was not found.");
        return index.plugins[id];
    }

    function versionPath(id: string, version: string) {
        if (!validId(id) || !validVersion(version)) throw new Error("The plugin storage identity is invalid.");
        for (const path of [root, join(root, id), join(root, id, version)]) {
            try {
                if (lstatSync(path).isSymbolicLink()) throw new Error("The plugin storage cannot contain symbolic links.");
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }
        }
        return join(root, id, version);
    }

    function status(): UserPluginStatus {
        return {
            plugins: Object.values(index.plugins).map(({ current: _current, backup: _backup, candidate: _candidate, ...plugin }) => plugin),
            recovery, disabled, lastChecked: index.lastChecked, error: index.error
        };
    }

    function assertAvailable(manifest: UserPluginManifest, updating?: string) {
        if (!validId(manifest.id)) throw new Error("The plugin ID is invalid.");
        if (manifest.id === "index.json" || manifest.id === "startup.json") throw new Error("The plugin ID conflicts with internal user-plugin storage.");
        if (reservedNames.has(manifest.name.toLowerCase()) || reservedNames.has(manifest.id.toLowerCase()))
            throw new Error("This plugin conflicts with a bundled plugin.");
        for (const plugin of Object.values(index.plugins)) {
            if (plugin.manifest.id === updating) continue;
            if (plugin.manifest.id === manifest.id || plugin.manifest.name.toLowerCase() === manifest.name.toLowerCase())
                throw new Error("A plugin with this identity or name is already installed.");
        }
    }

    function prepare(item: PreparedUserPlugin): PluginRecord {
        const { manifest, files, code, source, candidate, updating, native, compatibilityTrusted } = item;
        assertAvailable(manifest, updating ? manifest.id : undefined);
        if (manifest.native && (!native?.trusted || !native.code)) throw new Error("Native helpers require explicit trust for this plugin version before installation.");
        if (native && !manifest.native) throw new Error("The plugin manifest does not declare its native helper.");
        if (manifest.runtime === "betterdiscord" && manifest.betterDiscord?.requiresNative && !compatibilityTrusted)
            throw new Error("BetterDiscord compatibility APIs require explicit trust for this plugin version before installation.");
        const previous = updating ? recordFor(manifest.id) : undefined;
        if (previous && previous.manifest.name !== manifest.name) throw new Error("An update cannot change the plugin name or saved settings identity.");
        if (previous?.pendingRemoval) throw new Error("Restart to finish removing this plugin before updating it.");
        const version = randomUUID();
        const directory = versionPath(manifest.id, version);
        mkdirSync(directory, { recursive: true });
        const encoded: Record<string, string> = Object.create(null);
        for (const [name, bytes] of Object.entries(files)) encoded[packagePath(name)] = Buffer.from(bytes).toString("base64");
        writeFileSync(join(directory, "source.json"), JSON.stringify(encoded), "utf8");
        writeFileSync(join(directory, "renderer.js"), code, "utf8");
        if (native) writeFileSync(join(directory, "native.js"), native.code, "utf8");
        atomicJson(join(directory, "metadata.json"), {
            manifest, source, candidate, compilation, codeHash: createHash("sha256").update(code).digest("hex"),
            ...(manifest.runtime === "betterdiscord" ? {
                compatibilityVersion: BETTER_DISCORD_COMPATIBILITY_VERSION,
                sourceHash: sourceRevision(files), compatibilityTrusted: compatibilityTrusted === true
            } : {}),
            ...(native ? { nativeTrusted: true, nativeCodeHash: createHash("sha256").update(native.code).digest("hex") } : {})
        });
        return {
            manifest, source, candidate, current: version, backup: previous?.current,
            installedAt: previous?.installedAt ?? Date.now(), enabled: previous?.enabled ?? false,
            revision: source.revision ?? sourceRevision(files), hasBackup: Boolean(previous)
        };
    }

    function installBatch(items: PreparedUserPlugin[]): InstalledUserPlugin[] {
        if (!items.length) return [];
        const ids = new Set<string>();
        const names = new Set<string>();
        for (const { manifest } of items) {
            if (ids.has(manifest.id) || names.has(manifest.name.toLowerCase())) throw new Error("The installation contains duplicate plugin identities.");
            ids.add(manifest.id);
            names.add(manifest.name.toLowerCase());
        }
        const prepared: PluginRecord[] = [];
        const previous = { ...index.plugins };
        try {
            for (const item of items) prepared.push(prepare(item));
            for (const plugin of prepared) index.plugins[plugin.manifest.id] = plugin;
            for (const plugin of prepared) checkDependencies(plugin.manifest.id);
            save();
        } catch (error) {
            index.plugins = previous;
            for (const plugin of prepared) rmSync(versionPath(plugin.manifest.id, plugin.current), { recursive: true, force: true });
            throw error;
        }
        return prepared;
    }

    function install(manifest: UserPluginManifest, files: PluginFiles, code: string, source: UserPluginSource, candidate: string, updating = false,
        native?: { code: string; trusted: boolean; }, compatibilityTrusted = false): InstalledUserPlugin {
        const plugin = prepare({ manifest, files, code, source, candidate, updating, native, compatibilityTrusted });
        const previous = index.plugins[manifest.id];
        index.plugins[manifest.id] = plugin;
        try { save(); } catch (error) {
            if (previous) index.plugins[manifest.id] = previous;
            else delete index.plugins[manifest.id];
            rmSync(versionPath(manifest.id, plugin.current), { recursive: true, force: true });
            throw error;
        }
        return plugin;
    }

    function checkDependencies(id: string) {
        const visited = new Set<string>();
        const visiting = new Set<string>();
        const result: string[] = [];
        function visit(pluginId: string) {
            if (visited.has(pluginId)) return;
            if (visiting.has(pluginId)) throw new Error("The user plugins have a circular dependency.");
            visiting.add(pluginId);
            const plugin = recordFor(pluginId);
            if (plugin.pendingRemoval) throw new Error("A required plugin is pending removal.");
            for (const dependency of plugin.manifest.dependencies) {
                if (bundledDependencies.has(dependency)) continue;
                const match = Object.values(index.plugins).find(entry => entry.manifest.name === dependency);
                if (!match) throw new Error(`Required plugin ${dependency} is not installed.`);
                visit(match.manifest.id);
            }
            visiting.delete(pluginId);
            visited.add(pluginId);
            result.push(pluginId);
        }
        visit(id);
        return result;
    }

    function setEnabled(id: string, enabled: boolean) {
        const plugin = recordFor(id);
        if (plugin.pendingRemoval) throw new Error("Restart to finish removing this plugin.");
        const changed: PluginRecord[] = [];
        if (enabled) {
            const dependencies = checkDependencies(id);
            const disabledDependencies = dependencies.filter(dependency => dependency !== id && !recordFor(dependency).enabled && !recordFor(dependency).manifest.betterDiscord?.provider);
            if (disabledDependencies.length)
                throw new Error(`Enable these required plugins first: ${disabledDependencies.map(dependency => recordFor(dependency).manifest.name).join(", ")}.`);
            for (const dependency of dependencies) {
                const entry = recordFor(dependency);
                if (dependency !== id && !entry.enabled && entry.manifest.betterDiscord?.provider) changed.push(entry);
            }
        } else {
            const dependent = Object.values(index.plugins).find(entry => entry.enabled && !entry.pendingRemoval && entry.manifest.id !== id &&
                entry.manifest.dependencies.includes(plugin.manifest.name));
            if (dependent) throw new Error(`Disable ${dependent.manifest.name} before disabling its dependency.`);
        }
        const previousEnabled = plugin.enabled;
        for (const entry of changed) entry.enabled = true;
        plugin.enabled = enabled;
        plugin.error = undefined;
        try { save(); } catch (error) {
            plugin.enabled = previousEnabled;
            for (const entry of changed) entry.enabled = false;
            throw error;
        }
    }

    function remove(id: string, removeData: boolean) {
        setEnabled(id, false);
        const plugin = recordFor(id);
        plugin.pendingRemoval = true;
        plugin.removeData = removeData;
        save();
    }

    function rollback(id: string) {
        const plugin = recordFor(id);
        if (!plugin.backup) throw new Error("This plugin has no previous version.");
        const metadata = readJson(join(versionPath(id, plugin.backup), "metadata.json"));
        if (!isRecord(metadata) || !isRecord(metadata.manifest) || !isRecord(metadata.source) || typeof metadata.candidate !== "string")
            throw new Error("The previous plugin version is invalid.");
        const oldCurrent = plugin.current;
        plugin.current = plugin.backup;
        plugin.backup = oldCurrent;
        plugin.manifest = validateManifest(metadata.manifest);
        plugin.source = parseSource(metadata.source);
        plugin.candidate = metadata.candidate;
        plugin.revision = plugin.source.revision ?? "";
        plugin.error = undefined;
        plugin.updateAvailable = false;
        save();
    }

    function startup(): UserPluginStartup {
        if (startupResult) return startupResult;
        startupRead = true;
        const result: UserPluginStartup = { plugins: [], recovery, disabled, errors: [] };
        const removals = Object.values(index.plugins).filter(plugin => plugin.pendingRemoval);
        for (const plugin of removals) {
            if (plugin.removeData) removeSettings?.(plugin.manifest.name);
            if (plugin.removeData) {
                const dataRoot = join(root, ".betterdiscord-data");
                if (existsSync(dataRoot) && lstatSync(dataRoot).isSymbolicLink()) throw new Error("The user-plugin data folder cannot be a symbolic link.");
                rmSync(join(dataRoot, plugin.manifest.id), { recursive: true, force: true });
            }
            delete index.plugins[plugin.manifest.id];
        }
        if (removals.length) save();
        for (const plugin of removals) rmSync(join(root, plugin.manifest.id), { recursive: true, force: true });
        if (disabled || recovery) return startupResult = result;
        const ordered = new Set<string>();
        for (const plugin of Object.values(index.plugins).filter(entry => entry.enabled)) {
            try {
                for (const dependency of checkDependencies(plugin.manifest.id)) {
                    const entry = recordFor(dependency);
                    if (!entry.enabled) throw new Error(`Required plugin ${entry.manifest.name} is disabled.`);
                    ordered.add(dependency);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : "The plugin dependencies are invalid.";
                result.errors.push({ id: plugin.manifest.id, message });
                plugin.error = message;
            }
        }
        for (const id of ordered) {
            const plugin = recordFor(id);
            if (result.errors.some(error => error.id === id)) continue;
            try {
                assertAvailable(plugin.manifest, id);
                const codePath = join(versionPath(id, plugin.current), "renderer.js");
                if (lstatSync(codePath).isSymbolicLink() || lstatSync(codePath).size > 20 * 1024 * 1024) throw new Error("The compiled plugin file is invalid.");
                const code = readFileSync(codePath, "utf8");
                const metadata = readJson(join(versionPath(id, plugin.current), "metadata.json"));
                if (!isRecord(metadata) || !isRecord(metadata.compilation) || metadata.compilation.target !== compilation.target ||
                    metadata.compilation.apiVersion !== compilation.apiVersion || metadata.compilation.compilerVersion !== compilation.compilerVersion)
                    throw new Error("This plugin cache targets another client or API/compiler version. Reinstall the plugin to recompile it. Saved settings were retained.");
                if (!isRecord(metadata) || metadata.codeHash !== createHash("sha256").update(code).digest("hex")) throw new Error("The compiled plugin cache is damaged.");
                let compatibilityPackage: BetterDiscordStartupPackage | undefined;
                if (plugin.manifest.runtime === "betterdiscord") {
                    const files = originalFiles(id);
                    if (metadata.compatibilityVersion !== BETTER_DISCORD_COMPATIBILITY_VERSION || metadata.sourceHash !== sourceRevision(files))
                        throw new Error("This plugin cache targets another BetterDiscord compatibility profile or its sources changed. Reinstall it. Saved settings were retained.");
                    if (plugin.manifest.betterDiscord?.requiresNative && metadata.compatibilityTrusted !== true)
                        throw new Error("The BetterDiscord compatibility APIs have not been trusted for this version.");
                    compatibilityPackage = { manifest: plugin.manifest, files, nativeTrusted: metadata.compatibilityTrusted === true };
                }
                if (plugin.manifest.native) {
                    if (!isRecord(metadata.manifest) || metadata.manifest.native !== plugin.manifest.native || metadata.nativeTrusted !== true)
                        throw new Error("The native plugin helper has not been trusted for this version.");
                    const nativePath = join(versionPath(id, plugin.current), "native.js");
                    if (lstatSync(nativePath).isSymbolicLink() || lstatSync(nativePath).size > 20 * 1024 * 1024) throw new Error("The compiled native helper is invalid.");
                    const nativeCode = readFileSync(nativePath, "utf8");
                    if (metadata.nativeCodeHash !== createHash("sha256").update(nativeCode).digest("hex")) throw new Error("The compiled native helper cache is damaged.");
                    nativeBundles.push({ id, name: plugin.manifest.name, code: nativeCode, filename: nativePath, revision: plugin.revision });
                }
                if (compatibilityPackage) compatibilityPackages.set(id, compatibilityPackage);
                result.plugins.push({ manifest: plugin.manifest, code, revision: plugin.revision });
            } catch (error) {
                const message = error instanceof Error && error.message.startsWith("This plugin cache") ? error.message : "The compiled plugin could not be loaded. Reinstall it or restore its previous version.";
                plugin.error = message;
                result.errors.push({ id, message });
            }
        }
        save();
        if (result.plugins.length) atomicJson(startupPath, { inProgress: true, plugin: null });
        startupResult = result;
        return result;
    }

    function markStartup(id: string | null) {
        if (!startupRead || disabled || recovery) return;
        if (id !== null) recordFor(id);
        atomicJson(startupPath, { inProgress: true, plugin: id });
    }

    function completeStartup() {
        if (recovery || disabled) return;
        if (existsSync(startupPath)) rmSync(startupPath);
    }

    function reportFailure(id: string, message: string) {
        const plugin = recordFor(id);
        const error = message ? message.slice(0, 1000) : undefined;
        if (plugin.error === error) return;
        plugin.error = error;
        save();
    }

    function recover() {
        if (corruptIndex) {
            renameSync(indexPath, join(root, `index.backup-${Date.now()}.json`));
            corruptIndex = false;
            index.error = "The unreadable index was backed up. Reimport plugins to restore their entries.";
        }
        for (const plugin of Object.values(index.plugins)) plugin.enabled = false;
        recovery = false;
        save();
        if (existsSync(startupPath)) rmSync(startupPath);
    }

    function originalFiles(id: string): PluginFiles {
        const plugin = recordFor(id);
        const path = join(versionPath(id, plugin.current), "source.json");
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 75 * 1024 * 1024) throw new Error("The saved source package is invalid or too large.");
        const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!isRecord(raw)) throw new Error("The saved plugin source is invalid.");
        return Object.fromEntries(Object.entries(raw).map(([name, value]) => {
            if (typeof value !== "string") throw new Error("The saved plugin source is invalid.");
            return [packagePath(name), Buffer.from(value, "base64")];
        }));
    }

    function updateCheckState(lastChecked: number, retryAt: number, error?: string, updates?: ReadonlyMap<string, boolean>) {
        for (const [id, available] of updates ?? []) recordFor(id).updateAvailable = available;
        index.lastChecked = lastChecked;
        index.retryAt = retryAt;
        index.error = error;
        save();
    }

    function setUpdateAvailable(id: string, available: boolean) {
        const plugin = recordFor(id);
        if (Boolean(plugin.updateAvailable) === available) return;
        plugin.updateAvailable = available;
        save();
    }

    return {
        status, recordFor, assertAvailable, install, setEnabled, remove, rollback, startup, markStartup, completeStartup,
        nativeStartup: () => { startup(); return [...nativeBundles]; },
        compatibilityStartup: (id: string) => { startup(); return compatibilityPackages.get(id); },
        installBatch,
        reportFailure, recover, originalFiles, updateCheckState, setUpdateAvailable,
        canCheck: (force: boolean) => Date.now() >= index.retryAt && (force || Date.now() - index.lastChecked >= 86_400_000)
    };
}
