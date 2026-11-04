/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { UserPluginStartup } from "@shared/userPlugins";
import type { IpcMainInvokeEvent } from "electron";
import { createRequire, Module } from "module";
import { dirname } from "path";

export interface UserPluginNativeBundle {
    id: string;
    name: string;
    code: string;
    filename: string;
}

interface NativeStartupCallbacks {
    markStartup(id: string | null): void;
    reportFailure(id: string, message: string): void;
}

type NativeMethod = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const reservedNames = new Set(["__proto__", "prototype", "constructor"]);
const methodName = /^[A-Za-z_$][\w$]*$/;

export function createUserPluginNativeRuntime(bundledNames: readonly string[], callbacks: NativeStartupCallbacks) {
    const helpers = new Map<string, Map<string, NativeMethod>>();
    const reserved = new Set(bundledNames.map(name => name.toLowerCase()));
    let initialized = false;

    function initialize(bundles: readonly UserPluginNativeBundle[], startup: UserPluginStartup) {
        if (initialized) return;
        initialized = true;
        if (startup.disabled || startup.recovery) return;

        const pending = new Map(startup.plugins.map(plugin => [plugin.manifest.name, plugin]));
        const native = new Map(bundles.map(bundle => [bundle.id, bundle]));
        const attempted = new Set<string>();
        const loading = new Set<string>();
        const failed = new Map<string, string>();

        function fail(id: string, name: string, message: string) {
            failed.set(name, message);
            if (!startup.errors.some(error => error.id === id)) startup.errors.push({ id, message });
            callbacks.reportFailure(id, message);
        }

        function load(name: string) {
            const item = pending.get(name);
            if (!item || attempted.has(name)) return;
            const { manifest } = item;
            if (loading.has(name)) {
                fail(manifest.id, name, `Required plugin ${name} has a dependency cycle.`);
                return;
            }
            loading.add(name);
            let evaluating = false;
            try {
                for (const dependency of manifest.dependencies) {
                    load(dependency);
                    if (failed.has(dependency)) throw new Error(`Required plugin ${dependency} could not load its native helper.`);
                }
                if (!manifest.native) return;
                if (reserved.has(name.toLowerCase()) || reservedNames.has(name)) throw new Error("Native user plugins cannot replace bundled plugin helpers.");
                const bundle = native.get(manifest.id);
                if (!bundle || bundle.name !== name) throw new Error("The trusted native helper is unavailable. Reinstall the plugin before enabling it.");
                callbacks.markStartup(manifest.id);
                evaluating = true;
                const require = createRequire(bundle.filename);
                const module = new Module(bundle.filename);
                module.filename = bundle.filename;
                module.paths = require.resolve.paths("noyucord-userplugin") ?? [];
                module.require = require;
                const evaluate = new Function("exports", "require", "module", "__filename", "__dirname", `${bundle.code}\n//# sourceURL=noyucord-userplugin-native://${manifest.id}/native.js`);
                evaluate.call(module.exports, module.exports, require, module, bundle.filename, dirname(bundle.filename));
                module.loaded = true;
                const exported: unknown = module.exports;
                if (exported === null || typeof exported !== "object") throw new Error("Native helpers must export named functions.");
                const methods = new Map<string, NativeMethod>();
                for (const [name, method] of Object.entries(exported)) {
                    if (typeof method !== "function") continue;
                    if (!methodName.test(name) || reservedNames.has(name)) throw new Error("The native helper contains an unsupported method name.");
                    methods.set(name, (event, ...args) => Reflect.apply(method, exported, [event, ...args]));
                }
                if (!methods.size) throw new Error("The native helper does not export any callable methods.");
                helpers.set(name, methods);
            } catch (error) {
                const message = error instanceof Error ? error.message : "The native helper could not be loaded.";
                fail(manifest.id, name, message);
            } finally {
                loading.delete(name);
                attempted.add(name);
                if (evaluating) callbacks.markStartup(null);
            }
        }

        for (const name of pending.keys()) load(name);
        startup.plugins = startup.plugins.filter(plugin => !failed.has(plugin.manifest.name));
    }

    function methods(): Record<string, string[]> {
        return Object.fromEntries([...helpers].map(([name, methods]) => [name, [...methods.keys()]]));
    }

    async function invoke(event: IpcMainInvokeEvent, plugin: unknown, method: unknown, args: unknown): Promise<unknown> {
        if (typeof plugin !== "string" || typeof method !== "string" || !Array.isArray(args) || args.length > 100)
            throw new Error("The native plugin call is invalid.");
        const handler = helpers.get(plugin)?.get(method);
        if (!handler) throw new Error("The native plugin helper is unavailable. Fully quit and reopen the client after changing native plugins.");
        return handler(event, ...args);
    }

    return { initialize, methods, invoke };
}
