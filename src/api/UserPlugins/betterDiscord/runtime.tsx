/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import type { BetterDiscordSnapshot, UserPluginNative, UserPluginStartup, UserPluginStatus } from "@shared/userPlugins";
import { Plugin, StartAt } from "@utils/types";
import { React, useEffect, useMemo, useRef } from "@webpack/common";

import { createBetterDiscordApi } from "./api";
import { createProviderAdapter } from "./providers";
import { BetterDiscordAddon, isRecord, unwrap } from "./types";

type StartupPlugin = UserPluginStartup["plugins"][number];

interface LoadedPlugin {
    item: StartupPlugin;
    api?: ReturnType<typeof createBetterDiscordApi>;
    snapshot?: BetterDiscordSnapshot;
    provider?: ReturnType<typeof createProviderAdapter>;
    instance?: Record<string, unknown>;
    exports?: unknown;
    active: boolean;
    generation: number;
    timers: Set<ReturnType<typeof setTimeout>>;
    cleanups: Set<() => void>;
}

interface WindowListener {
    wrapped: EventListener;
    cancel(): void;
    signals: Set<AbortSignal>;
}

function trackWindowListeners(cleanups: Set<() => void>, assertActive: () => void) {
    const listeners = new Map<string, Map<EventListenerOrEventListenerObject, { capture?: WindowListener; bubble?: WindowListener; }>>();

    function addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
        assertActive();
        type = `${type}`;
        if (listener === null || (typeof listener !== "function" && typeof listener !== "object")) { Reflect.apply(window.addEventListener, window, [type, listener, options]); return; }
        const { capture: selectedCapture, once: selectedOnce, passive, signal } = typeof options === "boolean" ? { capture: options } : options ?? {};
        const capture = Boolean(selectedCapture);
        const once = Boolean(selectedOnce);
        const normalized = { capture, once, signal, ...(passive === undefined ? {} : { passive: Boolean(passive) }) };
        const kind = capture ? "capture" : "bubble";
        let callbacks = listeners.get(type);
        let entry = callbacks?.get(listener);
        let registration = entry?.[kind];
        if (registration) {
            window.addEventListener(type, registration.wrapped, normalized);
        } else {
            const signals = new Set<AbortSignal>();
            const release = () => {
                cleanups.delete(cancel);
                for (const signal of signals) signal.removeEventListener("abort", cancel);
                signals.clear();
                if (entry) delete entry[kind];
                if (entry && !entry.capture && !entry.bubble) callbacks?.delete(listener);
                if (!callbacks?.size) listeners.delete(type);
            };
            const wrapped: EventListener = function (this: EventTarget, event) {
                // Native once removal does not release the plugin's ownership records.
                if (once) release();
                if (typeof listener === "function") Reflect.apply(listener, this, [event]);
                else listener.handleEvent(event);
            };
            const cancel = () => { window.removeEventListener(type, wrapped, capture); release(); };
            window.addEventListener(type, wrapped, normalized);
            if (signal?.aborted) return;
            if (!callbacks) listeners.set(type, callbacks = new Map());
            if (!entry) callbacks.set(listener, entry = {});
            registration = entry[kind] = { wrapped, cancel, signals };
            cleanups.add(cancel);
        }
        if (signal && !signal.aborted && !registration.signals.has(signal)) {
            registration.signals.add(signal);
            signal.addEventListener("abort", registration.cancel, { once: true });
        }
    }

    function removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
        type = `${type}`;
        const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
        const registration = listener === null ? undefined : listeners.get(type)?.get(listener)?.[capture ? "capture" : "bubble"];
        if (registration) registration.cancel();
        else Reflect.apply(window.removeEventListener, window, [type, listener, capture]);
    }

    return { addEventListener, removeEventListener };
}

function SettingsPanel({ state }: { state: LoadedPlugin; }) {
    const container = useRef<HTMLDivElement>(null);
    const panel = useMemo(() => {
        const method = state.instance?.getSettingsPanel;
        return typeof method === "function" ? Reflect.apply(method, state.instance, []) as React.ReactNode | HTMLElement | React.ComponentType : null;
    }, [state]);
    useEffect(() => {
        if (!(panel instanceof HTMLElement) || !container.current) return;
        container.current.append(panel);
        return () => { state.api?.releaseElement(panel); panel.remove(); };
    }, [panel]);
    if (!state.instance) return <Paragraph>Enable this plugin and restart Discord to configure it.</Paragraph>;
    if (panel instanceof HTMLElement) return <div ref={container} />;
    if (typeof panel === "function") return React.createElement(panel);
    if (typeof panel === "string") return <div dangerouslySetInnerHTML={{ __html: panel }} />;
    return panel;
}

export function createBetterDiscordRuntime(items: readonly StartupPlugin[], native: UserPluginNative, reportError: (name: string, error: unknown) => void,
    getThemes: () => Promise<BetterDiscordAddon[]> = async () => []) {
    const states = new Map<string, LoadedPlugin>(items.filter(item => item.manifest.runtime === "betterdiscord").map(item => [item.manifest.name, {
        item, active: false, generation: 0, timers: new Set<ReturnType<typeof setTimeout>>(), cleanups: new Set<() => void>()
    } satisfies LoadedPlugin] as const));
    const packages = new Map(items.map(item => [item.manifest.name, item]));
    const required = new Set<string>();
    const dependencies = items.filter(item => !item.manifest.betterDiscord?.provider).flatMap(item => item.manifest.dependencies);
    for (let index = 0; index < dependencies.length; index++) {
        const name = dependencies[index];
        if (required.has(name)) continue;
        required.add(name);
        dependencies.push(...(packages.get(name)?.manifest.dependencies ?? []));
    }
    let installed: UserPluginStatus["plugins"] = items.map(item => ({ manifest: item.manifest, source: { kind: "local" }, enabled: true, revision: item.revision ?? "", installedAt: 0, hasBackup: false }));
    let statusPromise: Promise<void> | undefined;
    let themes: BetterDiscordAddon[] = [];
    let themeError: unknown;
    let updateNotice = false;
    const observing = new Set<LoadedPlugin>();
    let observer: MutationObserver | undefined;

    function observe(state: LoadedPlugin) {
        observing.add(state);
        if (!observer) {
            observer = new MutationObserver(records => {
                for (const current of [...observing]) for (const record of records) callback(current, "observer", record);
            });
            observer.observe(document, { childList: true, subtree: true });
        }
        return () => {
            observing.delete(state);
            if (observing.size || !observer) return;
            observer.disconnect();
            observer = undefined;
        };
    }

    function status() {
        if (statusPromise) return statusPromise;
        const themeHeaders = getThemes().catch(error => { themeError = error; return []; });
        return statusPromise = Promise.all([native.list(), themeHeaders]).then(([result, currentThemes]) => { installed = unwrap(result).plugins; themes = currentThemes; });
    }

    function requestUpdate(name: string): never {
        if (!updateNotice) {
            updateNotice = true;
            showNotification({ title: "User plugin updates", body: "Open User plugins to review and install updates. Changes take effect after restarting Discord.", noPersist: true });
        }
        throw new Error(`Updates for ${name} are managed in Noyucord's User plugins settings.`);
    }

    async function checkUpdates() {
        const result = unwrap(await native.checkUpdates(false));
        installed = result.plugins;
        return result;
    }

    function addons(): BetterDiscordAddon[] {
        return installed.filter(plugin => plugin.manifest.runtime === "betterdiscord").map(plugin => {
            const state = states.get(plugin.manifest.name);
            return {
                ...plugin.manifest.betterDiscord?.metadata,
                id: plugin.manifest.id, name: plugin.manifest.name, version: plugin.manifest.version,
                description: plugin.manifest.description, author: plugin.manifest.authors.map(author => author.name).join(", "),
                filename: `${plugin.manifest.id}.plugin.js`, enabled: plugin.enabled,
                instance: state?.instance, exports: state?.exports, provider: plugin.manifest.betterDiscord?.provider
            };
        });
    }

    function getApi(state: LoadedPlugin): ReturnType<typeof createBetterDiscordApi> {
        if (state.api) return state.api;
        const { manifest } = state.item;
        const snapshot = state.snapshot ??= unwrap(native.betterDiscordSnapshot(manifest.id));
        state.api = createBetterDiscordApi({
            manifest, snapshot,
            operation: operation => native.betterDiscordOperation(manifest.id, operation),
            request: request => native.betterDiscordRequest(manifest.id, request),
            flushData: () => native.flushBetterDiscordData(), addons, themes: () => { if (themeError) throw themeError; return themes; },
            setEnabled: async (id, enabled) => {
                unwrap(await native.setEnabled(id, enabled));
                installed = unwrap(await native.list()).plugins;
                showNotification({ title: "Restart required", body: "Restart Discord from User plugins to apply the plugin change.", noPersist: true });
            },
            reload: id => {
                const target = installed.find(plugin => plugin.manifest.id === id);
                if (!target) throw new Error("The BetterDiscord plugin was not found.");
                showNotification({ title: "Restart required", body: `Restart Discord from User plugins to reload ${target.manifest.name}.`, noPersist: true });
            },
            checkUpdates: async () => { await checkUpdates(); },
            reportError: error => reportError(manifest.name, error),
            resolve: name => { const target = states.get(name) ?? [...states.values()].find(state => state.item.manifest.id === name); return target && target !== state ? getApi(target) : undefined; }
        });
        if (Reflect.get(window, "BdApi") === undefined) Object.defineProperty(window, "BdApi", { configurable: true, value: state.api.BdApi });
        return state.api;
    }

    function dispose(state: LoadedPlugin) {
        state.generation++;
        const { name } = state.item.manifest;
        const release = (cleanup: () => void) => { try { cleanup(); } catch (error) { reportError(name, error); } };
        for (const timer of state.timers) { clearTimeout(timer); clearInterval(timer); }
        state.timers.clear();
        for (const cleanup of state.cleanups) release(cleanup);
        state.cleanups.clear();
        for (const owner of states.values()) if (owner.api) release(() => owner.api?.disposeCaller(name));
        release(() => state.provider?.dispose());
        release(() => state.api?.dispose());
        state.active = false;
    }

    function callback(state: LoadedPlugin, method: string, ...args: unknown[]) {
        const handler = state.instance?.[method];
        if (typeof handler !== "function") return;
        try { return Reflect.apply(handler, state.instance, args); }
        catch (error) { reportError(state.item.manifest.name, error); }
    }

    function createPlugin(item: StartupPlugin): Plugin {
        const state = states.get(item.manifest.name);
        if (!state) throw new Error("The BetterDiscord startup package is missing.");
        const { manifest } = item;
        return {
            name: manifest.name, description: manifest.description,
            started: false, enabledByDefault: false,
            authors: manifest.authors.map(author => ({ name: author.name, id: BigInt(author.id ?? "0") })),
            dependencies: [...new Set([...manifest.dependencies, "ContextMenuAPI", "NoticesAPI"])],
            startAt: StartAt.WebpackReady, requiresRestart: true,
            settingsAboutComponent: () => <ErrorBoundary><SettingsPanel state={state} /></ErrorBoundary>,
            async start() {
                if (manifest.betterDiscord?.provider && !required.has(manifest.name)) return;
                const generation = ++state.generation;
                const current = () => generation === state.generation;
                const settle = async (value: unknown) => {
                    try { await value; } catch (error) { if (current()) throw error; }
                };
                await settle(status());
                if (!current()) return;
                if (manifest.betterDiscord?.metadata.runAt === "idle") await new Promise<void>(resolve => {
                    let cancel: () => void;
                    const done = () => { state.cleanups.delete(cancel); resolve(); };
                    if (typeof window.requestIdleCallback === "function") {
                        const id = window.requestIdleCallback(done, { timeout: 2000 });
                        cancel = () => { window.cancelIdleCallback(id); resolve(); };
                    } else {
                        const id = setTimeout(() => { state.timers.delete(id); done(); }, 0);
                        state.timers.add(id);
                        cancel = () => { clearTimeout(id); state.timers.delete(id); resolve(); };
                    }
                    state.cleanups.add(cancel);
                });
                if (!current()) return;
                const api = getApi(state);
                const snapshot = state.snapshot ??= unwrap(native.betterDiscordSnapshot(manifest.id));
                const profile = state.provider = createProviderAdapter(manifest, snapshot, api, {
                    checkUpdates, requestUpdate, reportError: error => reportError(manifest.name, error)
                });
                profile.beforeEvaluate();
                const module: { exports: unknown; filename: string; } = { exports: {}, filename: snapshot.filename };
                const timer = (interval: boolean, handler: (...args: unknown[]) => unknown, delay?: number, ...args: unknown[]) => {
                    if (!current()) throw new Error("This BetterDiscord plugin has stopped.");
                    if (typeof handler !== "function") throw new Error("BetterDiscord timer callbacks must be functions.");
                    const run = () => {
                        if (!interval) state.timers.delete(id);
                        if (!current()) return;
                        try {
                            const result = handler(...args);
                            if (isRecord(result) && typeof result.then === "function") void Promise.resolve(result).catch(error => { if (current()) reportError(manifest.name, error); });
                        } catch (error) { reportError(manifest.name, error); }
                    };
                    const id = interval ? setInterval(run, delay) : setTimeout(run, delay);
                    state.timers.add(id);
                    return id;
                };
                const timeout = timer.bind(undefined, false);
                const interval = timer.bind(undefined, true);
                const clearTimer = (id: ReturnType<typeof setTimeout>) => { clearTimeout(id); clearInterval(id); state.timers.delete(id); };
                const listeners = trackWindowListeners(state.cleanups, () => { if (!current()) throw new Error("This BetterDiscord plugin has stopped."); });
                const scopedWindow: Window & typeof globalThis = new Proxy(window, {
                    get(target, key) {
                        if (key === "window" || key === "self" || key === "globalThis") return scopedWindow;
                        if (key === "webpackChunkdiscord_app") return webpackChunks;
                        if (key === "BdApi") return api.BdApi;
                        if (key === "require") return api.require;
                        if (key === "process") return api.process;
                        if (key === "Buffer") return api.Buffer;
                        if (key === "fetch") return profile.fetch;
                        if (key === "setTimeout") return timeout;
                        if (key === "setInterval") return interval;
                        if (key === "clearTimeout" || key === "clearInterval") return clearTimer;
                        if (key === "addEventListener") return listeners.addEventListener;
                        if (key === "removeEventListener") return listeners.removeEventListener;
                        const value: unknown = Reflect.get(target, key, target);
                        return typeof value === "function" && ["dispatchEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(String(key)) ? value.bind(target) : value;
                    },
                    set(target, key, value) {
                        if (!current()) throw new Error("This BetterDiscord plugin has stopped.");
                        return Reflect.set(target, key, value, target);
                    }
                });
                const webpackChunks = profile.webpackChunk(Reflect.get(window, "webpackChunkdiscord_app"), scopedWindow);
                const evaluate = new Function("module", "exports", "require", "BdApi", "__filename", "__dirname", "Buffer", "process", "fetch", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "window", "globalThis", "global", "webpackChunkdiscord_app", "__noyucordProvider", `${profile.transform(item.code)}\n//# sourceURL=noyucord-betterdiscord://${manifest.id}/plugin.js`);
                evaluate(module, module.exports, api.require, api.BdApi, snapshot.filename, snapshot.directory, api.Buffer, api.process, profile.fetch,
                    timeout, interval, clearTimer, clearTimer, scopedWindow, scopedWindow, scopedWindow, webpackChunks, profile.scope);
                const exported: unknown = isRecord(module.exports) && "default" in module.exports ? module.exports.default : module.exports;
                if (typeof exported !== "function") throw new Error("BetterDiscord plugins must export a class or factory function.");
                profile.afterEvaluate();
                state.exports = exported;
                const metadata = { ...manifest.betterDiscord?.metadata, name: manifest.name, author: manifest.authors.map(author => author.name).join(", "), version: manifest.version, description: manifest.description, filename: snapshot.filename };
                const instance: unknown = Reflect.get(exported, "prototype") ? Reflect.construct(exported, [metadata]) : Reflect.apply(exported, undefined, [metadata]);
                if (!isRecord(instance) || typeof instance.start !== "function" || typeof instance.stop !== "function")
                    throw new Error("BetterDiscord plugins must provide start and stop methods.");
                state.instance = instance;
                if (typeof instance.load === "function") await settle(Reflect.apply(instance.load, instance, []));
                if (!current()) return;
                profile.afterEvaluate();
                await settle(Reflect.apply(instance.start, instance, []));
                if (!current()) return;
                await settle(profile.ready);
                if (!current()) return;
                state.active = true;
                if (typeof instance.observer === "function") state.cleanups.add(observe(state));
                if (typeof instance.onSwitch === "function") {
                    const navigate = () => { callback(state, "onSwitch"); };
                    window.addEventListener("popstate", navigate);
                    const navigation = Reflect.get(window, "navigation");
                    if (navigation instanceof EventTarget) navigation.addEventListener("navigate", navigate);
                    state.cleanups.add(() => {
                        window.removeEventListener("popstate", navigate);
                        if (navigation instanceof EventTarget) navigation.removeEventListener("navigate", navigate);
                    });
                }
            },
            stop() {
                try {
                    const stop = state.instance?.stop;
                    if (typeof stop === "function") return Reflect.apply(stop, state.instance, []);
                } finally { dispose(state); }
            }
        };
    }

    return { createPlugin };
}
