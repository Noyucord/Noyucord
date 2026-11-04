/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { UserPluginSource } from "@shared/userPlugins";
import { createHash } from "crypto";
import { lookup } from "dns/promises";
import { request } from "https";
import { isIP } from "net";

import { MAX_DOWNLOAD_BYTES, unpackZip } from "./files";
import type { PluginFiles } from "./package";

export interface RemotePackage {
    files: PluginFiles;
    source: UserPluginSource;
    revision: string;
}

export interface Download {
    data: Uint8Array;
    etag?: string;
    modified?: string;
}

export class RemoteError extends Error {
    constructor(message: string, public status: number, public retryAt?: number) {
        super(message);
    }
}

export function isPublicAddress(address: string): boolean {
    if (isIP(address) === 6)
        return /^[23]/i.test(address) && !/^2001:db8:/i.test(address);
    if (isIP(address) !== 4) return false;
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
        a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
        a === 192 && (b === 0 || b === 168) || a === 100 && b >= 64 && b <= 127 ||
        a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0);
}

export function publicUrl(input: string): URL {
    if (typeof input !== "string" || input.length > 4096) throw new Error("Enter a valid HTTPS URL.");
    const url = new URL(input);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" ||
        host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isIP(host) && !isPublicAddress(host))
        throw new Error("Plugin downloads require a public HTTPS URL without credentials.");
    url.hash = "";
    return url;
}

export async function download(input: string, redirects = 0): Promise<Download> {
    if (redirects > 5) throw new Error("The download redirected too many times.");
    const url = publicUrl(input);
    return new Promise((resolve, reject) => {
        let total = 0;
        const chunks: Buffer[] = [];
        const req = request(url, {
            headers: { "User-Agent": "Noyucord user plugins", Accept: "application/vnd.github+json" },
            lookup: (hostname, options, callback) => {
                lookup(hostname, { all: true }).then(addresses => {
                    if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) {
                        callback(new Error("The download host does not resolve to a public address."), "");
                        return;
                    }
                    const matching = addresses.filter(entry => !options.family || entry.family === options.family);
                    const first = matching[0];
                    if (!first) callback(new Error("The download host has no supported address."), "");
                    else callback(null, options.all ? matching : first.address, first.family);
                }, error => callback(error, ""));
            }
        }, response => {
            const status = response.statusCode ?? 0;
            if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
                response.resume();
                download(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject);
                return;
            }
            if (status !== 200) {
                response.resume();
                const reset = Number(response.headers["x-ratelimit-reset"]);
                const retry = Number(response.headers["retry-after"]);
                const retryAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + (Number.isFinite(retry) && retry > 0 ? retry : 3600) * 1000;
                const message = status === 403 || status === 429
                    ? "The source is rate limited or denied access. Try again later."
                    : status === 401 || status === 404 ? "The source was not found or requires authentication. Only public sources are supported."
                        : `The plugin source returned HTTP ${status}.`;
                reject(new RemoteError(message, status, status === 403 || status === 429 ? retryAt : undefined));
                return;
            }
            if (Number(response.headers["content-length"]) > MAX_DOWNLOAD_BYTES) {
                response.destroy();
                reject(new Error("The download exceeds 25 MiB."));
                return;
            }
            response.on("data", (chunk: Buffer) => {
                total += chunk.length;
                if (total > MAX_DOWNLOAD_BYTES) {
                    response.destroy();
                    reject(new Error("The download exceeds 25 MiB."));
                } else chunks.push(chunk);
            });
            response.on("error", () => reject(new Error("The plugin download was interrupted.")));
            response.on("end", () => resolve({
                data: Buffer.concat(chunks),
                etag: typeof response.headers.etag === "string" ? response.headers.etag : undefined,
                modified: response.headers["last-modified"]
            }));
        });
        req.setTimeout(30_000, () => req.destroy(new Error("The plugin download timed out.")));
        const deadline = setTimeout(() => req.destroy(new Error("The plugin download timed out.")), 30_000);
        req.once("close", () => clearTimeout(deadline));
        req.on("error", error => reject(new Error(error.message.startsWith("The ") ? error.message : "Unable to reach the public plugin source.")));
        req.end();
    });
}

async function githubJson(path: string, fetcher: typeof download): Promise<unknown> {
    const response = await fetcher(`https://api.github.com${path}`);
    return JSON.parse(new TextDecoder().decode(response.data));
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha(value: unknown): string {
    if (!record(value) || typeof value.sha !== "string" || !/^[a-f\d]{40}$/i.test(value.sha))
        throw new Error("GitHub returned an invalid revision.");
    return value.sha;
}

export interface ReleaseAsset {
    key: string;
    name: string;
    url: string;
    revision: string;
}

export async function releaseAssets(input: string, fetcher: typeof download = download): Promise<ReleaseAsset[] | null> {
    const url = publicUrl(input);
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[2] !== "releases" || parts[3] === "download") return null;
    const [owner, repo] = parts;
    if (!owner || !repo) throw new Error("Enter a GitHub repository or release URL.");
    const suffix = parts[3] === "tag" && parts.length > 4 ? `tags/${encodeURIComponent(parts.slice(4).join("/"))}` : "latest";
    const release = await githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${suffix}`, fetcher);
    if (!record(release) || !Array.isArray(release.assets)) throw new Error("GitHub returned an invalid release.");
    const assets: ReleaseAsset[] = [];
    for (const asset of release.assets) {
        if (!record(asset) || typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") continue;
        if (!/\.(zip|[jt]sx?)$/i.test(asset.name)) continue;
        assets.push({
            key: String(asset.id), name: asset.name, url: asset.browser_download_url,
            revision: `${String(release.id)}:${String(asset.id)}:${String(asset.updated_at)}`
        });
    }
    if (!assets.length) throw new Error("This release has no JS/TS or ZIP plugin assets.");
    return assets;
}

async function selectedReleaseAsset(url: URL, assetName: string | undefined, fetcher: typeof download) {
    const assets = await releaseAssets(url.href, fetcher);
    const selected = assets?.find(asset => asset.name === assetName) ?? (assets?.length === 1 ? assets[0] : undefined);
    if (!selected) throw new Error("Select a release asset before installing.");
    return selected;
}

async function githubRepository(parts: string[], fetcher: typeof download) {
    const [owner, rawRepo] = parts;
    const repo = rawRepo.replace(/\.git$/, "");
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    let ref: string;
    let revision: string | undefined;
    let path = "";
    if (parts[2] === "tree" || parts[2] === "blob") {
        if (!parts[3]) throw new Error("The GitHub URL is missing a branch or commit.");
        let found = false;
        ref = parts[3];
        for (let length = parts.length - 3; length >= 1; length--) {
            const candidate = parts.slice(3, 3 + length).join("/");
            try {
                revision = sha(await githubJson(`${base}/commits/${encodeURIComponent(candidate)}`, fetcher));
                ref = candidate;
                path = parts.slice(3 + length).join("/");
                found = true;
                break;
            } catch (error) {
                if (!(error instanceof RemoteError) || error.status !== 404) throw error;
            }
        }
        if (!found) throw new Error("The GitHub branch or commit was not found.");
    } else if (parts.length === 2) {
        const repository = await githubJson(base, fetcher);
        if (!record(repository) || typeof repository.default_branch !== "string") throw new Error("GitHub returned an invalid repository.");
        ref = repository.default_branch;
    } else throw new Error("Use a GitHub repository, folder, file, or release URL.");
    revision ??= sha(await githubJson(`${base}/commits/${encodeURIComponent(ref)}`, fetcher));
    return { base, ref, path, revision };
}

export async function fetchRemoteRevision(input: string, assetName?: string, fetcher: typeof download = download): Promise<string> {
    const url = publicUrl(input);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.hostname === "github.com" && parts[2] === "releases" && parts[3] !== "download")
        return (await selectedReleaseAsset(url, assetName, fetcher)).revision;
    if (url.hostname === "github.com" && parts.length >= 2 && parts[2] !== "releases")
        return (await githubRepository(parts, fetcher)).revision;
    return (await fetchRemotePackage(url.href, assetName, fetcher)).revision;
}

export async function fetchRemotePackage(input: string, assetName?: string, fetcher: typeof download = download): Promise<RemotePackage> {
    const url = publicUrl(input);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.hostname === "github.com" && parts[2] === "releases" && parts[3] !== "download") {
        const selected = await selectedReleaseAsset(url, assetName, fetcher);
        const result = await fetchRemotePackage(selected.url, undefined, fetcher);
        return { ...result, source: { kind: "github", url: url.href, asset: selected.name, revision: selected.revision }, revision: selected.revision };
    }
    if (url.hostname === "github.com" && parts.length >= 2 && parts[2] !== "releases") {
        const { base, ref, path, revision } = await githubRepository(parts, fetcher);
        const archive = await fetcher(`https://api.github.com${base}/zipball/${revision}`);
        const files = unpackZip(archive.data);
        let selected = files;
        if (path) {
            if (parts[2] === "blob") {
                const content = files[path];
                if (!content) throw new Error("The selected GitHub file was not found.");
                const root = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
                selected = Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith(root)).map(([name, bytes]) => [name.slice(root.length), bytes]));
            } else {
                selected = Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith(`${path}/`)).map(([name, bytes]) => [name.slice(path.length + 1), bytes]));
            }
            if (!Object.keys(selected).length) throw new Error("The selected GitHub folder was not found.");
        }
        return { files: selected, revision, source: { kind: "github", url: url.href, revision, pinned: /^[a-f\d]{40}$/i.test(ref) } };
    }
    const response = await fetcher(url.href);
    const revision = createHash("sha256").update(response.data).digest("hex");
    const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const files = /\.zip$/i.test(name) || response.data[0] === 0x50 && response.data[1] === 0x4b
        ? unpackZip(response.data)
        : /\.[jt]sx?$/i.test(name) ? { [name]: response.data } : null;
    if (!files) throw new Error("The URL must point to a JS/TS file or ZIP plugin package.");
    return { files, revision, source: { kind: url.hostname === "github.com" ? "github" : "url", url: url.href, revision } };
}
