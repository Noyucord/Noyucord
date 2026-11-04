/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Unzip, UnzipInflate } from "fflate";
import { lstat, readdir, readFile } from "fs/promises";
import { basename, join } from "path";

import type { PluginFiles } from "./package";

export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 2000;

export function packagePath(value: string): string {
    if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[a-z]:/i.test(value))
        throw new Error("The package contains an invalid file path.");
    const parts = value.split("/");
    if (parts.some(part => part === ".." || part === "." || !part || /[:<>"|?*]/.test(part) || /[. ]$/.test(part)))
        throw new Error("The package contains an unsafe file path.");
    if (parts.some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
        throw new Error("The package contains a reserved file name.");
    return parts.join("/");
}

export function unpackZip(data: Uint8Array): PluginFiles {
    if (data.length > MAX_DOWNLOAD_BYTES) throw new Error("The archive exceeds the 25 MiB download limit.");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let end = data.length - 22;
    for (; end >= Math.max(0, data.length - 65557); end--)
        if (view.getUint32(end, true) === 0x06054b50) break;
    if (end < 0 || end < data.length - 65557) throw new Error("The ZIP archive is invalid.");
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);
    if (count > MAX_PACKAGE_FILES || count === 65535 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0)
        throw new Error("Split, ZIP64, or oversized archives are not supported.");
    let total = 0;
    const names = new Set<string>();
    const sizes = new Map<string, { size: number; compressed: number; directory: boolean; }>();
    for (let index = 0; index < count; index++) {
        if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error("The ZIP directory is invalid.");
        const size = view.getUint32(offset + 24, true);
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const mode = view.getUint32(offset + 38, true) >>> 16;
        const nameEnd = offset + 46 + nameLength;
        if (nameEnd + extraLength + commentLength > end) throw new Error("The ZIP entry is invalid.");
        const rawName = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(offset + 46, nameEnd));
        const name = packagePath(rawName.replace(/\/$/, ""));
        if (names.has(name.toLowerCase())) throw new Error("The package contains duplicate file names.");
        names.add(name.toLowerCase());
        sizes.set(rawName, { size, compressed: view.getUint32(offset + 20, true), directory: rawName.endsWith("/") });
        if ((mode & 0xf000) === 0xa000 || (view.getUint16(offset + 8, true) & 1))
            throw new Error("Encrypted archives and symbolic links are not supported.");
        total += size;
        if (size > MAX_FILE_BYTES || total > MAX_PACKAGE_BYTES) throw new Error("The unpacked package exceeds its size limit.");
        offset = nameEnd + extraLength + commentLength;
    }
    const files: PluginFiles = Object.create(null);
    let actual = 0;
    const seen = new Set<string>();
    const finished = new Set<string>();
    const unzip = new Unzip(file => {
        const expected = sizes.get(file.name);
        if (!expected || seen.has(file.name) || file.originalSize !== undefined && file.originalSize !== expected.size || file.size !== undefined && file.size !== expected.compressed)
            throw new Error("The ZIP file does not match its directory.");
        seen.add(file.name);
        if (expected.directory) return;
        const safeName = packagePath(file.name);
        const chunks: Uint8Array[] = [];
        let length = 0;
        file.ondata = (error, chunk, final) => {
            if (error) throw new Error(error.message === "The unpacked package exceeds its size limit." ? error.message : "The ZIP file could not be decompressed.");
            length += chunk.length;
            actual += chunk.length;
            if (length > expected.size || length > MAX_FILE_BYTES || actual > MAX_PACKAGE_BYTES) {
                file.terminate();
                throw new Error("The unpacked package exceeds its size limit.");
            }
            chunks.push(chunk);
            if (final) {
                if (length !== expected.size) throw new Error("The ZIP file does not match its directory.");
                const content = new Uint8Array(length);
                let written = 0;
                for (const bytes of chunks) {
                    content.set(bytes, written);
                    written += bytes.length;
                }
                files[safeName] = content;
                finished.add(file.name);
            }
        };
        file.start();
    });
    unzip.register(UnzipInflate);
    for (let index = 0; index < data.length; index += 4096)
        unzip.push(data.subarray(index, index + 4096), index + 4096 >= data.length);
    for (const [name, expected] of sizes) {
        if (!expected.directory && !finished.has(name)) throw new Error("The ZIP archive is incomplete.");
    }
    const keys = Object.keys(files);
    const outer = keys[0]?.split("/")[0];
    if (outer && keys.every(key => key.startsWith(`${outer}/`)))
        return Object.fromEntries(Object.entries(files).map(([key, value]) => [key.slice(outer.length + 1), value]));
    return files;
}

export async function readLocalPackage(path: string): Promise<PluginFiles> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Symbolic links cannot be imported.");
    if (info.isFile()) {
        if (info.size > MAX_DOWNLOAD_BYTES) throw new Error("The selected file is too large.");
        const data = await readFile(path);
        if (/\.zip$/i.test(path)) return unpackZip(data);
        if (!/\.(?:[jt]sx?)$/i.test(path)) throw new Error("Select a JS/TS plugin, a folder, or a ZIP package.");
        return { [basename(path)]: data };
    }
    if (!info.isDirectory()) throw new Error("Select a regular file or folder.");
    const files: PluginFiles = Object.create(null);
    let total = 0;
    async function visit(directory: string, prefix: string, depth: number) {
        if (depth > 20) throw new Error("The package has too many nested folders.");
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if ([".git", "node_modules", ".DS_Store"].includes(entry.name)) continue;
            const name = packagePath(prefix + entry.name);
            const fullPath = join(directory, entry.name);
            const stat = await lstat(fullPath);
            if (stat.isSymbolicLink()) throw new Error("The package contains a symbolic link.");
            if (stat.isDirectory()) await visit(fullPath, `${name}/`, depth + 1);
            else if (stat.isFile()) {
                total += stat.size;
                if (stat.size > MAX_FILE_BYTES || total > MAX_PACKAGE_BYTES || Object.keys(files).length >= MAX_PACKAGE_FILES)
                    throw new Error("The selected package exceeds its size or file limit.");
                files[name] = await readFile(fullPath);
            } else throw new Error("The package contains an unsupported file type.");
        }
    }
    await visit(path, "", 0);
    return files;
}
