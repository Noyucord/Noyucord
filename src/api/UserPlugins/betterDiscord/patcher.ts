/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isRecord } from "./types";

type Callable = (this: unknown, ...args: unknown[]) => unknown;
type PatchType = "before" | "instead" | "after";

interface ChildPatch {
    caller: string;
    type: PatchType;
    callback: Callable;
    owner: symbol;
    reportError(error: unknown): void;
    unpatch(): void;
}

interface MethodPatch {
    object: Record<string, unknown>;
    key: string;
    original: Callable;
    descriptor?: PropertyDescriptor;
    restoreWithAssignment: boolean;
    wrapper: Callable;
    children: ChildPatch[];
    before: ChildPatch[];
    instead: ChildPatch[];
    after: ChildPatch[];
}

const methods = new WeakMap<object, Map<string, MethodPatch>>();

export function createBetterDiscordPatcher(reportError: (error: unknown) => void, assertActive: () => void = () => {}) {
    const owner = Symbol("BetterDiscord patch owner");
    const owned = new Set<ChildPatch>();

    function patch(type: PatchType, caller: string, object: unknown, key: string, callback: Callable, options: { forcePatch?: boolean; } = {}) {
        assertActive();
        if (!isRecord(object) || typeof key !== "string" || typeof callback !== "function") return null;
        if (typeof object[key] !== "function" && (options.forcePatch === false || Boolean(object[key]))) return null;
        let entries = methods.get(object);
        if (!entries) methods.set(object, entries = new Map());
        let method = entries.get(key);
        if (!method || object[key] !== method.wrapper) {
            const original = typeof object[key] === "function" ? object[key] as Callable : () => undefined;
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            const created: MethodPatch = { object, key, original, descriptor, restoreWithAssignment: false, wrapper: original, children: [], before: [], instead: [], after: [] };
            created.wrapper = function (this: unknown, ...args: unknown[]) {
                let returned: unknown;
                const { before, instead, after } = created;
                for (const child of before) {
                    try { child.callback(this, args); } catch (error) { child.reportError(error); }
                }
                if (!instead.length) returned = Reflect.apply(original, this, args);
                else {
                    const call = (index: number, receiver: unknown, parameters: unknown[]): unknown => {
                        const child = instead[index];
                        if (!child) return returned = Reflect.apply(original, receiver, parameters);
                        const next: Callable = function (this: unknown, ...nextArgs: unknown[]) { return call(index + 1, this, nextArgs); };
                        try {
                            const value = child.callback(receiver, parameters, next);
                            if (value !== undefined) returned = value;
                        } catch (error) { child.reportError(error); }
                        return returned;
                    };
                    call(0, this, args);
                }
                for (const child of after) {
                    try {
                        const value = child.callback(this, args, returned);
                        if (value !== undefined) returned = value;
                    } catch (error) { child.reportError(error); }
                }
                return returned;
            };
            Object.assign(created.wrapper, original, { __originalFunction: original, toString: () => original.toString() });
            if (!Reflect.set(object, key, created.wrapper) || object[key] !== created.wrapper) {
                if (descriptor && !descriptor.configurable) return null;
                if (!Reflect.defineProperty(object, key, {
                    configurable: true, enumerable: descriptor?.enumerable ?? true, writable: true, value: created.wrapper
                }) || object[key] !== created.wrapper) return null;
            }
            created.restoreWithAssignment = descriptor ? !Object.hasOwn(descriptor, "value") : !Object.hasOwn(object, key);
            entries.set(key, created);
            method = created;
        }
        const target = method;
        const child: ChildPatch = {
            caller, type, callback, owner, reportError,
            unpatch() {
                const index = target.children.indexOf(child);
                if (index === -1) return;
                target.children = target.children.filter(entry => entry !== child);
                target[type] = target[type].filter(entry => entry !== child);
                owned.delete(child);
                if (target.children.length || object[key] !== target.wrapper) return;
                if (target.restoreWithAssignment && (!Reflect.set(object, key, target.original) || object[key] !== target.original))
                    throw new TypeError(`Cannot restore accessor-backed method ${key}.`);
                if (target.descriptor) Object.defineProperty(object, key, target.descriptor);
                else Reflect.deleteProperty(object, key);
                entries.delete(key);
            }
        };
        target.children.push(child);
        target[type] = [...target[type], child];
        owned.add(child);
        return child.unpatch;
    }

    const api = {
        before: (caller: string, object: unknown, key: string, callback: Callable, options?: { forcePatch?: boolean; }) => patch("before", caller, object, key, callback, options),
        instead: (caller: string, object: unknown, key: string, callback: Callable, options?: { forcePatch?: boolean; }) => patch("instead", caller, object, key, callback, options),
        after: (caller: string, object: unknown, key: string, callback: Callable, options?: { forcePatch?: boolean; }) => patch("after", caller, object, key, callback, options),
        getPatchesByCaller: (caller: string) => [...owned].filter(child => child.caller === caller),
        unpatchAll(caller?: string | ChildPatch[]) {
            for (const child of Array.isArray(caller) ? caller : [...owned].filter(child => caller === undefined || child.caller === caller)) {
                if (child.owner === owner) { try { child.unpatch(); } catch (error) { child.reportError(error); } }
            }
        }
    };
    return api;
}
