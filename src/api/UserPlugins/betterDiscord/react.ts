/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";
import type { ComponentClass, ReactNode } from "react";

import { isRecord } from "./types";

type Render = (...args: unknown[]) => unknown;
type NodeCallback = (props: unknown, result: ReactNode, instance?: unknown) => ReactNode | void;

interface ChangeStore {
    addChangeListener(listener: () => void): unknown;
    removeChangeListener(listener: () => void): unknown;
}

const memoType = Symbol.for("react.memo");
const forwardRefType = Symbol.for("react.forward_ref");
const lazyType = Symbol.for("react.lazy");
const suspended = "Minified React error #460; visit https://react.dev/errors/460 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
const unresolved = Symbol("unresolved");

export function getType(value: unknown): unknown {
    while (isRecord(value)) {
        if (value.$$typeof === memoType) value = value.type;
        else if (value.$$typeof === forwardRefType) value = value.render;
        else if (value.$$typeof === lazyType) {
            const payload = value._payload;
            value = isRecord(payload) && payload._status === 1 && isRecord(payload._result) ? payload._result.default : () => null;
        } else return value;
    }
    return value;
}

const contextValue = (context: unknown) => isRecord(context) ? context._currentValue : undefined;
const placeholderHooks: Record<string, Render> = {
    use(usable) {
        if (!isRecord(usable) || typeof usable.then !== "function") return contextValue(usable);
        let value: unknown = unresolved;
        Reflect.apply(usable.then, usable, [(result: unknown) => { value = result; }]);
        if (value === unresolved) throw new Error(suspended);
        return value;
    },
    readContext: contextValue,
    useContext: contextValue,
    useMemo: factory => (factory as () => unknown)(),
    useState: initial => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}],
    useReducer: (_reducer, initial) => [initial, () => {}],
    useRef: (value = null) => ({ current: value }),
    useCallback: callback => callback,
    useEffect() {},
    useLayoutEffect() {},
    useInsertionEffect() {},
    useImperativeHandle() {},
    useDebugValue() {},
    useTransition: () => [false, (callback: () => void) => callback()],
    useActionState: (_action, initial) => [initial, () => {}, false],
    useFormState: (_action, initial) => [initial, () => {}, false],
    useOptimistic: passthrough => [passthrough, () => {}],
    useDeferredValue: value => value,
    useSyncExternalStore: (_subscribe, getSnapshot) => (getSnapshot as () => unknown)(),
    useId: () => Math.random().toString(36).slice(2, 11)
};

export function wrapInHooks(component: unknown, customHooks: Record<string, Render> = {}) {
    const render = getType(component);
    if (typeof render !== "function") throw new TypeError("ReactUtils.wrapInHooks requires a function component.");
    return function WrappedInHooks(props: unknown) {
        const internals = Reflect.get(React, "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE");
        if (!isRecord(internals)) throw new Error("ReactUtils.wrapInHooks could not access React's hook dispatcher.");
        const previous = internals.H;
        const saved = isRecord(previous) ? { ...previous } : undefined;
        const dispatcher = isRecord(previous) ? previous : {};
        Object.assign(dispatcher, placeholderHooks, customHooks);
        internals.H = dispatcher;
        try {
            return Reflect.apply(render, undefined, [props]);
        } catch (error) {
            if (error instanceof Error && error.message === suspended) return;
            throw error;
        } finally {
            if (saved) Object.assign(dispatcher, saved);
            internals.H = previous;
        }
    };
}

function isComponentClass(value: unknown): value is ComponentClass {
    return typeof value === "function" && isRecord(value.prototype) && Boolean(value.prototype.isReactComponent);
}

export function createNodePatcher() {
    const id = Symbol("BetterDiscord.NodePatcher");
    const patched = new WeakMap<object, unknown>();
    let destroyed = false;
    function remember(original: object, replacement: unknown) {
        patched.set(original, replacement);
        if (isRecord(replacement)) {
            patched.set(replacement, replacement);
            Reflect.set(replacement, id, replacement);
        }
    }
    function patch(node: { type: unknown; }, callback: NodeCallback) {
        if (destroyed) return;
        const { type } = node;
        const Base = node.type;
        if (!isRecord(type)) return;
        const known = patched.get(type) ?? Reflect.get(type, id);
        if (known) { node.type = known; return; }
        if (isComponentClass(Base)) {
            class Patched extends Base {
                render() {
                    const result = super.render();
                    if (destroyed) return result;
                    const replaced = callback(this.props, result, this);
                    return replaced === undefined ? result : replaced;
                }
            }
            remember(type, Patched);
            node.type = Patched;
            return;
        }
        const render = getType(type);
        if (typeof render !== "function") return;
        function Patched(...args: unknown[]) {
            const result: unknown = Reflect.apply(render as Render, undefined, args);
            const props = args.length === 1 ? args[0] : Object.assign({ ref: args[1] }, args[0]);
            const finish = (value: unknown) => {
                if (destroyed) return value;
                const replaced = callback(props, value as ReactNode);
                return replaced === undefined ? value : replaced;
            };
            return result instanceof Promise ? result.then(finish) : finish(result);
        }
        let replacement: unknown = Patched;
        if (type.$$typeof === memoType) {
            const inner = type.type;
            replacement = React.memo((isRecord(inner) && inner.render ? React.forwardRef(Patched as never) : Patched) as never, type.compare as never);
        } else if (type.$$typeof === forwardRefType) replacement = React.forwardRef(Patched as never);
        else if (type.$$typeof === lazyType) {
            const { _init, _payload } = type;
            replacement = React.lazy(async () => {
                const handle = (component: unknown) => { const lazyNode = { type: component }; patch(lazyNode, callback); return { default: lazyNode.type as never }; };
                try { return handle(await Reflect.apply(_init as Render, undefined, [_payload])); }
                catch (error) { if (isRecord(error) && "default" in error) return handle(error.default); throw error; }
            });
        }
        for (const property of ["defaultProps", "displayName", "propTypes"]) {
            const descriptor = Object.getOwnPropertyDescriptor(type, property);
            if (descriptor && isRecord(replacement)) Object.defineProperty(replacement, property, descriptor);
        }
        remember(type, replacement);
        node.type = replacement;
    }
    return { patch, destroy() { destroyed = true; } };
}

function shallowEqual(a: unknown, b: unknown) {
    if (Object.is(a, b)) return true;
    if (!isRecord(a) || !isRecord(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && Object.is(a[key], b[key]));
}

export function useForceUpdate() {
    return React.useReducer((count: number) => count + 1, 0);
}

export function useStateFromStores<T>(stores: ChangeStore | ChangeStore[], factory: () => T, deps?: readonly unknown[], isStateEqual: true | ((previous: T, next: T) => boolean) = (previous, next) => previous === next) {
    const [, forceUpdate] = useForceUpdate();
    const state = React.useRef<{ value: T; } | null>(null);
    const factoryRef = React.useRef(factory);
    const compare = React.useRef(isStateEqual === true ? shallowEqual : isStateEqual);
    const previousDeps = React.useRef(deps);
    compare.current = isStateEqual === true ? shallowEqual : isStateEqual;
    if (!state.current) state.current = { value: factory() };
    else if (!deps || !previousDeps.current) factoryRef.current = factory;
    else {
        if (deps.length !== previousDeps.current.length) throw new Error("Dependency List Size Changed!");
        if (deps.some((value, index) => !Object.is(value, previousDeps.current?.[index]))) {
            factoryRef.current = factory;
            const next = factory();
            if (!compare.current(state.current.value, next)) state.current = { value: next };
        }
    }
    previousDeps.current = deps;
    React.useInsertionEffect(() => {
        const list = Array.isArray(stores) ? stores : [stores];
        const listener = () => {
            const next = factoryRef.current();
            if (state.current && compare.current(state.current.value, next)) return;
            state.current = { value: next };
            forceUpdate();
        };
        for (const store of list) store.addChangeListener(listener);
        return () => { for (const store of list) store.removeChangeListener(listener); };
    }, []);
    return state.current.value;
}

export class Store {
    #listeners = new Set<() => void>();
    initialize() {}
    addChangeListener(listener: () => void) {
        this.#listeners.add(listener);
        return () => this.removeChangeListener(listener);
    }
    removeChangeListener(listener: () => void) {
        this.#listeners.delete(listener);
    }
    emitChange() {
        for (const listener of this.#listeners) listener();
    }
}
