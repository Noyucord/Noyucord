/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { commands as registeredCommands, registerCommand, sendBotMessage, unregisterCommand } from "@api/Commands";
import { addContextMenuPatch, addGlobalContextMenuPatch, removeContextMenuPatch, removeGlobalContextMenuPatch } from "@api/ContextMenu";
import { currentNotice, noticesQueue, popNotice, showNotice } from "@api/Notices";
import { showNotification } from "@api/Notifications";
import { Settings } from "@api/Settings";
import { enableStyle } from "@api/Styles";
import { Button } from "@components/Button";
import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { openInviteModal } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { cache, fluxStores, moduleListeners, wreq } from "@webpack";
import { Alerts, ContextMenuApi, createRoot, Flux, Menu, React, ReactDOM, showToast } from "@webpack/common";
import type { ComponentType, ReactElement, ReactNode } from "react";
import type { Root } from "react-dom/client";

import { betterDiscordComponents, type PanelOptions, type Setting, SettingItemControl, SettingsPanel } from "./components";
import componentStyles from "./components.css?managed";
import { createLegacyModules } from "./legacy";
import { createBetterDiscordNode } from "./node";
import { createBetterDiscordPatcher } from "./patcher";
import { createNodePatcher, getType, Store, useForceUpdate, useStateFromStores, wrapInHooks } from "./react";
import { type BetterDiscordApiContext, type BetterDiscordApiPeer, isRecord, unsupported, unwrap } from "./types";
import { type BetterDiscordFilter, type BetterDiscordModule, createBetterDiscordWebpack } from "./webpack";

const numeric = /^\d+$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

function compareIdentifier(a: string, b: string) {
    const left = numeric.test(a), right = numeric.test(b);
    if (left && right) return Math.sign(Number(a) - Number(b));
    if (a === b) return 0;
    if (left) return -1;
    if (right) return 1;
    return a < b ? -1 : 1;
}

function comparePrerelease(a = "", b = "") {
    if (a === b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    const left = a.split("."), right = b.split(".");
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        if (left[index] === undefined) return -1;
        if (right[index] === undefined) return 1;
        const difference = compareIdentifier(left[index], right[index]);
        if (difference) return difference;
    }
    return 0;
}

function semverCompare(current: string, remote: string) {
    const a = semver.exec(current), b = semver.exec(remote);
    if (!a || !b) return 0;
    for (const index of [1, 2, 3]) {
        const difference = compareIdentifier(b[index], a[index]);
        if (difference) return difference;
    }
    return comparePrerelease(b[4], a[4]);
}

function globPattern(id: string) {
    return new RegExp(`^${id.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

function isWebpackModule(value: unknown): value is BetterDiscordModule {
    return isRecord(value) && (typeof value.id === "string" || typeof value.id === "number") && "exports" in value;
}

export function createBetterDiscordData(context: BetterDiscordApiContext) {
    const saved = structuredClone(context.snapshot.data);
    const listeners = new Map<string, Set<() => void>>();
    const notify = (key: string) => { for (const listener of [...listeners.get(key) ?? []]) listener(); };
    const persist = (operation: Extract<Parameters<typeof context.operation>[0], { type: "dataSet" | "dataDelete"; }>) =>
        unwrap(context.operation(context.snapshot.dataOperations === "keys" ? operation : { type: "data", data: structuredClone(saved) }));
    return {
        load: (key: string) => saved[key] === undefined ? undefined : structuredClone(saved[key]),
        save(key: string, value: unknown) {
            if (typeof key !== "string" || !key.length) throw new TypeError("Data.save requires a nonempty key.");
            const cloned: unknown = JSON.parse(JSON.stringify(value));
            const previous = saved[key];
            const existed = Object.hasOwn(saved, key);
            Object.defineProperty(saved, key, { value: cloned, writable: true, enumerable: true, configurable: true });
            try { persist({ type: "dataSet", key, value: structuredClone(cloned) }); }
            catch (error) { if (existed) saved[key] = previous; else delete saved[key]; throw error; }
            notify(key);
        },
        delete(key: string) {
            const previous = saved[key];
            const existed = Object.hasOwn(saved, key);
            delete saved[key];
            try { persist({ type: "dataDelete", key: String(key) }); }
            catch (error) { if (existed) Object.defineProperty(saved, key, { value: previous, writable: true, enumerable: true, configurable: true }); throw error; }
            notify(key);
        },
        subscribe(key: string, listener: () => void) {
            let set = listeners.get(key);
            if (!set) listeners.set(key, set = new Set());
            set.add(listener);
            return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
        }
    };
}

export function createBetterDiscordApi(context: BetterDiscordApiContext) {
    let disposed = false;
    const assertActive = () => { if (disposed) throw new Error(`BetterDiscord plugin ${context.manifest.name} is stopped. Its compatibility API cannot create resources or perform native operations.`); };
    const guardedContext: BetterDiscordApiContext = {
        ...context,
        reportError(error) { if (!disposed) context.reportError(error); },
        operation(operation) { assertActive(); return context.operation(operation); },
        request(request) { assertActive(); return context.request(request); },
        setEnabled(id, enabled) { assertActive(); return context.setEnabled(id, enabled); },
        reload(id) { assertActive(); return context.reload(id); },
        checkUpdates() { assertActive(); return context.checkUpdates(); }
    };
    const cleanup = new Set<() => void>();
    const styles = new Map<string, HTMLStyleElement>();
    const roots = new Map<Parameters<typeof createRoot>[0], Root>();
    let showCompatibilityToasts = true;
    const logger = new Logger(`BetterDiscord: ${context.manifest.name}`);
    const release = (operation: () => void) => { try { operation(); } catch (error) { try { context.reportError(error); } catch (reportError) { logger.error("Could not report user plugin cleanup failure", reportError, error); } } };
    const patcher = createBetterDiscordPatcher(guardedContext.reportError, assertActive);
    const data = createBetterDiscordData(guardedContext);
    const node = createBetterDiscordNode(guardedContext, cleanup, assertActive);
    const legacyModules = createLegacyModules(assertActive, cleanup, guardedContext.reportError);
    const module = (id: string | number): BetterDiscordModule | undefined => {
        const entry: unknown = cache?.[String(id)];
        if (isWebpackModule(entry)) return entry;
        return legacyModules.find(module => module.id === id);
    };
    const webpack = createBetterDiscordWebpack({
        *modules() { for (const id of Object.keys(cache ?? {})) { const entry = module(id); if (entry) yield entry; } yield* legacyModules; },
        module,
        source: id => wreq?.m[id]?.toString(),
        factories: () => wreq?.m ?? {},
        stores() {
            for (const store of Flux.Store.getAll?.() ?? []) if (!fluxStores.has(store.getName())) fluxStores.set(store.getName(), store);
            return fluxStores.entries();
        },
        store(name) {
            if (!fluxStores.has(name)) for (const store of Flux.Store.getAll?.() ?? []) fluxStores.set(store.getName(), store);
            return fluxStores.get(name);
        },
        subscribe(listener) { assertActive(); const callback = (exports: unknown, id: PropertyKey) => { if (typeof id !== "symbol") listener(exports, id); }; moduleListeners.add(callback); return () => moduleListeners.delete(callback); }
    }, cleanup);
    const local: BetterDiscordApiPeer = { data, patcher };
    const peer = (name: string) => name === context.manifest.name || name === context.manifest.id ? local : context.resolve?.(name) ?? local;
    const observe = (target: Node, onRecords: (records: MutationRecord[], cancel: () => void) => void) => {
        const observer = new MutationObserver(records => onRecords(records, cancel));
        const cancel = () => { observer.disconnect(); cleanup.delete(cancel); };
        observer.observe(target, { subtree: true, childList: true });
        cleanup.add(cancel);
        return cancel;
    };
    const dom = {
        get screenWidth() { return Math.max(document.documentElement.clientWidth, window.innerWidth || 0); },
        get screenHeight() { return Math.max(document.documentElement.clientHeight, window.innerHeight || 0); },
        addStyle(id: string, css: string) {
            assertActive();
            if (typeof css !== "string" || !css) throw new TypeError("DOM.addStyle requires CSS text.");
            const owner = context.resolve?.(id);
            if (owner?.dom && owner.dom !== dom) { owner.dom.addStyle(id, css); return; }
            let style = styles.get(id);
            if (!style) { style = document.createElement("style"); style.id = id; style.dataset.noyucordUserPlugin = context.manifest.id; styles.set(id, style); document.head.append(style); }
            style.textContent = css;
        },
        removeStyle(id: string) { const owner = context.resolve?.(id); if (owner?.dom && owner.dom !== dom) { owner.dom.removeStyle(id); return; } styles.get(id)?.remove(); styles.delete(id); },
        createElement(tag: string, options: Record<string, unknown> = {}, ...children: unknown[]) {
            assertActive();
            const element = document.createElement(tag);
            const { style, ...properties } = options;
            Object.assign(element, properties);
            if (isRecord(style)) Object.assign(element.style, style);
            else if (typeof style === "string") element.style.cssText = style;
            element.append(...children.flat(Infinity).filter((child): child is Node | string => child instanceof Node || typeof child === "string"));
            const { target } = options;
            const parent = typeof target === "string" ? (() => { try { return document.querySelector(target); } catch { return null; } })() : target instanceof Element ? target : null;
            parent?.append(element);
            return element;
        },
        parseHTML(html: string, fragment = false) {
            assertActive();
            const template = document.createElement("template");
            template.innerHTML = html.trim();
            const node = template.content.cloneNode(true);
            if (fragment) return node;
            return node.childNodes.length > 1 ? node.childNodes : node.childNodes[0];
        },
        animate(update: (progress: number) => void, duration: number | { duration?: number; timing?: (progress: number) => number; } = 1000, options: { timing?: (progress: number) => number; } = {}) {
            assertActive();
            const length = typeof duration === "number" ? duration : duration.duration ?? 1000;
            const timing = typeof duration === "number" ? options.timing : duration.timing;
            const start = performance.now();
            let frame = 0;
            const cancel = () => { cancelAnimationFrame(frame); cleanup.delete(cancel); };
            const tick = (time: number) => { if (disposed) return; const progress = Math.min(1, (time - start) / length); update(timing ? timing(progress) : progress); if (progress < 1) frame = requestAnimationFrame(tick); else cleanup.delete(cancel); };
            cleanup.add(cancel);
            frame = requestAnimationFrame(tick);
            return cancel;
        },
        onAdded(selector: string, callback: (element: Element) => void) {
            assertActive();
            const existing = document.body.querySelector(selector);
            if (existing) return callback(existing);
            return observe(document.body, (records, cancel) => {
                for (const record of records) for (const node of record.addedNodes) {
                    if (!(node instanceof Element)) continue;
                    const match = node.matches(selector) ? node : node.querySelector(selector);
                    if (match) { cancel(); callback(match); return; }
                }
            });
        },
        onRemoved(node: Node, callback: () => void) {
            assertActive();
            return observe(document.body, (records, cancel) => {
                if (records.some(record => [...record.removedNodes].some(removed => removed === node || removed.contains(node)))) { cancel(); callback(); }
            });
        }
    };
    local.dom = dom;
    const ownedCreateRoot: typeof createRoot = (container, options) => {
        assertActive();
        if (roots.has(container)) throw new Error("This user plugin already owns a React root in that container.");
        const root = createRoot(container, options);
        let mounted = true;
        const owned: Root = { render: node => { assertActive(); root.render(node); }, unmount() { if (!mounted) return; mounted = false; try { root.unmount(); } finally { roots.delete(container); } } };
        roots.set(container, owned);
        return owned;
    };
    const reactDOM = {
        ...ReactDOM,
        createRoot: ownedCreateRoot,
        render(element: ReactNode, container: Element | DocumentFragment, callback?: () => void) {
            assertActive();
            let root = roots.get(container);
            if (!root) root = ownedCreateRoot(container);
            let instance: unknown = null;
            let rendered = element;
            if (React.isValidElement<{ ref?: unknown; }>(element) && typeof element.type === "function" && isRecord(element.type.prototype) && element.type.prototype.isReactComponent) {
                const originalRef = element.props.ref;
                rendered = React.cloneElement(element, { ref: (value: unknown) => {
                    instance = value;
                    if (typeof originalRef === "function") Reflect.apply(originalRef, undefined, [value]);
                    else if (isRecord(originalRef)) originalRef.current = value;
                } });
            }
            const target = root;
            ReactDOM.flushSync(() => target.render(rendered));
            if (callback) Reflect.apply(callback, instance, []);
            return instance;
        },
        unmountComponentAtNode(container: Element | DocumentFragment) { const root = roots.get(container); if (!root) return false; root.unmount(); roots.delete(container); return true; },
        findDOMNode(value: unknown) {
            if (value instanceof Node) return value;
            const fiber = isRecord(value) ? value._reactInternals ?? value._reactInternalFiber : undefined;
            const queue: unknown[] = [fiber];
            const seen = new Set<unknown>();
            while (queue.length) { const current = queue.pop(); if (!isRecord(current) || seen.has(current)) continue; seen.add(current); if (current.stateNode instanceof Node) return current.stateNode; if (current !== fiber) queue.push(current.sibling); queue.push(current.child); }
            return null;
        }
    };
    const ui = {
        showToast(message: string, options: { type?: string; timeout?: number; } = {}) { assertActive(); if (showCompatibilityToasts) showToast({ text: message, variant: options.type === "error" || options.type === "danger" ? "critical" : options.type === "success" ? "success" : "default", duration: options.timeout }); },
        alert(title: string, content: ReactNode) { assertActive(); Alerts.show({ title, body: content }); },
        showConfirmationModal(title: string, content: ReactNode, options: { confirmText?: string; cancelText?: string; onConfirm?(): void; onCancel?(): void; danger?: boolean; } = {}) {
            assertActive();
            return Alerts.show({ title, body: content, confirmText: options.confirmText ?? "Confirm", cancelText: options.cancelText ?? "Cancel", onConfirm: options.onConfirm, onCancel: options.onCancel });
        },
        showChangelogModal(options: { title?: string; subtitle?: string; changes?: Array<{ title?: string; items?: string[]; }>; }) {
            assertActive();
            Alerts.show({ title: options.title ?? "Changelog", body: <>{options.subtitle && <Paragraph>{options.subtitle}</Paragraph>}{options.changes?.map((change, index) => <section key={index}><HeadingTertiary>{change.title}</HeadingTertiary><ul>{change.items?.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul></section>)}</> });
        },
        buildSettingsPanel(options: PanelOptions) { assertActive(); if (!options.settings?.length) throw new Error("No settings provided!"); return <SettingsPanel settings={options.settings} onChange={options.onChange} />; },
        buildSettingItem(setting: Setting) { assertActive(); return <SettingItemControl setting={setting} />; },
        showInviteModal(code: string) { assertActive(); return openInviteModal(code).catch(error => context.reportError(error)); },
        showNotification(options: { id?: string; title?: string; content?: ReactNode; duration?: number; actions?: Array<{ label: string; onClick?(): void; }>; onClose?(): void; }) {
            assertActive();
            let visible = true;
            const body = typeof options.content === "string" ? options.content : "";
            const actions = options.actions?.length ? <div>{options.actions.map(action => <Button key={action.label} size="small" onClick={() => action.onClick?.()}>{action.label}</Button>)}</div> : null;
            void showNotification({
                title: options.title ?? context.manifest.name, body, noPersist: true, permanent: options.duration === 0,
                richBody: typeof options.content === "string" && !actions ? undefined : <>{typeof options.content === "string" ? <Paragraph>{options.content}</Paragraph> : options.content}{actions}</>,
                onClose: () => { visible = false; options.onClose?.(); }
            });
            return { id: options.id, isVisible: () => visible, close: () => unsupported("UI.showNotification close") };
        },
        createTooltip(node: HTMLElement, content: string | HTMLElement, options: { style?: string; side?: "top" | "right" | "bottom" | "left"; preventFlip?: boolean; disabled?: boolean; } = {}) {
            assertActive();
            const side = options.side ?? "top";
            const element = document.createElement("div");
            element.className = "bd-layer";
            const tooltipElement = document.createElement("div");
            tooltipElement.className = `bd-tooltip bd-tooltip-${options.style ?? "primary"}`;
            const labelElement = document.createElement("div");
            labelElement.className = "bd-tooltip-content";
            labelElement.append(content);
            tooltipElement.append(labelElement);
            element.append(tooltipElement);
            const tooltip = {
                node, label: content, element, tooltipElement, labelElement, side, active: false, disabled: Boolean(options.disabled), preventFlip: Boolean(options.preventFlip),
                show() {
                    if (tooltip.active || disposed) return;
                    tooltip.active = true;
                    (document.getElementById("app-mount") ?? document.body).append(element);
                    const rect = node.getBoundingClientRect();
                    const fits = { top: rect.top - element.offsetHeight >= 0, bottom: rect.bottom + element.offsetHeight <= dom.screenHeight, left: rect.left - element.offsetWidth >= 0, right: rect.right + element.offsetWidth <= dom.screenWidth };
                    const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" } as const;
                    const placed = fits[side] || tooltip.preventFlip ? side : opposite[side];
                    tooltipElement.classList.add(`bd-tooltip-${placed}`);
                    if (placed === "top" || placed === "bottom") {
                        element.style.top = `${placed === "top" ? rect.top - element.offsetHeight - 10 : rect.bottom + 10}px`;
                        element.style.left = `${rect.left + rect.width / 2 - element.offsetWidth / 2}px`;
                    } else {
                        element.style.left = `${placed === "left" ? rect.left - element.offsetWidth - 10 : rect.right + 10}px`;
                        element.style.top = `${rect.top + rect.height / 2 - element.offsetHeight / 2}px`;
                    }
                    stopWatching = dom.onRemoved(node, () => tooltip.hide());
                },
                hide() {
                    if (!tooltip.active) return;
                    tooltip.active = false;
                    element.remove();
                    for (const name of ["top", "bottom", "left", "right"]) tooltipElement.classList.remove(`bd-tooltip-${name}`);
                    stopWatching?.();
                    stopWatching = undefined;
                }
            };
            let stopWatching: (() => void) | undefined;
            const enter = () => { if (!tooltip.disabled) tooltip.show(); };
            const leave = () => tooltip.hide();
            node.addEventListener("mouseenter", enter);
            node.addEventListener("mouseleave", leave);
            const release = () => { tooltip.hide(); node.removeEventListener("mouseenter", enter); node.removeEventListener("mouseleave", leave); cleanup.delete(release); };
            cleanup.add(release);
            return tooltip;
        },
        openDialog: () => unsupported("UI.openDialog"),
        showNotice(content: string, options: { buttons?: Array<{ label: string; onClick(): void; }>; timeout?: number; } = {}) {
            assertActive();
            const message = <>{content}{options.buttons?.map(button => <Button key={button.label} onClick={button.onClick}>{button.label}</Button>)}</>;
            showNotice(message, "Dismiss", () => dismiss());
            const entry: unknown = Array.isArray(currentNotice) && currentNotice[1] === message ? currentNotice : noticesQueue.find(value => Array.isArray(value) && value[1] === message);
            const dismiss = () => {
                if (entry === currentNotice) popNotice();
                else { const index = noticesQueue.indexOf(entry); if (index !== -1) noticesQueue.splice(index, 1); }
                cleanup.delete(dismiss);
            };
            cleanup.add(dismiss);
            if (options.timeout) { const timer = setTimeout(dismiss, options.timeout); cleanup.add(() => clearTimeout(timer)); }
            return dismiss;
        }
    };
    const plugins = {
        folder: context.snapshot.directory,
        get: (name: string) => context.addons().find(addon => addon.id === name || addon.name === name || addon.filename === name),
        getAll: () => context.addons(),
        isEnabled(name: string) { return Boolean(plugins.get(name)?.enabled); },
        enable(name: string) { const addon = plugins.get(name); if (!addon) throw new Error(`User plugin ${name} is not installed.`); return guardedContext.setEnabled(addon.id, true); },
        disable(name: string) { const addon = plugins.get(name); if (!addon) throw new Error(`User plugin ${name} is not installed.`); return guardedContext.setEnabled(addon.id, false); },
        toggle(name: string) { return plugins.isEnabled(name) ? plugins.disable(name) : plugins.enable(name); },
        reload(name: string) { const addon = plugins.get(name); if (!addon) throw new Error(`User plugin ${name} is not installed.`); return guardedContext.reload(addon.id); }
    };
    const menuPatches = new Map<unknown, Map<string, () => void>>();
    type MenuCallback = (tree: ReactElement, props: unknown) => ReactElement | void;
    const runMenuPatch = (navId: string, callback: MenuCallback, children: Array<ReactElement | null>, props: unknown) => {
        const tree = React.createElement("div", { navId }, children);
        const next = callback(tree, props) ?? tree;
        const replaced = (next.props as { children?: ReactNode; }).children;
        if (replaced === children) return;
        children.splice(0, children.length, ...React.Children.toArray(replaced).filter((child): child is ReactElement => React.isValidElement(child)));
    };
    const component = (name: keyof typeof Menu) => Menu[name] as ComponentType<Record<string, unknown>>;
    const contextMenu = {
        get Item() { return component("MenuItem"); },
        get Separator() { return component("MenuSeparator"); },
        get CheckboxItem() { return component("MenuCheckboxItem"); },
        get RadioItem() { return component("MenuRadioItem"); },
        get ControlItem() { return component("MenuControlItem"); },
        get Group() { return component("MenuGroup"); },
        get Menu() { return component("Menu"); },
        patch(navId: string | RegExp, callback: MenuCallback) {
            assertActive();
            const pattern = typeof navId === "string" && navId.includes("*") ? globPattern(navId) : navId;
            const key = typeof pattern === "string" ? pattern : `/${pattern.source}/${pattern.flags}`;
            let remove: () => void;
            if (typeof pattern === "string") {
                const patch = (children: Array<ReactElement | null>, ...args: unknown[]) => runMenuPatch(pattern, callback, children, args[0]);
                addContextMenuPatch(pattern, patch);
                remove = () => removeContextMenuPatch(pattern, patch);
            } else {
                const patch = (id: string, children: Array<ReactElement | null>, ...args: unknown[]) => { pattern.lastIndex = 0; if (pattern.test(id)) runMenuPatch(id, callback, children, args[0]); };
                addGlobalContextMenuPatch(patch);
                remove = () => removeGlobalContextMenuPatch(patch);
            }
            const cancel = () => { remove(); cleanup.delete(cancel); menuPatches.get(callback)?.delete(key); };
            let registered = menuPatches.get(callback);
            if (!registered) menuPatches.set(callback, registered = new Map());
            registered.get(key)?.();
            registered.set(key, cancel);
            cleanup.add(cancel);
            return cancel;
        },
        unpatch(navId: string | RegExp, callback: unknown) {
            if (typeof callback !== "function") throw new TypeError(`ContextMenu.unpatch for ${String(navId)} requires the original callback.`);
            const pattern = typeof navId === "string" && navId.includes("*") ? globPattern(navId) : navId;
            menuPatches.get(callback)?.get(typeof pattern === "string" ? pattern : `/${pattern.source}/${pattern.flags}`)?.();
        },
        buildItem(item: Record<string, unknown>): ReactElement {
            const { type } = item;
            if (type === "separator") return React.createElement(component("MenuSeparator"));
            if (type === "group") return React.createElement(component("MenuGroup"), null, contextMenu.buildMenuChildren(Array.isArray(item.items) ? item.items : []));
            const props: Record<string, unknown> = { ...item };
            let Component = component("MenuItem");
            if (type === "submenu" && !props.children) { const nested = props.render ?? props.items; if (Array.isArray(nested)) props.children = contextMenu.buildMenuChildren(nested); }
            else if (type === "toggle" || type === "radio") { Component = component(type === "toggle" ? "MenuCheckboxItem" : "MenuRadioItem"); if (props.active) props.checked = props.active; }
            else if (type === "control") Component = component("MenuControlItem");
            props.id ??= (typeof props.label === "string" ? props.label : "").replace(/^[^a-z]+|[^\w-]+/gi, "-");
            if (type !== "control") {
                if (props.danger) props.color = "danger";
                if (typeof props.onClick === "function" && !props.action) props.action = props.onClick;
                props.extended = true;
            }
            if (type === "toggle") {
                let state: [boolean, (value: boolean) => void];
                try { state = React.useState(Boolean(props.checked)); } catch { state = [Boolean(props.checked), () => {}]; }
                const [active, setActive] = state;
                const action = props.action as ((event: { defaultPrevented?: boolean; }) => void) | undefined;
                props.checked = active;
                props.action = (event: { defaultPrevented?: boolean; }) => { action?.(event); if (!event?.defaultPrevented) setActive(!active); };
            }
            return React.createElement(Component, props);
        },
        buildMenuChildren: (items: unknown[]): ReactElement[] => items.filter(isRecord).map(item => contextMenu.buildItem(item)),
        buildMenu(items: Record<string, unknown>[]) {
            return (props: Record<string, unknown>) => React.createElement(component("Menu"), { navId: `noyucord-user-${context.manifest.id}`, onClose: () => ContextMenuApi.closeContextMenu(), "aria-label": context.manifest.name, ...props }, contextMenu.buildMenuChildren(items));
        },
        open(event: Parameters<typeof ContextMenuApi.openContextMenu>[0], menu: ComponentType<Record<string, unknown>>, config?: Parameters<typeof ContextMenuApi.openContextMenu>[2]) {
            assertActive();
            return ContextMenuApi.openContextMenu(event, ((props: Record<string, unknown>) => React.createElement(menu, { ...props, onClose: ContextMenuApi.closeContextMenu })) as never, config);
        },
        close: () => ContextMenuApi.closeContextMenu()
    };
    const utils = {
        findInTree(tree: unknown, filter: (node: unknown) => boolean, options: { walkable?: string[]; ignore?: string[]; maxDepth?: number; } = {}) {
            const seen = new Set<unknown>();
            function visit(value: unknown, depth: number): unknown {
                if (depth > (options.maxDepth ?? 100) || seen.has(value)) return;
                if (filter(value)) return value;
                if (!isRecord(value)) return;
                seen.add(value);
                for (const key of Array.isArray(value) ? Object.keys(value) : options.walkable ?? Object.keys(value)) {
                    if (options.ignore?.includes(key)) continue;
                    const result = visit(value[key], depth + 1);
                    if (result !== undefined) return result;
                }
            }
            return visit(tree, 0);
        },
        extend(...args: unknown[]) {
            const deep = typeof args[0] === "boolean" ? Boolean(args.shift()) : true;
            const target = args.shift();
            if (!isRecord(target)) throw new TypeError("Utils.extend requires a target object.");
            for (const value of args) {
                if (!isRecord(value)) continue;
                for (const [key, child] of Object.entries(value)) {
                    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
                    target[key] = deep && isRecord(child) ? utils.extend(true, Array.isArray(child) ? [] : isRecord(target[key]) ? target[key] : {}, child) : child;
                }
            }
            return target;
        },
        className: (...values: unknown[]) => values.flatMap(value => typeof value === "string" ? [value] : Array.isArray(value) ? [utils.className(...value)] : isRecord(value) ? Object.keys(value).filter(key => value[key]) : []).join(" "),
        escapeHTML: (text: string) => text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character),
        escapeRegExp: (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        formatString: (text: string, values: Record<string, unknown>) => text.replace(/{{(.*?)}}/g, (match, key: string) => key in values ? String(values[key]) : match),
        semverCompare,
        Store,
        mapObject(target: unknown, mappers: Record<string, BetterDiscordFilter>) {
            const mapped: Record<string, unknown> = Object.create(null);
            const keys = isRecord(target) ? Object.keys(target) : [];
            for (const [name, filter] of Object.entries(mappers)) {
                const key = keys.find(key => { try { return filter((target as Record<string, unknown>)[key]); } catch { return false; } });
                Object.defineProperty(mapped, name, key === undefined || !isRecord(target)
                    ? { value: undefined, enumerable: true }
                    : { get: () => target[key], set: (value: unknown) => { target[key] = value; }, enumerable: true });
            }
            return mapped;
        },
        async forceLoad(id: string | number) {
            assertActive();
            const source = wreq?.m[id]?.toString();
            if (!source || !wreq) return [];
            const chunks = [...source.matchAll(/.\.e\("(\d+)"\)/g)].map(match => match[1]);
            await Promise.all(chunks.map(chunk => wreq.e(chunk)));
            return [...new Set([...source.matchAll(/.\.bind\(.,\s*(\d+)\s*\)/g)].map(match => match[1]))].map(module => wreq(module));
        },
        sleep: (delay: number) => { assertActive(); return new Promise<void>(resolve => { const timer = setTimeout(() => { cleanup.delete(cancel); resolve(); }, delay); const cancel = () => { clearTimeout(timer); resolve(); }; cleanup.add(cancel); }); },
        getNestedProp: (value: unknown, path: string) => path.split(".").reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, value)
    };
    const debounce = (executor: (this: unknown, ...args: unknown[]) => void, delay: number) => {
        assertActive();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => { clearTimeout(timer); timer = undefined; };
        cleanup.add(cancel);
        return Object.assign(function (this: unknown, ...args: unknown[]) {
            assertActive();
            cancel();
            timer = setTimeout(() => { timer = undefined; if (!disposed) Reflect.apply(executor, this, args); }, delay);
        }, { cancel });
    };
    const reactUtils = {
        getInternalInstance(node: Element) { const key = Object.keys(node).find(key => key.startsWith("__reactFiber") || key.startsWith("__reactInternalInstance")); return key ? Reflect.get(node, key) : undefined; },
        getOwnerInstance(node: Element, options: { include?: string[]; exclude?: string[]; filter?: (instance: unknown) => boolean; } = {}) {
            let fiber: unknown = reactUtils.getInternalInstance(node);
            while (isRecord(fiber)) {
                const instance = fiber.stateNode;
                const { type } = fiber;
                const name = isRecord(type) ? type.displayName ?? type.name : undefined;
                if (instance && !(instance instanceof Node) && (!options.include || options.include.includes(String(name))) && !options.exclude?.includes(String(name)) && (!options.filter || options.filter(instance))) return instance;
                fiber = fiber.return;
            }
            return null;
        },
        wrapElement(element: HTMLElement) { assertActive(); return function WrappedElement() { const ref = React.useRef<HTMLDivElement>(null); React.useLayoutEffect(() => { assertActive(); ref.current?.append(element); return () => element.remove(); }, []); return <div ref={ref} />; }; }
    };
    const compatibilitySetting = (...path: string[]) => {
        if (path.join(".") === "settings.general.showToasts") return showCompatibilityToasts;
        if (path.join(".") !== "addons.general.autoReload") unsupported(`Setting ${path.join(".")}`);
        return false;
    };
    const themes = {
        folder: context.snapshot.directory,
        getAll: () => context.themes ? context.themes() : unsupported("Themes.getAll"),
        get(name: string) { return themes.getAll().find(theme => theme.id === name || theme.name === name || theme.filename === name); },
        isEnabled(name: string) { return Boolean(themes.get(name)?.enabled); },
        enable(name: string) { setThemeEnabled(name, true); },
        disable(name: string) { setThemeEnabled(name, false); },
        toggle(name: string) { setThemeEnabled(name, !themes.isEnabled(name)); }
    };
    function setThemeEnabled(name: string, enabled: boolean) {
        assertActive();
        const theme = themes.get(name);
        if (!theme) throw new Error(`Theme ${name} is not installed.`);
        const active = Settings.enabledThemes.includes(theme.filename);
        if (active === enabled) return;
        Settings.enabledThemes = enabled ? [...Settings.enabledThemes, theme.filename] : Settings.enabledThemes.filter(file => file !== theme.filename);
    }
    enableStyle(componentStyles);
    const components = betterDiscordComponents();
    const useData = (owner: BetterDiscordApiPeer["data"], key: string) => {
        const [version, forceUpdate] = useForceUpdate();
        React.useEffect(() => owner.subscribe(key, forceUpdate), [owner, key]);
        return React.useMemo(() => owner.load(key), [owner, key, version]);
    };
    const hooks = { useStateFromStores, useForceUpdate, useData: (caller: string, key: string) => useData(peer(caller).data, key) };
    interface BetterDiscordCommand { id: string; name: string; description?: string; inputType?: number; options?: Array<Record<string, unknown> & { name: string; description?: string; required?: boolean; choices?: Array<{ name: string; value: unknown; }>; }>; execute(options: unknown[], context: { channel: unknown; guild?: unknown; }): unknown; predicate?(): boolean; }
    const ownedCommands = new Map<string, Map<string, { name: string; registered: object; command: BetterDiscordCommand; }>>();
    const commands = {
        Types: Object.freeze({
            OptionTypes: { SUB_COMMAND: 1, SUB_COMMAND_GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8, MENTIONABLE: 9, NUMBER: 10, ATTACHMENT: 11 },
            CommandTypes: { CHAT_INPUT: 1, USER: 2, MESSAGE: 3 },
            InputTypes: { BUILT_IN: 0, TEXT: 1, SEARCH: 2, BOT: 3, PLACEHOLDER: 4 },
            MessageEmbedTypes: { IMAGE: "image", VIDEO: "video", LINK: "link", ARTICLE: "article", TWEET: "tweet", RICH: "rich", GIFV: "gifv", TEXT: "text" }
        }),
        register(caller: string, command: BetterDiscordCommand) {
            assertActive();
            if (typeof caller !== "string" || !isRecord(command) || !command.id || !command.name || typeof command.execute !== "function") return;
            let owned = ownedCommands.get(caller);
            if (!owned) ownedCommands.set(caller, owned = new Map());
            if (owned.has(command.id)) throw new Error(`Command with id bd-${caller}-${command.id} is already registered`);
            const registered = {
                name: command.name, description: command.description ?? "",
                options: (command.options ?? []).map(option => ({ ...option, description: option.description ?? "", required: option.required ?? false, choices: option.choices?.map(choice => ({ ...choice, label: choice.name, displayName: choice.name })) })),
                predicate: command.predicate ? () => Boolean(command.predicate?.()) : undefined,
                execute(args: unknown[], ctx: { channel: { id: string; }; guild?: unknown; }) {
                    let result: unknown;
                    try { result = command.execute(args, { channel: ctx.channel, guild: ctx.guild }); } catch (error) { context.reportError(error); return; }
                    if (command.inputType !== undefined && command.inputType !== 0) return;
                    void Promise.resolve(result).then(value => {
                        if (!isRecord(value)) return;
                        const content = typeof value.content === "string" ? value.content : undefined;
                        const embeds = Array.isArray(value.embeds) ? value.embeds : undefined;
                        if (content || embeds?.length) sendBotMessage(ctx.channel.id, { content, embeds });
                    }, error => context.reportError(error));
                }
            };
            registerCommand(registered as Parameters<typeof registerCommand>[0], caller);
            owned.set(command.id, { name: command.name, registered, command });
            const cancel = () => commands.unregister(caller, command.id);
            cleanup.add(cancel);
            return cancel;
        },
        unregister(caller: string, id: string) {
            const owned = ownedCommands.get(caller);
            const entry = owned?.get(id);
            if (!entry) return;
            owned?.delete(id);
            if (registeredCommands[entry.name] === entry.registered) unregisterCommand(entry.name);
        },
        unregisterAll(caller: string) { for (const id of [...ownedCommands.get(caller)?.keys() ?? []]) commands.unregister(caller, id); },
        getCommandsByCaller: (caller: string) => [...ownedCommands.get(caller)?.values() ?? []].map(entry => entry.command)
    };
    cleanup.add(() => { for (const caller of [...ownedCommands.keys()]) commands.unregisterAll(caller); });
    const shared = {
        React, ReactDOM: reactDOM, Webpack: webpack, UI: ui, DOM: dom, Plugins: plugins,
        Themes: themes,
        ContextMenu: contextMenu, Utils: { ...utils, debounce, getNestedValue: utils.getNestedProp }, ReactUtils: {
            ...reactUtils,
            getType,
            wrapInHooks,
            createNodePatcher() { assertActive(); const patcher = createNodePatcher(); cleanup.add(patcher.destroy); return patcher; }
        },
        Components: components,
        Hooks: hooks,
        Commands: commands,
        Net: { fetch: node.fetch },
        Native: node.native,
        openLink: node.native.openLink,
        Logger: { log: (...args: unknown[]) => logger.log(...args), info: (...args: unknown[]) => logger.info(...args), warn: (...args: unknown[]) => logger.warn(...args), error: (...args: unknown[]) => logger.error(...args), debug: (...args: unknown[]) => logger.debug(...args), stacktrace: (...args: unknown[]) => logger.error(...args) },
        settings: [{ id: "addons", settings: [{ id: "general", settings: [{ id: "autoReload", value: false }] }] }, { id: "settings", settings: [{ id: "general", settings: [{ id: "showToasts", get value() { return showCompatibilityToasts; } }] }] }],
        isSettingEnabled: compatibilitySetting,
        enableSetting: (...path: string[]) => { if (path.join(".") === "settings.general.showToasts") showCompatibilityToasts = true; else unsupported(`Setting ${path.join(".")}; user plugin changes require a restart`); },
        disableSetting: (...path: string[]) => { if (path.join(".") === "settings.general.showToasts") showCompatibilityToasts = false; else compatibilitySetting(...path); },
        toggleSetting: (...path: string[]) => { if (path.join(".") === "settings.general.showToasts") showCompatibilityToasts = !showCompatibilityToasts; else unsupported(`Setting ${path.join(".")}; user plugin changes require a restart`); },
        version: "1.14.0",
        getData: (name: string, key: string) => peer(name).data.load(key),
        loadData: (name: string, key: string) => peer(name).data.load(key),
        saveData: (name: string, key: string, value: unknown) => { assertActive(); peer(name).data.save(key, value); },
        deleteData: (name: string, key: string) => { assertActive(); peer(name).data.delete(key); },
        injectCSS: dom.addStyle, clearCSS: dom.removeStyle,
        alert: ui.alert, showToast: ui.showToast, showConfirmationModal: ui.showConfirmationModal,
        findModule: webpack.getModule, findAllModules: webpack.getModules,
        findModuleByProps: webpack.getByKeys, findModuleByPrototypes: webpack.getByPrototypeKeys,
        findModuleByDisplayName: (name: string) => webpack.getModule(webpack.Filters.byDisplayName(name)),
        getInternalInstance: reactUtils.getInternalInstance,
        findInTree: utils.findInTree,
        findInReactTree: (tree: unknown, filter: (node: unknown) => boolean) => utils.findInTree(tree, filter, { walkable: ["props", "children", "child", "sibling"] })
    };
    class BoundApi {
        React = shared.React;
        ReactDOM = shared.ReactDOM;
        Webpack = shared.Webpack;
        UI = shared.UI;
        DOM: Omit<typeof shared.DOM, "addStyle" | "removeStyle"> & { addStyle(id: string, css?: string): void; removeStyle(id?: string): void; };
        Hooks: Omit<typeof hooks, "useData"> & { useData(key: string): unknown; };
        Commands: Omit<typeof commands, "register" | "unregister" | "unregisterAll" | "getCommandsByCaller"> & {
            register(command: BetterDiscordCommand): (() => void) | undefined;
            unregister(id: string): void;
            unregisterAll(): void;
            getCommandsByCaller(): BetterDiscordCommand[];
        };
        Plugins = shared.Plugins;
        Themes = shared.Themes;
        ContextMenu = shared.ContextMenu;
        Components = shared.Components;
        Utils = shared.Utils;
        ReactUtils = shared.ReactUtils;
        Net = shared.Net;
        Native = shared.Native;
        Logger = shared.Logger;
        Data: BetterDiscordApiPeer["data"];
        Patcher: {
            before(object: unknown, key: string, callback: (this: unknown, ...args: unknown[]) => unknown, options?: { forcePatch?: boolean; }): (() => void) | null;
            instead(object: unknown, key: string, callback: (this: unknown, ...args: unknown[]) => unknown, options?: { forcePatch?: boolean; }): (() => void) | null;
            after(object: unknown, key: string, callback: (this: unknown, ...args: unknown[]) => unknown, options?: { forcePatch?: boolean; }): (() => void) | null;
            unpatchAll(): void;
            getPatchesByCaller(): ReturnType<typeof patcher.getPatchesByCaller>;
        };
        constructor(name = context.manifest.name) {
            assertActive();
            const owner = peer(name);
            this.Data = { load: owner.data.load, save: (key, value) => { assertActive(); owner.data.save(key, value); }, delete: key => { assertActive(); owner.data.delete(key); }, subscribe: owner.data.subscribe };
            const styleOwner = owner.dom ?? dom;
            this.DOM = Object.assign(Object.create(dom) as typeof dom, {
                addStyle: (id: string, css?: string) => { assertActive(); if (css === undefined) styleOwner.addStyle(name, id); else styleOwner.addStyle(id, css); },
                removeStyle: (id: string = name) => styleOwner.removeStyle(id)
            });
            this.Hooks = { ...hooks, useData: key => useData(owner.data, key) };
            this.Commands = {
                Types: commands.Types,
                register: command => commands.register(name, command),
                unregister: id => commands.unregister(name, id),
                unregisterAll: () => commands.unregisterAll(name),
                getCommandsByCaller: () => commands.getCommandsByCaller(name)
            };
            this.Patcher = {
                before: (object, key, callback, options) => { assertActive(); return peer(name).patcher.before(name, object, key, callback, options); },
                instead: (object, key, callback, options) => { assertActive(); return peer(name).patcher.instead(name, object, key, callback, options); },
                after: (object, key, callback, options) => { assertActive(); return peer(name).patcher.after(name, object, key, callback, options); },
                unpatchAll: () => peer(name).patcher.unpatchAll(name),
                getPatchesByCaller: () => peer(name).patcher.getPatchesByCaller(name)
            };
        }
    }
    const staticPatcher = {
        before: (name: string, ...args: Parameters<typeof patcher.before> extends [string, ...infer Rest] ? Rest : never) => { assertActive(); return peer(name).patcher.before(name, ...args); },
        instead: (name: string, ...args: Parameters<typeof patcher.instead> extends [string, ...infer Rest] ? Rest : never) => { assertActive(); return peer(name).patcher.instead(name, ...args); },
        after: (name: string, ...args: Parameters<typeof patcher.after> extends [string, ...infer Rest] ? Rest : never) => { assertActive(); return peer(name).patcher.after(name, ...args); },
        unpatchAll: (name: string) => peer(name).patcher.unpatchAll(name),
        getPatchesByCaller: (name: string) => peer(name).patcher.getPatchesByCaller(name)
    };
    const BdApi = Object.assign(BoundApi, shared, { Patcher: staticPatcher, Data: { load: shared.loadData, save: shared.saveData, delete: shared.deleteData } });
    return {
        BdApi, data, patcher, dom, Buffer: node.Buffer, process: node.process, fetch: node.fetch,
        require(name: string) {
            if (name === "react") return React;
            if (name === "react-dom" || name === "react-dom/client") return reactDOM;
            if (name === "react/jsx-runtime" || name === "react/jsx-dev-runtime") {
                const jsx = (type: string | ComponentType<Record<string, unknown>>, props: Record<string, unknown>, key?: string) => React.createElement(type, { ...props, key });
                return { Fragment: React.Fragment, jsx, jsxs: jsx, jsxDEV: jsx };
            }
            return node.require(name);
        },
        flush: async () => { unwrap(await context.flushData()); },
        disposeCaller: (caller: string) => peer(caller).patcher.unpatchAll(caller),
        releaseElement(element: Element) { for (const [container, root] of [...roots]) { if (container === element || element.contains(container)) release(() => root.unmount()); } },
        dispose() {
            if (disposed) return;
            disposed = true;
            release(() => patcher.unpatchAll());
            for (const cancel of [...cleanup]) release(cancel);
            cleanup.clear();
            for (const style of styles.values()) release(() => style.remove());
            styles.clear();
            for (const root of [...roots.values()]) release(() => root.unmount());
            roots.clear();
        }
    };
}
