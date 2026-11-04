/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { BetterDiscordRequest, BetterDiscordResponse } from "@shared/userPlugins";

import { type BetterDiscordApiContext, isRecord, unsupported, unwrap } from "./types";

type Callback = (error: Error | null, value?: unknown) => void;

function normalizePath(input: string, separator = "/") {
    const path = input.replaceAll("\\", "/");
    const absolute = path.startsWith("/") || /^[a-z]:\//i.test(path);
    const parts: string[] = [];
    for (const part of path.split("/")) {
        if (!part || part === ".") continue;
        if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
        else if (part !== ".." || !absolute) parts.push(part);
    }
    return `${path.startsWith("/") ? "/" : ""}${parts.join(separator)}` || ".";
}

function makePath(directory: string, separator: string) {
    const normalize = (path: string) => normalizePath(path, separator);
    const isAbsolute = (path: string) => /^([a-z]:[\\/]|[\\/])/i.test(path);
    const join = (...paths: string[]) => normalize(paths.filter(Boolean).join(separator));
    const dirname = (path: string) => { const normalized = normalize(path); const index = normalized.lastIndexOf(separator); return index < 0 ? "." : normalized.slice(0, index) || separator; };
    const basename = (path: string, suffix = "") => { const result = normalize(path).split(separator).at(-1) ?? ""; return suffix && result.endsWith(suffix) ? result.slice(0, -suffix.length) : result; };
    const extname = (path: string) => { const name = basename(path); const dot = name.lastIndexOf("."); return dot <= 0 ? "" : name.slice(dot); };
    const resolve = (...paths: string[]) => {
        let result = directory;
        for (const path of paths) result = isAbsolute(path) ? path : join(result, path);
        return normalize(result);
    };
    const parse = (path: string) => {
        const base = basename(path);
        const ext = extname(path);
        return { root: /^[a-z]:/i.test(path) ? path.slice(0, 3) : isAbsolute(path) ? separator : "", dir: dirname(path), base, ext, name: base.slice(0, base.length - ext.length) };
    };
    return {
        sep: separator, delimiter: separator === "\\" ? ";" : ":", normalize, join, dirname, basename, extname, resolve, isAbsolute, parse,
        relative(from: string, to: string) {
            const left = resolve(from).split(separator);
            const right = resolve(to).split(separator);
            while (left.length && right.length && left[0] === right[0]) { left.shift(); right.shift(); }
            return [...left.map(() => ".."), ...right].join(separator);
        },
        format: (path: { dir?: string; root?: string; base?: string; name?: string; ext?: string; }) => join(path.dir ?? path.root ?? "", path.base ?? `${path.name ?? ""}${path.ext ?? ""}`),
        toNamespacedPath: (path: string) => path
    };
}

class CompatibilityBytes extends Uint8Array {
    toString(encoding = "utf8") {
        if (encoding === "base64") return btoa(Array.from(this, value => String.fromCharCode(value)).join(""));
        if (encoding !== "utf8" && encoding !== "utf-8") unsupported(`Buffer encoding ${encoding}`);
        return new TextDecoder().decode(this);
    }
}

const CompatibilityBuffer = {
    from(value: string | ArrayLike<number> | ArrayBuffer, encoding = "utf8"): CompatibilityBytes {
        if (typeof value !== "string") return new CompatibilityBytes(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
        if (encoding === "base64") return new CompatibilityBytes(Uint8Array.from(atob(value), character => character.charCodeAt(0)));
        if (encoding !== "utf8" && encoding !== "utf-8") unsupported(`Buffer encoding ${encoding}`);
        return new CompatibilityBytes(new TextEncoder().encode(value));
    },
    isBuffer: (value: unknown) => value instanceof CompatibilityBytes,
    alloc: (size: number) => new CompatibilityBytes(size),
    concat(buffers: Uint8Array[]) { const result = new CompatibilityBytes(buffers.reduce((sum, buffer) => sum + buffer.length, 0)); let offset = 0; for (const buffer of buffers) { result.set(buffer, offset); offset += buffer.length; } return result; }
};

export function createBetterDiscordNode(context: BetterDiscordApiContext, cleanup: Set<() => void>, assertActive: () => void = () => {}) {
    const expose = <T extends object>(value: T, name: string): T => new Proxy(value, {
        get(target, key, receiver) {
            if (typeof key === "symbol" || key === "__esModule" || key === "default" || key in target) return Reflect.get(target, key, receiver);
            return unsupported(`${name}.${key}`);
        }
    });
    const path = Object.assign(makePath(context.snapshot.directory, context.snapshot.platform === "win32" ? "\\" : "/"), {
        posix: makePath(context.snapshot.directory, "/"), win32: makePath(context.snapshot.directory, "\\")
    });
    const encodingOf = (options: unknown): string | undefined => typeof options === "string" ? options : isRecord(options) && typeof options.encoding === "string" ? options.encoding : undefined;
    const file = (method: "readFile" | "writeFile" | "exists" | "readdir" | "mkdir" | "stat" | "unlink" | "rename" | "rm", filename: string, extra: { content?: string; destination?: string; encoding?: "utf8" | "base64"; } = {}) => unwrap(context.operation({ type: "fs", method, ...extra, path: normalizePath(filename), ...(extra.destination === undefined ? {} : { destination: normalizePath(extra.destination) }) }));
    const readFileSync = (filename: string, options?: unknown) => {
        const encoding = encodingOf(options);
        if (encoding && encoding !== "utf8" && encoding !== "utf-8" && encoding !== "base64") unsupported(`fs encoding ${encoding}`);
        const content = file("readFile", filename, { encoding: encoding === "utf8" || encoding === "utf-8" ? "utf8" : "base64" });
        if (typeof content !== "string") throw new Error("The native file reader returned invalid content.");
        return encoding ? content : CompatibilityBuffer.from(content, "base64");
    };
    const writeFileSync = (filename: string, content: unknown, options?: unknown) => {
        if (typeof content !== "string" && !(content instanceof Uint8Array)) throw new TypeError("fs.writeFile requires text or a byte buffer.");
        const encoding = encodingOf(options);
        if (encoding && !["utf8", "utf-8", "base64"].includes(encoding)) unsupported(`fs encoding ${encoding}`);
        file("writeFile", filename, { content: typeof content === "string" ? content : CompatibilityBuffer.from(content).toString("base64"), encoding: content instanceof Uint8Array || encoding === "base64" ? "base64" : "utf8" });
    };
    const statSync = (filename: string) => {
        const stat = file("stat", filename);
        if (!isRecord(stat)) throw new Error("The native file reader returned invalid file information.");
        return { ...stat, isFile: () => stat.type === "file" || stat.isFile === true, isDirectory: () => stat.type === "directory" || stat.isDirectory === true, isSymbolicLink: () => false };
    };
    const asynchronous = (operation: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
        assertActive();
        const callback = args.pop();
        if (typeof callback !== "function") throw new TypeError("This fs method requires a callback.");
        queueMicrotask(() => {
            let result: unknown[];
            try { result = [null, operation(...args)]; }
            catch (error) { result = [error instanceof Error ? error : new Error(String(error))]; }
            try { Reflect.apply(callback, undefined, result); } catch (error) { context.reportError(error); }
        });
    };
    const sync = {
        readFileSync, writeFileSync,
        existsSync: (filename: string) => Boolean(file("exists", filename)),
        readdirSync: (filename: string, options?: unknown) => { if (isRecord(options) && options.withFileTypes) unsupported("fs.readdir withFileTypes"); return file("readdir", filename); },
        mkdirSync: (filename: string) => { file("mkdir", filename); },
        statSync, lstatSync: statSync,
        unlinkSync: (filename: string) => { file("unlink", filename); },
        renameSync: (filename: string, destination: string) => { file("rename", filename, { destination }); },
        rmSync: (filename: string) => { file("rm", filename); },
        accessSync: (filename: string) => { if (!file("exists", filename)) throw new Error(`File does not exist: ${filename}`); }
    };
    const fs: Record<string, unknown> = { ...sync, constants: Object.freeze({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 }) };
    const promises: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const [name, operation] of Object.entries(sync)) {
        const method = name.slice(0, -4);
        const callable = (...args: unknown[]) => Reflect.apply(operation, undefined, args);
        fs[method] = asynchronous(callable);
        promises[method] = async (...args) => callable(...args);
    }
    fs.exists = (filename: string, callback: (exists: boolean) => void) => { assertActive(); queueMicrotask(() => { try { callback(sync.existsSync(filename)); } catch (error) { context.reportError(error); } }); };
    fs.promises = expose(promises, "fs.promises");
    const process = Object.freeze({
        platform: context.snapshot.platform, arch: context.snapshot.arch,
        env: Object.freeze({}), versions: Object.freeze({}),
        cwd: () => context.snapshot.directory,
        nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => { assertActive(); queueMicrotask(() => { try { assertActive(); callback(...args); } catch (error) { context.reportError(error); } }); },
        type: "renderer"
    });
    const electron = Object.freeze({
        clipboard: {
            readText: () => unwrap(context.operation({ type: "clipboard", method: "readText" })),
            writeText: (text: string) => { unwrap(context.operation({ type: "clipboard", method: "writeText", text })); }
        },
        shell: { openExternal: async (url: string) => { unwrap(context.operation({ type: "openExternal", url })); } }
    });

    async function fetchCompat(input: string | URL | Request, options: RequestInit = {}): Promise<Response> {
        assertActive();
        const request = input instanceof Request ? input : undefined;
        const externalSignal = options.signal ?? request?.signal;
        if (externalSignal?.aborted) throw externalSignal.reason ?? new DOMException("Aborted", "AbortError");
        const headers: Record<string, string> = {};
        new Headers(options.headers ?? request?.headers).forEach((value, key) => headers[key] = value);
        const body = options.body === undefined ? request ? await request.text() : undefined : typeof options.body === "string" ? options.body : unsupported("Net.fetch request body type");
        const query: BetterDiscordRequest = { url: String(input instanceof Request ? input.url : input), method: options.method ?? request?.method, headers, body };
        assertActive();
        const controller = new AbortController();
        const { signal } = controller;
        const cancel = () => controller.abort(externalSignal?.reason);
        externalSignal?.addEventListener("abort", cancel, { once: true });
        cleanup.add(cancel);
        let abort: () => void = () => undefined;
        const aborted = new Promise<never>((_, reject) => {
            abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
            signal.addEventListener("abort", abort, { once: true });
        });
        let response: BetterDiscordResponse;
        try { response = unwrap(await Promise.race([context.request(query), aborted])); }
        finally { signal.removeEventListener("abort", abort); externalSignal?.removeEventListener("abort", cancel); cleanup.delete(cancel); }
        const decoded = Uint8Array.from(atob(response.body), character => character.charCodeAt(0));
        const result = new Response([101, 204, 205, 304].includes(response.status) ? null : decoded, { status: response.status, statusText: response.statusText, headers: response.headers });
        Object.defineProperty(result, "url", { value: response.url });
        return result;
    }

    function request(input: string | Record<string, unknown>, optionsOrCallback?: Record<string, unknown> | Callback, callbackArgument?: Callback) {
        assertActive();
        const options = typeof input === "string" ? { ...(isRecord(optionsOrCallback) ? optionsOrCallback : {}), url: input } : input;
        const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : callbackArgument;
        const controller = new AbortController();
        const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
        const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach(listener => { try { listener(...args); } catch (error) { context.reportError(error); } });
        let callbackCalled = false;
        const finish = (...args: unknown[]) => { if (!callback || callbackCalled) return; callbackCalled = true; try { Reflect.apply(callback, undefined, args); } catch (error) { context.reportError(error); } };
        const abort = () => controller.abort();
        cleanup.add(abort);
        const handle = {
            abort,
            on(event: string, listener: (...args: unknown[]) => void) { let entries = listeners.get(event); if (!entries) listeners.set(event, entries = new Set()); entries.add(listener); return handle; },
            once(event: string, listener: (...args: unknown[]) => void) { const once = (...args: unknown[]) => { listeners.get(event)?.delete(once); listener(...args); }; return handle.on(event, once); }
        };
        const url = options.url ?? options.uri;
        if (typeof url !== "string") throw new TypeError("request requires an HTTPS URL.");
        if (options.form || options.formData || options.auth || options.jar || options.proxy) unsupported("request form, authentication, cookie jar, and proxy options");
        let body = typeof options.body === "string" ? options.body : undefined;
        if (options.json && options.body !== undefined) body = JSON.stringify(options.body);
        fetchCompat(url, { method: typeof options.method === "string" ? options.method : "GET", headers: isRecord(options.headers) ? Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key, String(value)])) : undefined, body, signal: controller.signal }).then(async response => {
            const result = { statusCode: response.status, statusMessage: response.statusText, headers: Object.fromEntries(response.headers.entries()), request: { uri: { href: response.url } } };
            const bytes = CompatibilityBuffer.from(await response.arrayBuffer());
            const value: unknown = options.json ? JSON.parse(bytes.toString()) : options.encoding === null ? bytes : bytes.toString();
            emit("response", result);
            emit("data", value);
            emit("end");
            finish(null, result, value);
        }).catch(error => { if (callback) finish(error instanceof Error ? error : new Error(String(error))); else if (listeners.has("error")) emit("error", error); else context.reportError(error); }).finally(() => cleanup.delete(abort));
        return handle;
    }
    const requestApi = Object.assign(request, {
        get: request,
        post: (input: string | Record<string, unknown>, callback?: Callback) => request(typeof input === "string" ? { url: input, method: "POST" } : { ...input, method: "POST" }, callback)
    });
    const modules: Record<string, unknown> = { fs: expose(fs, "fs"), path: expose(path, "path"), process: expose(process, "process"), request: expose(requestApi, "request"), electron: expose(electron, "electron") };
    return {
        Buffer: CompatibilityBuffer, process, fetch: fetchCompat,
        native: { clipboard: electron.clipboard, openLink: electron.shell.openExternal },
        require(name: string): unknown {
            assertActive();
            const normalized = name.startsWith("node:") ? name.slice(5) : name;
            if (!Object.hasOwn(modules, normalized)) unsupported(`require(${JSON.stringify(name)})`);
            if (!context.snapshot.nativeTrusted) throw new Error(`Native compatibility access for ${context.manifest.name} needs approval in User plugins.`);
            return modules[normalized];
        }
    };
}
