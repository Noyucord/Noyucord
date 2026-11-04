/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isRecord, unsupported } from "./types";

export interface BetterDiscordModule {
    id: string | number;
    exports: unknown;
    declarations?: Record<string, unknown>;
}

export type BetterDiscordFilter = (exports: unknown, module?: BetterDiscordModule, id?: string | number) => boolean;

export interface BetterDiscordSearchOptions {
    defaultExport?: boolean;
    searchExports?: boolean;
    searchDefault?: boolean;
    raw?: boolean;
    withKey?: boolean;
    first?: boolean;
    fatal?: boolean;
    signal?: AbortSignal;
    firstId?: string | number;
    map?: Record<string, BetterDiscordFilter>;
    declarationFilter?: BetterDiscordFilter;
    mapDeclarations?: boolean;
    target?: unknown;
}

export interface BetterDiscordWebpackHost {
    modules(): Iterable<BetterDiscordModule>;
    module?(id: string | number): BetterDiscordModule | undefined;
    source(id: string): string | undefined;
    factories?(): Record<string, unknown>;
    stores(): Iterable<[string, unknown]>;
    store?(name: string): unknown;
    subscribe(listener: (exports: unknown, id: string | number) => void): () => void;
}

function source(value: unknown): string {
    if (typeof value === "function") return String(value);
    return typeof value === "string" ? value : "";
}

function component(value: unknown): unknown {
    const visited = new Set<unknown>();
    while (isRecord(value) && !visited.has(value)) {
        visited.add(value);
        if (typeof value === "function") return value;
        if (value.$$typeof === Symbol.for("react.lazy")) {
            const payload = value._payload;
            if (!isRecord(payload) || payload._status !== 1) return;
            value = isRecord(payload._result) ? payload._result.default : undefined;
        } else value = value.type ?? value.render;
    }
    return value;
}

export const BetterDiscordFilters = {
    byKeys: (...keys: string[]): BetterDiscordFilter => value => isRecord(value) && keys.every(key => key in value),
    byPrototypeKeys: (...keys: string[]): BetterDiscordFilter => value => { const prototype = isRecord(value) ? value.prototype : undefined; return isRecord(prototype) && keys.every(key => key in prototype); },
    byStrings: (...strings: string[]): BetterDiscordFilter => value => {
        if (typeof value !== "function") return false;
        const text = source(value);
        return strings.every(string => text.includes(string));
    },
    byRegex: (regex: RegExp): BetterDiscordFilter => value => { regex.lastIndex = 0; return regex.test(source(value)); },
    bySource: (...searches: Array<string | RegExp>): BetterDiscordFilter => value => {
        const text = source(value);
        return searches.every(search => typeof search === "string" ? text.includes(search) : (search.lastIndex = 0, search.test(text)));
    },
    byDisplayName: (name: string): BetterDiscordFilter => value => isRecord(value) && value.displayName === name,
    byStoreName: (name: string): BetterDiscordFilter => value => isRecord(value) && (typeof value.getName === "function" ? Reflect.apply(value.getName, value, []) === name : isRecord(value.constructor) && value.constructor.displayName === name),
    byComponentType: (filter: BetterDiscordFilter): BetterDiscordFilter => value => filter(component(value)),
    combine: (...filters: BetterDiscordFilter[]): BetterDiscordFilter => (value, module, id) => filters.every(filter => filter(value, module, id)),
    not: (filter: BetterDiscordFilter): BetterDiscordFilter => (value, module, id) => !filter(value, module, id),
    byDestructure: (...properties: string[]): BetterDiscordFilter => value => {
        const text = source(value);
        return properties.every(property => new RegExp(`(?:\\{|,)\\s*${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:[,}:=])`).test(text));
    }
};

export function createBetterDiscordWebpack(host: BetterDiscordWebpackHost, cleanup: Set<() => void>) {
    const filters = {
        ...BetterDiscordFilters,
        bySource: (...searches: Array<string | RegExp>): BetterDiscordFilter => (_value, module) => {
            if (!module) return false;
            const text = host.source(String(module.id));
            if (text === undefined) return false;
            return searches.every(search => typeof search === "string" ? text.includes(search) : (search.lastIndex = 0, search.test(text)));
        }
    };
    function findKey(target: unknown, filter: BetterDiscordFilter, module?: BetterDiscordModule): string | undefined {
        if (!isRecord(target)) return;
        for (const key of Object.keys(target)) {
            try { if (filter(target[key], module, module?.id)) return key; }
            catch { continue; }
        }
    }

    function mapObject(target: unknown, selectors: Record<string, BetterDiscordFilter>, module: BetterDiscordModule) {
        const mapped: Record<string, unknown> = {};
        for (const [name, selector] of Object.entries(selectors)) {
            const key = findKey(target, selector, module);
            Object.defineProperty(mapped, name, key === undefined || !isRecord(target)
                ? { enumerable: true, value: undefined }
                : { enumerable: true, get: () => target[key], set: (value: unknown) => { target[key] = value; } });
        }
        return mapped;
    }

    function matches(module: BetterDiscordModule, filter: BetterDiscordFilter, options: BetterDiscordSearchOptions, first = false): unknown[] {
        const found: unknown[] = [];
        const { exports } = module;
        function accept(value: unknown, object: unknown, key: string) {
            if (!isRecord(value) || ArrayBuffer.isView(value)) return;
            let accepted: boolean;
            try {
                if ((typeof window !== "undefined" && Object.is(value, window)) || (typeof document !== "undefined" && Object.is(value, document.documentElement)) || Reflect.get(value, Symbol.toStringTag) === "DOMTokenList") return;
                if (value.getToken || value.getEmail || value.showToken) return;
                accepted = filter(value, module, module.id);
            } catch { return; }
            if (!accepted) return;
            if (options.declarationFilter) {
                const declared = findKey(module.declarations, options.declarationFilter, module);
                if (declared !== undefined && module.declarations)
                    found.push(options.withKey ? [module.declarations, declared] : module.declarations[declared]);
                return true;
            }
            let result = options.raw ? module : options.withKey ? [object, key] : value;
            if (options.map) {
                const target = object !== module && options.raw ? exports : options.mapDeclarations ? module.declarations : value;
                result = mapObject(target, options.map, module);
            }
            found.push(result);
            return true;
        }
        const accepted = accept(exports, module, "exports");
        if (!isRecord(exports) || first && (found.length || accepted && options.declarationFilter)) return found;
        const defaultKey = "A" in exports ? "A" : "Ay" in exports ? "Ay" : exports.__esModule && "default" in exports ? "default" : undefined;
        const keys = options.searchExports ? Object.keys(exports) : options.searchDefault !== false && defaultKey ? [defaultKey] : [];
        for (const key of keys) {
            const before = found.length;
            const accepted = accept(exports[key], exports, key);
            if (before !== found.length && options.defaultExport === false && key === defaultKey && !options.searchExports && !options.raw && !options.map && !options.declarationFilter) found[found.length - 1] = options.withKey ? [module, "exports"] : exports;
            if (first && (found.length || accepted && options.declarationFilter)) break;
        }
        return found;
    }

    function orderedModules(firstId?: string | number): Iterable<BetterDiscordModule> {
        if (firstId === undefined) return host.modules();
        if (!host.module) return [...host.modules()].sort((a, b) => Number(String(b.id) === String(firstId)) - Number(String(a.id) === String(firstId)));
        const preferred = host.module(firstId);
        return (function* () {
            if (preferred) yield preferred;
            for (const module of host.modules()) if (String(module.id) !== String(firstId)) yield module;
        })();
    }

    function getModules(filter: BetterDiscordFilter, options: BetterDiscordSearchOptions = {}) {
        if (typeof filter !== "function") throw new TypeError("Webpack requires a filter function.");
        const found: unknown[] = [];
        for (const module of orderedModules(options.firstId)) found.push(...matches(module, filter, options));
        if (options.fatal && !found.length) throw new Error("BetterDiscord Webpack search did not find a matching Discord module.");
        return found;
    }

    function getModule(filter: BetterDiscordFilter, options: BetterDiscordSearchOptions = {}): unknown {
        if (options.first === false) return getModules(filter, options);
        for (const module of orderedModules(options.firstId)) {
            const found = matches(module, filter, options, true);
            if (found.length) return found[0];
        }
        if (options.fatal) throw new Error("BetterDiscord Webpack search did not find a matching Discord module.");
    }

    function getBulk(...queries: Array<BetterDiscordSearchOptions & { filter: BetterDiscordFilter; }>) {
        if (queries.some(query => query.firstId !== undefined || query.first === false)) return queries.map(query => getModule(query.filter, query));
        const results: unknown[] = new Array(queries.length).fill(undefined);
        const pending = new Map(queries.map((query, index) => [index, query]));
        for (const query of queries) if (typeof query.filter !== "function") throw new TypeError("Webpack requires a filter function.");
        if (!pending.size) return results;
        for (const module of host.modules()) {
            for (const [index, query] of pending) {
                const found = matches(module, query.filter, query, true);
                if (!found.length) continue;
                results[index] = found[0];
                pending.delete(index);
            }
            if (!pending.size) break;
        }
        if ([...pending.values()].some(query => query.fatal)) throw new Error("BetterDiscord Webpack search did not find a matching Discord module.");
        return results;
    }

    function optionsFrom(args: unknown[]): [string[], BetterDiscordSearchOptions] {
        const last = args.at(-1);
        const options: BetterDiscordSearchOptions = isRecord(last) && !(last instanceof RegExp) ? args.pop() as BetterDiscordSearchOptions : {};
        if (!args.every(arg => typeof arg === "string")) throw new TypeError("Webpack property and string searches require string arguments.");
        return [args as string[], options];
    }

    function getProxy(filter: BetterDiscordFilter, options: BetterDiscordSearchOptions & { fallback?: unknown; } = {}) {
        let resolved: unknown;
        const resolve = () => {
            if (resolved === undefined) resolved = getModule(filter, options);
            if (!isRecord(resolved)) throw new Error("BetterDiscord Webpack proxy target is not available.");
            return resolved;
        };
        return new Proxy(function () { }, {
            get: (_, key) => Reflect.get(resolve(), key),
            set: (_, key, value) => Reflect.set(resolve(), key, value),
            has: (_, key) => Reflect.has(resolve(), key),
            apply: (_, receiver, args) => {
                const target = resolve();
                if (typeof target !== "function") throw new TypeError("BetterDiscord Webpack proxy target is not callable.");
                return Reflect.apply(target, receiver, args);
            }
        });
    }

    const store = (name: string) => host.store ? host.store(name) : [...host.stores()].find(([key]) => key === name)?.[1];
    const api = {
        Filters: filters,
        modules: new Proxy({}, {
            get: (_, key) => { if (!host.factories) unsupported("Webpack.modules factories"); return typeof key === "string" ? host.factories()[key] : undefined; },
            ownKeys: () => Object.keys(host.factories?.() ?? {}),
            getOwnPropertyDescriptor: (_, key) => typeof key === "string" && Object.hasOwn(host.factories?.() ?? {}, key) ? { configurable: true, enumerable: true, value: host.factories?.()[key] } : undefined
        }),
        Stores: new Proxy({}, {
            get: (_, key) => typeof key === "string" ? store(key) : undefined,
            set: () => { throw new Error("Setting BetterDiscord Webpack stores is not allowed."); },
            ownKeys: () => [...new Set([...host.stores()].map(([name]) => name))],
            getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
        }),
        getModule, getModules,
        getById(id: string | number, options: BetterDiscordSearchOptions = {}) {
            if (!host.module) return getModule((_, module) => String(module?.id) === String(id), options);
            const module = host.module(id);
            const found = module ? matches(module, () => true, options, options.first !== false) : [];
            if (!found.length && options.fatal) throw new Error("BetterDiscord Webpack search did not find a matching Discord module.");
            return options.first === false ? found : found[0];
        },
        getWithKey(filter: BetterDiscordFilter, options: BetterDiscordSearchOptions = {}) {
            if (typeof filter !== "function") throw new TypeError("Webpack requires a filter function.");
            const target = options.target ?? getModule(value => findKey(value, filter) !== undefined, options);
            return [target, findKey(target, filter)];
        },
        getBulk,
        getBulkKeyed: (queries: Record<string, BetterDiscordSearchOptions & { filter: BetterDiscordFilter; }>) => {
            const entries = Object.entries(queries);
            const results = getBulk(...entries.map(([, query]) => query));
            return Object.fromEntries(entries.map(([name], index) => [name, results[index]]));
        },
        getStore: (name: string) => store(name) ?? getModule(BetterDiscordFilters.byStoreName(name)),
        getByKeys(...args: unknown[]) { const [keys, options] = optionsFrom(args); return getModule(BetterDiscordFilters.byKeys(...keys), options); },
        getAllByKeys(...args: unknown[]) { const [keys, options] = optionsFrom(args); return getModules(BetterDiscordFilters.byKeys(...keys), options); },
        getByPrototypeKeys(...args: unknown[]) { const [keys, options] = optionsFrom(args); return getModule(BetterDiscordFilters.byPrototypeKeys(...keys), options); },
        getAllByPrototypeKeys(...args: unknown[]) { const [keys, options] = optionsFrom(args); return getModules(BetterDiscordFilters.byPrototypeKeys(...keys), options); },
        getByStrings(...args: unknown[]) { const [strings, options] = optionsFrom(args); return getModule(BetterDiscordFilters.byStrings(...strings), options); },
        getAllByStrings(...args: unknown[]) { const [strings, options] = optionsFrom(args); return getModules(BetterDiscordFilters.byStrings(...strings), options); },
        getByRegex: (regex: RegExp, options?: BetterDiscordSearchOptions) => getModule(BetterDiscordFilters.byRegex(regex), options),
        getAllByRegex: (regex: RegExp, options?: BetterDiscordSearchOptions) => getModules(BetterDiscordFilters.byRegex(regex), options),
        getBySource(...args: Array<string | RegExp | BetterDiscordSearchOptions>) { const last = args.at(-1); const options = isRecord(last) && !(last instanceof RegExp) ? args.pop() as BetterDiscordSearchOptions : {}; return getModule(filters.bySource(...args.filter((arg): arg is string | RegExp => typeof arg === "string" || arg instanceof RegExp)), options); },
        getAllBySource(...args: Array<string | RegExp | BetterDiscordSearchOptions>) { const last = args.at(-1); const options = isRecord(last) && !(last instanceof RegExp) ? args.pop() as BetterDiscordSearchOptions : {}; return getModules(filters.bySource(...args.filter((arg): arg is string | RegExp => typeof arg === "string" || arg instanceof RegExp)), options); },
        getProxy,
        getMangled(filter: BetterDiscordFilter | string | RegExp | Array<string | RegExp> | number, selectors: Record<string, BetterDiscordFilter>, options: BetterDiscordSearchOptions = {}) {
            const selector: BetterDiscordFilter = typeof filter === "function" ? filter : (_, module) => {
                if (!module) return false;
                if (typeof filter === "number") return String(module.id) === String(filter);
                const text = host.source(String(module.id)) ?? "";
                return (Array.isArray(filter) ? filter : [filter]).every(part => typeof part === "string" ? text.includes(part) : (part.lastIndex = 0, part.test(text)));
            };
            return getModule(selector, { ...options, map: selectors });
        },
        waitForModule(filter: BetterDiscordFilter, options: BetterDiscordSearchOptions = {}): Promise<unknown> {
            if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
            const existing = getModule(filter, { ...options, fatal: false });
            if (existing !== undefined) return Promise.resolve(existing);
            return new Promise((resolve, reject) => {
                const abort = () => { cancel(); reject(options.signal?.reason ?? new DOMException("BetterDiscord module search was cancelled.", "AbortError")); };
                const unsubscribe = host.subscribe((exports, id) => {
                    const found = matches(host.module?.(id) ?? { id, exports }, filter, options);
                    if (!found.length) return;
                    cancel();
                    resolve(found[0]);
                });
                function cancel() { unsubscribe(); cleanup.delete(abort); options.signal?.removeEventListener("abort", abort); }
                cleanup.add(abort);
                options.signal?.addEventListener("abort", abort, { once: true });
            });
        }
    };
    return api;
}
