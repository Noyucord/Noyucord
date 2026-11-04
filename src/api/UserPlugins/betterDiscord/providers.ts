/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BETTER_DISCORD_LIBRARIES } from "@shared/betterDiscord";
import type { BetterDiscordSnapshot, UserPluginManifest, UserPluginStatus } from "@shared/userPlugins";
import { factoryListeners, moduleListeners } from "@webpack";

import type { createBetterDiscordApi } from "./api";
import { isRecord } from "./types";

interface ProviderHost {
    checkUpdates(): Promise<UserPluginStatus>;
    requestUpdate(name: string): never;
    reportError(error: unknown): void;
}

export function createProviderAdapter(manifest: UserPluginManifest, snapshot: BetterDiscordSnapshot, api: ReturnType<typeof createBetterDiscordApi>, host: ProviderHost) {
    const provider = manifest.betterDiscord?.provider;
    const cleanups: Array<() => void> = [];
    const hooked = new WeakSet<object>();
    const chunkViews = new WeakMap<object, { scope: object; view: unknown; }>();
    const moduleUtilitiesAnchor = "BDFDB.ModuleUtils = {};";
    const misses = new Map<string, { candidates: number; sources: number; }>();
    const loadedIds: PropertyKey[] = [];
    const factoryIds: PropertyKey[] = [];
    const candidates: object[] = [];
    const sources: string[] = [];
    let indexedLoaded = 0;
    let indexedFactories = 0;
    let webpackRequire: { c: Record<string, unknown>; m: Record<string, unknown>; } | undefined;
    let tracking = false;
    let disposed = false;
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = provider === "bdfdb" ? new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }) : Promise.resolve();
    if (provider === "bdfdb") void ready.catch(error => { if (!disposed) host.reportError(error); });

    function updates(namespace: unknown) {
        if (!isRecord(namespace) || hooked.has(namespace)) return;
        const updater = namespace.PluginUpdater;
        if (isRecord(updater)) {
            hooked.add(namespace);
            updater.checkForUpdate = async (name: string) => {
                const status = await host.checkUpdates();
                return status.plugins.some(plugin => plugin.manifest.name === name && plugin.updateAvailable);
            };
            updater.checkAllPlugins = () => host.checkUpdates();
            updater.hasUpdate = async (source: string) => {
                const status = await host.checkUpdates();
                return status.plugins.some(plugin => plugin.source.url === source && plugin.updateAvailable);
            };
            updater.updatePlugin = (source: string) => host.requestUpdate(source);
            updater.showUpdateNotice = () => host.checkUpdates();
        }
        const utilities = namespace.PluginUtils;
        if (isRecord(utilities)) {
            utilities.checkUpdate = (name: string) => host.checkUpdates().then(status => status.plugins.some(plugin => plugin.manifest.name === name && plugin.updateAvailable));
            utilities.checkAllUpdates = () => host.checkUpdates();
            utilities.downloadUpdate = (name: string) => host.requestUpdate(name);
        }
    }

    function watchBdfdb(value: unknown) {
        if (!isRecord(value)) return;
        const utilities = isRecord(value.PluginUtils) ? value.PluginUtils : value;
        const build = utilities.buildPlugin;
        if (typeof build === "function" && !hooked.has(build)) {
            const wrapped = function (this: unknown, ...args: unknown[]) {
                const result: unknown = Reflect.apply(build, this, args);
                if (Array.isArray(result)) updates(result[1]);
                return result;
            };
            hooked.add(wrapped);
            utilities.buildPlugin = wrapped;
        }
        if (value.loaded === true) resolveReady?.();
    }

    function beforeEvaluate() {
        if (provider !== "bdfdb") return;
        const originalFetch = api.BdApi.Net.fetch;
        api.BdApi.Net.fetch = fetchResource;
        cleanups.push(() => { api.BdApi.Net.fetch = originalFetch; });
        const previous = Object.getOwnPropertyDescriptor(window, "BDFDB_Global");
        if (previous && !previous.configurable) throw new Error("BDFDB compatibility could not register its library globals.");
        let value: unknown = previous?.value;
        Object.defineProperty(window, "BDFDB_Global", {
            configurable: true,
            get: () => value,
            set: next => { value = next; watchBdfdb(next); }
        });
        cleanups.push(() => {
            if (previous) Object.defineProperty(window, "BDFDB_Global", previous);
            else Reflect.deleteProperty(window, "BDFDB_Global");
        });
    }

    function afterEvaluate() {
        if (provider === "zeres") {
            const library = Reflect.get(window, "ZLibrary");
            updates(library);
            if (isRecord(library) && isRecord(library.DiscordModules)) {
                for (const name of ["React", "ReactDOM"] as const)
                    Object.defineProperty(library.DiscordModules, name, { configurable: true, get: () => api.BdApi[name] });
            }
            if (isRecord(library) && isRecord(library.ReactTools)) library.ReactTools.wrapElement = api.BdApi.ReactUtils.wrapElement;
            updates(Reflect.get(window, "ZeresPluginLibrary"));
            const scheduled = Reflect.get(window, "__PLUGIN_UPDATES__");
            if (isRecord(scheduled) && (typeof scheduled.interval === "number" || typeof scheduled.interval === "object")) {
                clearInterval(scheduled.interval as ReturnType<typeof setInterval>);
                scheduled.interval = undefined;
            }
        }
    }

    async function fetchResource(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
        if (disposed) throw new Error("This BetterDiscord library has stopped.");
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        const cachedResponse = (body: string, contentType: string) => {
            const response = new Response(body, { headers: { "Content-Type": contentType } });
            Object.defineProperty(response, "url", { value: url });
            return response;
        };
        if (provider === "bdfdb" && method.toUpperCase() === "GET") {
            const profile = BETTER_DISCORD_LIBRARIES.bdfdb;
            const assets = ["0BDFDB.data.json", "0BDFDB.raw.css"];
            const listing = "https://api.github.com/repos/mwittrien/BetterDiscordAddons/contents/Library/_res/";
            if (url.split("?")[0].replace(/\/$/, "") === listing.replace(/\/$/, "")) {
                return cachedResponse(JSON.stringify(assets.map(name => ({ name, path: `Library/_res/${name}`, sha: profile.files[name].sha, type: "file" }))), "application/json");
            }
            const name = assets.find(name => [
                `https://mwittrien.github.io/BetterDiscordAddons/Library/_res/${name}`,
                `https://raw.githubusercontent.com/${profile.repository}/${profile.revision}/${profile.files[name].source}`
            ].includes(url.split("?")[0]));
            if (name) {
                const path = Object.keys(snapshot.files).find(path => path.endsWith(`/${name}`));
                if (!path) throw new Error(`The installed BDFDB resource ${name} is missing. Reinstall its dependency package.`);
                return cachedResponse(snapshot.files[path], name.endsWith("json") ? "application/json" : "text/css");
            }
        }
        return api.fetch(input, init);
    }

    function trackModules(req: NonNullable<typeof webpackRequire>) {
        if (tracking) return;
        tracking = true;
        loadedIds.push(...Object.keys(req.c));
        factoryIds.push(...Object.keys(req.m));
        const loaded = (_exports: unknown, id: PropertyKey) => { loadedIds.push(id); };
        const added = (_factory: unknown, id: PropertyKey) => { factoryIds.push(id); };
        moduleListeners.add(loaded);
        factoryListeners.add(added);
        cleanups.push(() => { moduleListeners.delete(loaded); factoryListeners.delete(added); });
    }

    function isObject(value: unknown): value is object {
        return (typeof value === "object" || typeof value === "function") && value !== null && value !== window;
    }

    function addCandidate(value: unknown) {
        if (!isObject(value)) return;
        try {
            if (!Object.keys(value).some(key => typeof Reflect.get(value, key) === "string")) return;
        } catch { }
        candidates.push(value);
    }

    function indexModules(req: NonNullable<typeof webpackRequire>) {
        for (; indexedLoaded < loadedIds.length; indexedLoaded++) {
            const entry: unknown = Reflect.get(req.c, loadedIds[indexedLoaded]);
            const exported: unknown = isRecord(entry) ? entry.exports : undefined;
            if (!isObject(exported)) continue;
            addCandidate(exported);
            try {
                const fallback: unknown = Reflect.get(exported, "default");
                addCandidate(fallback);
                if (isRecord(fallback)) addCandidate(fallback.type);
                const keys = Object.keys(exported);
                if (keys.length < 400) for (const key of keys) {
                    try { addCandidate(Reflect.get(exported, key)); } catch { }
                }
            } catch { }
        }
        for (; indexedFactories < factoryIds.length; indexedFactories++) {
            const factory: unknown = Reflect.get(req.m, factoryIds[indexedFactories]);
            if (typeof factory !== "function") continue;
            try {
                const source = factory.toString().replace(/\s/g, "");
                if (source.includes(".exports={")) sources.push(source);
            } catch { }
        }
    }

    function mayMatch(req: NonNullable<typeof webpackRequire>, props: string[], from: { candidates: number; sources: number; }) {
        indexModules(req);
        for (let index = from.candidates; index < candidates.length; index++) {
            const value = candidates[index];
            try {
                if (props.every(prop => typeof Reflect.get(value, prop) === "string")) return true;
            } catch { return true; }
        }
        for (let index = from.sources; index < sources.length; index++) {
            const source = sources[index];
            if (props.every(prop => source.includes(`${prop}:`))) return true;
        }
        return false;
    }

    function cachedStringObject(search: Parameters<typeof Reflect.apply>[0]) {
        return function (this: unknown, props: unknown, config: unknown = {}) {
            const req = webpackRequire;
            const list = [props].flat(10).filter(prop => typeof prop === "string");
            let key: string | undefined;
            try { key = JSON.stringify([props, config]); } catch { key = undefined; }
            if (disposed || !req || !key || !list.length || isRecord(config) && config.all) return Reflect.apply(search, this, [props, config]);
            trackModules(req);
            const miss = misses.get(key) ?? { candidates: 0, sources: 0 };
            if (!mayMatch(req, list, miss)) {
                misses.set(key, miss);
                miss.candidates = candidates.length;
                miss.sources = sources.length;
                return undefined;
            }
            const snapshot = { candidates: candidates.length, sources: sources.length };
            const result: unknown = Reflect.apply(search, this, [props, config]);
            if (result) misses.delete(key);
            else misses.set(key, snapshot);
            return result;
        };
    }

    function moduleUtilities() {
        const utilities = {};
        let findStringObject: unknown;
        Object.defineProperty(utilities, "findStringObject", {
            configurable: true,
            enumerable: true,
            get: () => findStringObject,
            set: (value: unknown) => { findStringObject = typeof value === "function" ? cachedStringObject(value) : value; }
        });
        return utilities;
    }

    function transform(code: string) {
        if (provider !== "bdfdb" || code.split(moduleUtilitiesAnchor).length !== 2) return code;
        return code.replace(moduleUtilitiesAnchor, "BDFDB.ModuleUtils = __noyucordProvider.moduleUtilities();");
    }

    function webpackChunk(chunks: unknown, scopedWindow: object): unknown {
        if (provider !== "bdfdb" || !Array.isArray(chunks)) return chunks;
        const previous = chunkViews.get(chunks);
        if (previous?.scope === scopedWindow) return previous.view;
        const requires = new WeakMap<object, object>();
        const caches = new WeakMap<object, object>();
        const modules = new WeakMap<object, object>();
        function scopedRequire(value: unknown): unknown {
            if (!isRecord(value)) return value;
            const { c, m } = value;
            if (isRecord(c) && isRecord(m)) webpackRequire = { c, m };
            const existing = requires.get(value);
            if (existing) return existing;
            const require = new Proxy(value, {
                get(target, key, receiver) {
                    const cache: unknown = Reflect.get(target, key, receiver);
                    if (key !== "c" || !isRecord(cache)) return cache;
                    let cacheView = caches.get(cache);
                    if (!cacheView) {
                        cacheView = new Proxy(cache, {
                            get(target, key, receiver) {
                                const entry: unknown = Reflect.get(target, key, receiver);
                                if (!isRecord(entry) || entry.exports !== window) return entry;
                                let moduleView = modules.get(entry);
                                if (!moduleView) {
                                    moduleView = new Proxy(entry, {
                                        get(target, key, receiver) {
                                            const exported: unknown = Reflect.get(target, key, receiver);
                                            if (key !== "exports" || exported !== window) return exported;
                                            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
                                            return descriptor?.configurable === false && descriptor.writable === false ? exported : scopedWindow;
                                        }
                                    });
                                    modules.set(entry, moduleView);
                                }
                                return moduleView;
                            }
                        });
                        caches.set(cache, cacheView);
                    }
                    return cacheView;
                }
            });
            requires.set(value, require);
            return require;
        }
        const push = function (this: unknown, ...entries: unknown[]) {
            if (disposed) throw new Error("This BetterDiscord library has stopped.");
            const payloads = entries.map(entry => {
                if (!Array.isArray(entry) || typeof entry[2] !== "function") return entry;
                const callback = entry[2];
                const payload = entry.slice();
                payload[2] = function (this: unknown, ...args: unknown[]) {
                    if (disposed) throw new Error("This BetterDiscord library has stopped.");
                    args[0] = scopedRequire(args[0]);
                    return Reflect.apply(callback, this, args);
                };
                return payload;
            });
            return Reflect.apply(chunks.push, this === view ? chunks : this, payloads);
        };
        const view = new Proxy(chunks, { get: (target, key, receiver) => key === "push" ? push : Reflect.get(target, key, receiver) });
        chunkViews.set(chunks, { scope: scopedWindow, view });
        return view;
    }

    return {
        beforeEvaluate, afterEvaluate, fetch: fetchResource, webpackChunk, transform, scope: { moduleUtilities }, ready,
        dispose() {
            disposed = true;
            misses.clear();
            candidates.length = sources.length = loadedIds.length = factoryIds.length = 0;
            webpackRequire = undefined;
            rejectReady?.(new Error("The library stopped before initialization completed."));
            for (const cleanup of cleanups.toReversed()) cleanup();
            if (provider === "zeres") {
                Reflect.deleteProperty(window, "ZLibrary");
                Reflect.deleteProperty(window, "ZeresPluginLibrary");
            }
        }
    };
}
