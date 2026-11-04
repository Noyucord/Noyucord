/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserPluginManifest } from "@shared/userPlugins";
import { readFile } from "fs/promises";
import { join } from "path";
import { Worker } from "worker_threads";

import { PluginFiles, validateManifest, validatePackageFiles } from "./package";

export interface CompilerInput {
    files: PluginFiles;
    manifest: UserPluginManifest;
    target: "discordDesktop" | "equibop";
    native?: boolean;
}

export interface CompilerReply {
    code?: string;
    error?: string;
}

export interface CompilerJob extends CompilerInput {
    wasmModule: WebAssembly.Module;
}

let assets: Promise<{ source: string; wasmModule: WebAssembly.Module; }> | undefined;

function compilerAssets() {
    return assets ??= Promise.all([
        readFile(join(__dirname, "userPluginCompiler.js"), "utf8"),
        readFile(join(__dirname, "esbuild.wasm"))
    ]).then(async ([source, bytes]) => ({ source, wasmModule: await WebAssembly.compile(bytes) })).catch(() => {
        assets = undefined;
        throw new Error("The plugin compiler could not start. Check that the desktop installation includes its compiler assets.");
    });
}

export function compilePackage(files: PluginFiles, manifest: UserPluginManifest, target: CompilerInput["target"]): Promise<string> {
    return compile({ files, manifest, target });
}

export function compileNativePackage(files: PluginFiles, manifest: UserPluginManifest, target: CompilerInput["target"]): Promise<string | undefined> {
    if (!manifest.native) return Promise.resolve(undefined);
    return compile({ files, manifest, target, native: true });
}

function compile(input: CompilerInput): Promise<string> {
    const { files, manifest, target } = input;
    validatePackageFiles(files);
    validateManifest(manifest);
    if (manifest.target !== "desktop" && manifest.target !== target) return Promise.reject(new Error("This plugin does not support the current desktop client."));
    return new Promise((resolve, reject) => {
        let worker: Worker | undefined;
        const timer = setTimeout(() => finish(new Error("Plugin compilation exceeded the 30 second limit.")), 30_000);
        let settled = false;
        function finish(error?: Error, code?: string) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker?.removeAllListeners();
            void worker?.terminate();
            if (error) reject(error);
            else if (typeof code === "string") resolve(code);
            else reject(new Error("The compiler did not produce a plugin bundle."));
        }
        void compilerAssets().then(({ source, wasmModule }) => {
            if (settled) return;
            worker = new Worker(source, {
                eval: true,
                workerData: { ...input, wasmModule } satisfies CompilerJob,
                resourceLimits: { maxOldGenerationSizeMb: 256 }
            });
            worker.once("message", (reply: CompilerReply) => {
                if (reply.error) finish(new Error(reply.error));
                else finish(undefined, reply.code);
            });
            worker.once("error", () => finish(new Error("The plugin compiler could not start. Check that the desktop installation includes its compiler assets.")));
            worker.once("exit", code => finish(new Error(`The plugin compiler exited before completion (code ${code}).`)));
        }).catch(error => finish(error instanceof Error ? error : new Error("The plugin compiler could not start.")));
    });
}
