/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { waitForUserPluginStartup } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { disableStyle, enableStyle, styleMap } from "@api/Styles";
import { BETTER_DISCORD_COMPATIBILITY_VERSION, USER_PLUGIN_API_VERSION } from "@shared/userPlugins";
import { Logger } from "@utils/Logger";
import { React } from "@webpack/common";
import { enableUserPluginDeclarations } from "@webpack/patcher";

import Plugins, { PluginMeta } from "~plugins";
import hostModules from "~userplugin-modules";

import * as Host from "../../Vencord";
import { createBetterDiscordRuntime } from "./betterDiscord/runtime";
import { trackUserPluginStyles } from "./resources";
import { isRecord, validateDefinition } from "./validate";

const logger = new Logger("UserPlugins");
const activeIds = new Map<string, string>();
const activeRevisions = new Map<string, string>();
const failures = new Map<string, string>();
let recovering = false;
let webpackStarted = false;
let domStarted = false;
let startupFinished = false;
let updateTimer: ReturnType<typeof setInterval> | undefined;

export const apiVersion = USER_PLUGIN_API_VERSION;
export const betterDiscord = Object.freeze({ version: BETTER_DISCORD_COMPATIBILITY_VERSION, apiVersion: "1.14.0", experimental: true });
export const native = () => VencordNative.userPlugins;
export const getActiveIds = () => new Map(activeIds);
export const getActiveRevisions = () => new Map(activeRevisions);
export const getFailures = () => new Map(failures);
export const getActiveId = (name: string) => activeIds.get(name);
export const getActiveRevision = (id: string) => activeRevisions.get(id);
export const getFailure = (id: string) => failures.get(id);
export const isRecovering = () => recovering;

async function checkUserPluginUpdates() {
    try {
        const updates = await native().checkUpdates(false);
        if (!updates.ok) return;
        const count = updates.value.plugins.filter(p => p.updateAvailable).length;
        if (count) showNotification({ title: "User plugin updates", body: `${count} update(s) available in User plugins settings.`, noPersist: true });
    } catch (error) {
        logger.warn("Could not check user plugin updates", error);
    }
}

export function reportFailure(name: string, error: unknown) {
    const id = activeIds.get(name) ?? name;
    const message = error instanceof Error ? error.message : String(error);
    if (failures.get(id) === message) return;
    failures.set(id, message);
    logger.error(`${name}: ${message}`);
    if (!IS_WEB) native().reportFailure(id, message);
}

export function loadUserPlugins() {
    if (IS_WEB || IS_REPORTER) return;

    window.Noyucord = window.Vencord = Host;
    window.NoyucordNative = VencordNative;
    const startup = native().startup();
    recovering = startup.recovery || startup.disabled;
    startup.errors.forEach(({ id, message }) => failures.set(id, message));
    if (recovering) return;
    if (startup.plugins.some(item => item.manifest.runtime === "betterdiscord" && !item.manifest.betterDiscord?.provider))
        enableUserPluginDeclarations();

    const compatibility = createBetterDiscordRuntime(startup.plugins, native(), reportFailure, async () =>
        (await VencordNative.themes.getThemesList()).map(theme => ({
            id: theme.fileName, name: theme.customName ?? theme.name, version: theme.version ?? "", description: theme.description,
            author: theme.author, filename: theme.fileName, get enabled() { return Settings.enabledThemes.includes(theme.fileName); }
        }))
    );
    const pending = new Map(startup.plugins.map(item => [item.manifest.name, item]));
    const loading = new Set<string>();
    const attempted = new Set<string>();

    function load(name: string) {
        if (Object.hasOwn(Plugins, name)) return;
        if (loading.has(name)) throw new Error(`Dependency cycle involving ${name}.`);
        if (attempted.has(name)) throw new Error(`Dependency ${name} failed to load.`);
        const item = pending.get(name);
        if (!item) throw new Error(`Dependency ${name} is not enabled or installed.`);
        const { manifest, code } = item;
        loading.add(name);
        attempted.add(name);
        const ownedStyles: string[] = [];
        try {
            for (const dependency of manifest.dependencies) load(dependency);
            if (manifest.apiVersion !== apiVersion) throw new Error("This plugin requires a different Noyucord plugin API version.");
            if (manifest.runtime === "betterdiscord") {
                Plugins[name] = compatibility.createPlugin(item);
                PluginMeta[name] = { folderName: `userplugins/${manifest.id}`, userPlugin: true, origin: "user" };
                activeIds.set(name, manifest.id);
                if (item.revision) activeRevisions.set(manifest.id, item.revision);
                Settings.plugins[name].enabled = true;
                return;
            }
            native().markStartup(manifest.id);
            const requireHost = (specifier: string): unknown => {
                if (specifier === "@noyucord/runtime") return {
                    createElement: (...args: Parameters<typeof React.createElement>) => React.createElement(...args),
                    get Fragment() { return React?.Fragment ?? Symbol.for("react.fragment"); },
                    createStyle: (name: string, css: string, managed: boolean) => {
                        const key = `userplugins/${manifest.id}/${name}`;
                        styleMap.set(key, { name: key, source: css, classNames: {}, dom: null });
                        ownedStyles.push(key);
                        if (!managed) enableStyle(key);
                        return key;
                    }
                };
                if (Object.hasOwn(hostModules, specifier)) return hostModules[specifier];
                const pluginImport = /^@(plugins|equicordplugins|noyucordplugins)\/(.+)$/.exec(specifier);
                if (pluginImport) {
                    const folder = pluginImport[2];
                    const origin = pluginImport[1] === "plugins" ? "vencord" : pluginImport[1] === "equicordplugins" ? "equicord" : "noyucord";
                    const entry = Object.entries(PluginMeta).find(([, meta]) => meta.origin === origin && meta.folderName.replace(/\/index\.tsx?$/, "").endsWith(`/${folder}`));
                    if (entry && Plugins[entry[0]]) return { default: Plugins[entry[0]], __esModule: true };
                    throw new Error(`Plugin import ${specifier} is unavailable. Declare it as a dependency.`);
                }
                throw new Error(`Unsupported import: ${specifier}.`);
            };
            const module: { exports: unknown; } = { exports: {} };
            const evaluate = new Function("module", "exports", "require", `${code}\n//# sourceURL=noyucord-userplugin://${manifest.id}/plugin.js`);
            evaluate(module, module.exports, requireHost);
            const exported = isRecord(module.exports) && "default" in module.exports ? module.exports.default : module.exports;
            validateDefinition(exported, manifest);
            trackUserPluginStyles(exported, ownedStyles);
            exported.requiresRestart = true;
            exported.enabledByDefault = false;
            exported.started = false;
            Plugins[name] = exported;
            PluginMeta[name] = { folderName: `userplugins/${manifest.id}`, userPlugin: true, origin: "user" };
            activeIds.set(name, manifest.id);
            if (item.revision) activeRevisions.set(manifest.id, item.revision);
            Settings.plugins[name].enabled = true;
        } catch (error) {
            for (const key of ownedStyles) {
                disableStyle(key);
                styleMap.delete(key);
            }
            const message = error instanceof Error ? error.message : String(error);
            failures.set(manifest.id, message);
            native().reportFailure(manifest.id, message);
            throw error;
        } finally {
            loading.delete(name);
            native().markStartup(null);
        }
    }

    for (const name of pending.keys()) {
        try {
            load(name);
        } catch (error) {
            logger.error(`Failed to load ${name}`, error);
        }
    }
}

export async function finishUserPluginStartup(stage: "webpack" | "dom" = "webpack") {
    if (IS_WEB || IS_REPORTER) return;
    if (stage === "webpack") webpackStarted = true;
    else domStarted = true;
    if (startupFinished || !webpackStarted || !domStarted) return;
    startupFinished = true;
    try {
        await waitForUserPluginStartup();
        native().completeStartup();
        const status = await native().list();
        const failedIds = new Set(failures.keys());
        if (status.ok) status.value.plugins.filter(plugin => plugin.error).forEach(plugin => failedIds.add(plugin.manifest.id));
        if (recovering || failedIds.size) showNotification({
            title: "User plugins",
            body: recovering
                ? "User plugins were skipped. Open Noyucord's User plugins settings to review recovery."
                : `${failedIds.size} user plugin(s) could not load. Open User plugins settings for details.`,
            noPersist: true
        });
        await checkUserPluginUpdates();
        updateTimer = setInterval(() => { void checkUserPluginUpdates(); }, 24 * 60 * 60 * 1000);
        window.addEventListener("pagehide", () => {
            clearInterval(updateTimer);
            updateTimer = undefined;
        }, { once: true });
    } catch (error) {
        logger.warn("Could not finish user plugin startup", error);
    }
}
