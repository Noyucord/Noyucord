/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { BetterDiscordOperation, BetterDiscordRequest, BetterDiscordResponse, BetterDiscordSnapshot } from "@shared/userPlugins";
import { randomUUID } from "crypto";
import { lookup } from "dns/promises";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { request as httpsRequest } from "https";
import { dirname, join, relative, resolve, sep } from "path";

import { MAX_FILE_BYTES, MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES, packagePath } from "./files";
import { isPublicAddress, publicUrl } from "./sources";
import type { BetterDiscordStartupPackage, createUserPluginStore } from "./store";

const DIRECTORY = "/noyucord/userplugins";
const MAX_DATA_BYTES = 1024 * 1024;

interface BetterDiscordHost {
    clipboard: { readText(): string; writeText(text: string): void; };
    openExternal(url: string): Promise<unknown>;
    request?(input: BetterDiscordRequest): Promise<BetterDiscordResponse>;
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonData(value: unknown): Record<string, unknown> {
    if (!record(value)) throw new Error("BetterDiscord data must be a JSON object.");
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_DATA_BYTES) throw new Error("BetterDiscord data exceeds 1 MiB.");
    return JSON.parse(text);
}

function indexedData(values: Record<string, unknown>) {
    const sizes = new Map<string, number>();
    let bytes = 2;
    for (const key of Object.keys(values)) {
        const size = Buffer.byteLength(JSON.stringify({ [key]: values[key] })) - 2;
        bytes += size + (sizes.size ? 1 : 0);
        sizes.set(key, size);
    }
    return { values, sizes, bytes };
}

function checkedRequest(input: BetterDiscordRequest): BetterDiscordRequest {
    if (!record(input)) throw new Error("The network request is invalid.");
    const url = publicUrl(input.url).href;
    const method = input.method === undefined ? "GET" : input.method;
    if (typeof method !== "string" || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method.toUpperCase()))
        throw new Error("This HTTP method is not supported.");
    if (input.body !== undefined && (typeof input.body !== "string" || Buffer.byteLength(input.body) > MAX_DATA_BYTES))
        throw new Error("The request body exceeds 1 MiB.");
    const headers: Record<string, string> = { "User-Agent": "Noyucord BetterDiscord compatibility" };
    if (input.headers !== undefined) {
        if (!record(input.headers) || Object.keys(input.headers).length > 64) throw new Error("The request headers are invalid.");
        for (const [key, value] of Object.entries(input.headers)) {
            if (!/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(key) || typeof value !== "string" || value.length > 8192 || /[\r\n\0]/.test(value) ||
                /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|cookie|authorization)$/i.test(key))
                throw new Error("The request contains an unsupported header.");
            headers[key] = value;
        }
    }
    return { url, method: method.toUpperCase(), headers, body: input.body };
}

export async function requestBetterDiscord(input: BetterDiscordRequest, redirects = 0): Promise<BetterDiscordResponse> {
    const checked = checkedRequest(input);
    if (redirects > 5) throw new Error("The request redirected too many times.");
    return new Promise((resolveResponse, reject) => {
        const req = httpsRequest(checked.url, {
            method: checked.method, headers: checked.headers,
            lookup: (hostname, options, callback) => {
                lookup(hostname, { all: true }).then(addresses => {
                    if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) {
                        callback(new Error("The request host does not resolve to a public address."), "");
                        return;
                    }
                    const matching = addresses.filter(entry => !options.family || entry.family === options.family);
                    const first = matching[0];
                    if (!first) callback(new Error("The request host has no supported address."), "");
                    else callback(null, options.all ? matching : first.address, first.family);
                }, error => callback(error, ""));
            }
        }, response => {
            const status = response.statusCode ?? 0;
            if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
                response.resume();
                const url = new URL(response.headers.location, checked.url).href;
                const useGet = status === 303 || [301, 302].includes(status) && checked.method === "POST";
                requestBetterDiscord({ ...checked, url, ...(useGet ? { method: "GET", body: undefined } : {}) }, redirects + 1).then(resolveResponse, reject);
                return;
            }
            let total = 0;
            const chunks: Buffer[] = [];
            if (Number(response.headers["content-length"]) > MAX_FILE_BYTES) {
                response.destroy();
                reject(new Error("The response exceeds 10 MiB."));
                return;
            }
            response.on("data", (chunk: Buffer) => {
                total += chunk.length;
                if (total > MAX_FILE_BYTES) response.destroy(new Error("The response exceeds 10 MiB."));
                else chunks.push(chunk);
            });
            response.on("error", () => reject(new Error("The network response was interrupted or too large.")));
            response.on("end", () => resolveResponse({
                status, statusText: response.statusMessage ?? "", url: checked.url,
                headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""])),
                body: Buffer.concat(chunks).toString("base64")
            }));
        });
        req.setTimeout(30_000, () => req.destroy(new Error("The network request timed out.")));
        const deadline = setTimeout(() => req.destroy(new Error("The network request timed out.")), 30_000);
        req.once("close", () => clearTimeout(deadline));
        req.once("error", error => reject(new Error(error.message.startsWith("The ") ? error.message : "Unable to reach the public HTTPS endpoint.")));
        req.end(checked.body);
    });
}

export function createBetterDiscordBridge(root: string, store: ReturnType<typeof createUserPluginStore>, host: BetterDiscordHost) {
    const pending = new Map<string, Record<string, unknown>>();
    const dataCache = new Map<string, ReturnType<typeof indexedData>>();
    const sourceCache = new Map<string, Record<string, string>>();
    const packageCache = new Map<string, BetterDiscordStartupPackage[]>();
    let activeRequests = 0;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    function plugin(id: string, native = false): BetterDiscordStartupPackage {
        const item = store.compatibilityStartup(id);
        if (!item) throw new Error("This BetterDiscord plugin is not active in this session.");
        if (native && !item.nativeTrusted) throw new Error("This plugin version has not been trusted to use native compatibility APIs.");
        return item;
    }

    function safePath(path: string): string {
        const absolute = resolve(path);
        const base = resolve(root);
        const local = relative(base, absolute);
        if (local.startsWith(`..${sep}`) || local === ".." || resolve(base, local) !== absolute) throw new Error("The managed data path is invalid.");
        let current = base;
        for (const part of ["", ...local.split(sep).filter(Boolean)]) {
            current = part ? join(current, part) : current;
            try {
                if (lstatSync(current).isSymbolicLink()) throw new Error("Symbolic links are not supported in managed plugin data.");
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }
        }
        return absolute;
    }

    function dataPath(id: string) {
        return safePath(join(root, ".betterdiscord-data", id, "bdapi.json"));
    }

    function loadData(id: string) {
        const cached = dataCache.get(id);
        if (cached) return cached;
        const path = dataPath(id);
        if (existsSync(path) && lstatSync(path).size > MAX_DATA_BYTES) throw new Error("BetterDiscord data exceeds 1 MiB.");
        const data = indexedData(existsSync(path) ? jsonData(JSON.parse(readFileSync(path, "utf8"))) : Object.create(null));
        dataCache.set(id, data);
        return data;
    }

    function packages(id: string) {
        const cached = packageCache.get(id);
        if (cached) return cached;
        const own = plugin(id);
        const result = [own, ...store.status().plugins.flatMap(entry => {
            if (entry.manifest.id === id) return [];
            const item = store.compatibilityStartup(entry.manifest.id);
            if (!item) return [];
            const dependency = own.manifest.dependencies.includes(item.manifest.name);
            const dependent = own.manifest.betterDiscord?.provider && item.manifest.dependencies.includes(own.manifest.name);
            return dependency || dependent ? [item] : [];
        })];
        packageCache.set(id, result);
        return result;
    }

    function sources(id: string) {
        const cached = sourceCache.get(id);
        if (cached) return cached;
        const files: Record<string, string> = Object.create(null);
        for (const item of packages(id)) {
            const entry = item.files[item.manifest.entry];
            if (entry) files[`${item.manifest.id}.plugin.js`] = Buffer.from(entry).toString("utf8");
            for (const [name, bytes] of Object.entries(item.files)) files[`${item.manifest.id}/${name}`] = Buffer.from(bytes).toString("utf8");
        }
        sourceCache.set(id, files);
        return files;
    }

    function snapshot(id: string): BetterDiscordSnapshot {
        const own = plugin(id);
        return {
            filename: `${DIRECTORY}/${id}.plugin.js`, directory: DIRECTORY, files: { ...sources(id) },
            data: structuredClone(loadData(id).values), dataOperations: "keys", nativeTrusted: own.nativeTrusted, platform: process.platform, arch: process.arch
        };
    }

    function localPath(input: string) {
        if (typeof input !== "string" || input.length > 4096 || input.includes("\\") || input.includes("\0")) throw new Error("The managed file path is invalid.");
        if (input === DIRECTORY || input === `${DIRECTORY}/` || input === "." || input === "") return "";
        const local = input.startsWith(`${DIRECTORY}/`) ? input.slice(DIRECTORY.length + 1) : input;
        return packagePath(local);
    }

    function mutablePath(id: string, local: string) {
        if (!local) throw new Error("The plugin directory cannot be modified.");
        const first = local.split("/")[0];
        const owner = packages(id).find(item => first === `${item.manifest.name}.config.json` || first === `${item.manifest.id}.config.json`);
        const targetId = owner?.manifest.id ?? id;
        if (/\.(?:plugin\.js|[cm]?[jt]sx?|node|wasm|exe|dll|so|dylib|bat|cmd|ps1|sh|py|rb)$/i.test(local)) throw new Error("Plugin sources and executable files are read only. Use User plugins to install updates.");
        return safePath(join(root, ".betterdiscord-data", targetId, "files", local));
    }

    function write(path: string, content: string) {
        safePath(dirname(path));
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, content, { encoding: "utf8", flush: true });
        renameSync(temporary, path);
    }

    function checkQuota(directory: string) {
        let count = 0;
        let size = 0;
        function visit(path: string) {
            if (!existsSync(path)) return;
            const ownStat = lstatSync(safePath(path));
            if (!ownStat.isDirectory()) { size += ownStat.size; return; }
            for (const name of readdirSync(path)) {
                const child = safePath(join(path, name));
                const stat = lstatSync(child);
                if (++count > MAX_PACKAGE_FILES || (size += stat.isFile() ? stat.size : 0) > MAX_PACKAGE_BYTES)
                    throw new Error("Managed plugin data exceeds its file count or size limit.");
                if (stat.isDirectory()) visit(child);
            }
        }
        visit(directory);
    }

    function operation(id: string, input: BetterDiscordOperation): unknown {
        if (!record(input)) throw new Error("The compatibility operation is invalid.");
        const dataOperation = input.type === "data" || input.type === "dataSet" || input.type === "dataDelete";
        plugin(id, !dataOperation);
        if (dataOperation) {
            if (input.type === "data") dataCache.set(id, indexedData(jsonData(input.data)));
            else {
                if (typeof input.key !== "string" || input.type === "dataSet" && !input.key.length) throw new Error("The BetterDiscord data key is invalid.");
                const data = loadData(id);
                const previousSize = data.sizes.get(input.key);
                if (input.type === "dataSet") {
                    const normalized = jsonData({ [input.key]: input.value });
                    if (!Object.hasOwn(normalized, input.key)) throw new Error("The BetterDiscord data value is invalid.");
                    const size = Buffer.byteLength(JSON.stringify(normalized)) - 2;
                    const bytes = data.bytes - (previousSize ?? 0) + size + (previousSize === undefined && data.sizes.size ? 1 : 0);
                    if (bytes > MAX_DATA_BYTES) throw new Error("BetterDiscord data exceeds 1 MiB.");
                    Object.defineProperty(data.values, input.key, { value: normalized[input.key], writable: true, enumerable: true, configurable: true });
                    data.sizes.set(input.key, size);
                    data.bytes = bytes;
                } else if (previousSize !== undefined) {
                    data.bytes -= previousSize + (data.sizes.size > 1 ? 1 : 0);
                    data.sizes.delete(input.key);
                    delete data.values[input.key];
                }
            }
            pending.set(id, loadData(id).values);
            flushTimer ??= setTimeout(() => {
                flushTimer = undefined;
                void flush().catch(() => {
                    for (const pluginId of pending.keys()) store.reportFailure(pluginId, "BetterDiscord data could not be saved. Check that the user-plugin data directory is writable.");
                });
            }, 250).unref();
            return;
        }
        if (input.type === "clipboard") {
            if (input.method === "readText") return host.clipboard.readText();
            if (input.method !== "writeText" || typeof input.text !== "string" || Buffer.byteLength(input.text) > MAX_DATA_BYTES)
                throw new Error("The clipboard operation is invalid.");
            return host.clipboard.writeText(input.text);
        }
        if (input.type === "openExternal") {
            const url = publicUrl(input.url);
            void host.openExternal(url.href).catch(error => store.reportFailure(id, error instanceof Error ? error.message : "The link could not be opened."));
            return;
        }
        if (input.type !== "fs") throw new Error("This compatibility operation is not supported.");
        const local = localPath(input.path);
        const source = sources(id);
        const knownSource = Object.hasOwn(source, local);
        if (knownSource) {
            if (input.method === "exists") return true;
            if (input.method === "readFile") return input.encoding === "utf8" ? source[local] : Buffer.from(source[local]).toString("base64");
            if (input.method === "stat") return { isFile: true, isDirectory: false, size: Buffer.byteLength(source[local]), mtimeMs: 0 };
            throw new Error("Plugin sources are read only. Use User plugins to install updates.");
        }
        const sourceDirectory = !local || Object.keys(source).some(name => name.startsWith(`${local}/`));
        if (sourceDirectory) {
            if (input.method === "exists") return true;
            if (input.method === "stat") return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 };
            if (input.method !== "readdir") throw new Error("The source directory is read only.");
            const prefix = local ? `${local}/` : "";
            const dataDirectory = safePath(join(root, ".betterdiscord-data", id, "files", local));
            return [...new Set([...Object.keys(source).filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length).split("/")[0]),
                ...existsSync(dataDirectory) ? readdirSync(dataDirectory) : []])];
        }
        const path = mutablePath(id, local);
        const exists = existsSync(path);
        if (input.method === "exists") return exists;
        if (input.method === "readFile") {
            if (lstatSync(path).size > MAX_FILE_BYTES) throw new Error("The data file exceeds 10 MiB.");
            return readFileSync(path).toString(input.encoding === "utf8" ? "utf8" : "base64");
        }
        if (input.method === "stat") {
            const stat = lstatSync(path);
            return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs };
        }
        if (input.method === "readdir") return readdirSync(path);
        if (input.method === "mkdir") {
            if (local.split("/").length > 20) throw new Error("The data path contains too many folders.");
            checkQuota(safePath(join(root, ".betterdiscord-data", id)));
            mkdirSync(path, { recursive: true });
            return;
        }
        if (input.method === "writeFile") {
            if (typeof input.content !== "string" || input.content.length > MAX_FILE_BYTES * 2 || input.encoding !== undefined && !["utf8", "base64"].includes(input.encoding))
                throw new Error("The data file content is invalid or too large.");
            const bytes = Buffer.from(input.content, input.encoding === "base64" ? "base64" : "utf8");
            if (bytes.length > MAX_FILE_BYTES) throw new Error("The data file exceeds 10 MiB.");
            mkdirSync(safePath(dirname(path)), { recursive: true });
            if (exists && lstatSync(path).size > MAX_FILE_BYTES) throw new Error("The data file exceeds 10 MiB.");
            const previous = exists ? readFileSync(path) : undefined;
            writeFileSync(path, bytes);
            const dataOwner = relative(join(root, ".betterdiscord-data"), path).split(sep)[0];
            try { checkQuota(safePath(join(root, ".betterdiscord-data", dataOwner))); } catch (error) {
                if (previous) writeFileSync(path, previous);
                else unlinkSync(path);
                throw error;
            }
            return;
        }
        if (input.method === "rename") {
            const destination = localPath(input.destination ?? "");
            if (Object.hasOwn(source, destination)) throw new Error("Plugin sources are read only.");
            renameSync(path, mutablePath(id, destination));
            return;
        }
        if (input.method === "unlink") { unlinkSync(path); return; }
        if (input.method === "rm") { checkQuota(path); rmSync(path, { recursive: true, force: true }); return; }
        throw new Error("This filesystem operation is not supported.");
    }

    async function request(id: string, input: BetterDiscordRequest) {
        plugin(id, true);
        if (activeRequests >= 4) throw new Error("Too many compatibility network requests are active. Try again after one finishes.");
        const checked = checkedRequest(input);
        activeRequests++;
        try { return await (host.request ?? requestBetterDiscord)(checked); }
        finally { activeRequests--; }
    }

    async function flush() {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
        for (const [id, data] of pending) {
            write(dataPath(id), JSON.stringify(data));
            pending.delete(id);
        }
    }

    return { snapshot, operation, request, flush };
}
