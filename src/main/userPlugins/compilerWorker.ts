/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { USER_PLUGIN_HOST_MODULES } from "@shared/userPluginModules";
import type { Loader, Plugin } from "esbuild-wasm";
import * as browserEsbuild from "esbuild-wasm/lib/browser.js";
import { builtinModules } from "module";
import { posix } from "path";
import ts from "typescript";
import { parentPort, workerData } from "worker_threads";

import type { CompilerJob, CompilerReply } from "./compiler";
import { PACKAGE_LIMITS, prepareRendererSource, validateManifest, validatePackageFiles, validatePackagePath } from "./package";

const esbuild: typeof import("esbuild-wasm") = browserEsbuild;
const hostModules = new Set<string>(USER_PLUGIN_HOST_MODULES);
const nativeModules = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`), "electron"]);
const betterDiscordModules = new Set(["fs", "path", "process", "request", "electron", "react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"]);
const sourceTypes: Record<string, Loader> = { ".js": "js", ".jsx": "jsx", ".ts": "ts", ".tsx": "tsx", ".json": "json" };
const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".avif": "image/avif" };
const decoder = new TextDecoder();

function rejectDynamicImports(path: string, bytes: Uint8Array, betterDiscord: boolean) {
    const source = ts.createSourceFile(path, decoder.decode(bytes), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error("Dynamic imports are not supported. Use package-local static imports.");
            if (!betterDiscord && ts.isIdentifier(node.expression) && node.expression.text === "require" && (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])))
                throw new Error("Computed require calls are not supported. Use literal imports from the package or host APIs.");
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
}

async function compile(input: CompilerJob) {
    const { files, target, native } = input;
    const manifest = validateManifest(input.manifest);
    const betterDiscord = !native && manifest.runtime === "betterdiscord";
    const entry = native ? manifest.native : manifest.entry;
    if (!entry) throw new Error("The plugin does not declare a native helper entry.");
    validatePackageFiles(files);
    if (manifest.target !== "desktop" && manifest.target !== target) throw new Error("This plugin does not support the current desktop client.");
    function resolveFile(path: string) {
        validatePackagePath(path);
        const candidates = [path, ...[".ts", ".tsx", ".js", ".jsx", ".json"].map(ext => path + ext), ...["index.ts", "index.tsx", "index.js", "index.jsx"].map(index => path + "/" + index)];
        const found = candidates.find(candidate => Object.hasOwn(files, candidate));
        if (!found) throw new Error(`Package file not found: ${path}`);
        return found;
    }
    function imageUrl(path: string) {
        const mime = imageTypes[posix.extname(path).toLowerCase()];
        if (!mime) throw new Error(`Unsupported asset type: ${path}`);
        return `data:${mime};base64,${Buffer.from(files[path]).toString("base64")}`;
    }
    const virtualFiles: Plugin = {
        name: "noyucord-package",
        setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
                if (args.kind === "entry-point") return { path: resolveFile(entry), namespace: "package" };
                if (native && nativeModules.has(args.path)) return { path: args.path, external: true };
                if (betterDiscord && betterDiscordModules.has(args.path)) return { path: args.path, external: true };
                if (!native && !betterDiscord && (args.path === "@noyucord/runtime" || hostModules.has(args.path) || /^@(plugins|equicordplugins|noyucordplugins)\/[A-Za-z0-9_.-]+$/.test(args.path))) return { path: args.path, external: true };
                if (!args.path.startsWith(".")) return { errors: [{ text: `Unsupported import: ${args.path}. ${native ? "Native helpers support only package-local files, Electron, and Node builtins." : betterDiscord ? "BetterDiscord plugins support package-local files, shared React, and the approved fs, path, process, request, and electron compatibility modules." : "Bundle external dependencies and use supported Noyucord renderer APIs."}` }] };
                const managed = args.path.endsWith(".css?managed");
                const path = resolveFile(posix.normalize(posix.join(posix.dirname(args.importer), managed ? args.path.slice(0, -8) : args.path)));
                return { path: path + (managed ? "?managed" : ""), namespace: "package" };
            });
            build.onLoad({ filter: /.*/, namespace: "package" }, args => {
                const managed = args.path.endsWith("?managed");
                const path = managed ? args.path.slice(0, -8) : args.path;
                const bytes = files[path];
                const extension = posix.extname(path).toLowerCase();
                if (native && (imageTypes[extension] || extension === ".css")) throw new Error("Native helpers can import only JavaScript, TypeScript, JSON, Electron, and Node builtins.");
                if (imageTypes[extension]) return { contents: `export default ${JSON.stringify(imageUrl(path))};`, loader: "js" };
                if (extension === ".css") {
                    const cssSource = decoder.decode(bytes);
                    if (/@import\b/i.test(cssSource)) throw new Error("CSS @import is not supported. Include styles in the plugin package.");
                    const css = cssSource.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, _quote: string, url: string) => {
                        if (/^(?:data:|https?:|#)/i.test(url)) return match;
                        const imagePath = resolveFile(posix.normalize(posix.join(posix.dirname(path), url)));
                        return `url(${JSON.stringify(imageUrl(imagePath))})`;
                    });
                    const id = JSON.stringify(`user:${manifest.id}/${path}`);
                    return { contents: betterDiscord ? `BdApi.DOM.addStyle(${id},${JSON.stringify(css)});export default ${id};` : `import {createStyle} from "@noyucord/runtime";export default createStyle(${id},${JSON.stringify(css)},${managed});`, loader: "js" };
                }
                const loader = sourceTypes[extension];
                if (!loader) throw new Error(`Unsupported package file type: ${path}`);
                if (loader !== "json") rejectDynamicImports(path, bytes, betterDiscord);
                return { contents: !native && loader !== "json" ? prepareRendererSource(path, bytes, manifest) : decoder.decode(bytes), loader };
            });
        }
    };
    Object.defineProperty(globalThis, "self", { value: globalThis, configurable: true });
    await esbuild.initialize({ wasmModule: input.wasmModule, worker: false });
    try {
        const result = await esbuild.build({
            entryPoints: [entry], bundle: true, write: false, platform: native ? "node" : "browser", format: "cjs",
            target: "es2022", logLevel: "silent", plugins: [virtualFiles], legalComments: "inline",
            jsxFactory: betterDiscord ? "BdApi.React.createElement" : "__noyucordRuntime.createElement", jsxFragment: betterDiscord ? "BdApi.React.Fragment" : "__noyucordRuntime.Fragment",
            banner: native || betterDiscord ? undefined : { js: "const __noyucordRuntime=require('@noyucord/runtime');" },
            define: {
                IS_WEB: "false", IS_EXTENSION: "false", IS_USERSCRIPT: "false", IS_STANDALONE: "true",
                IS_DISCORD_DESKTOP: String(target === "discordDesktop"), IS_EQUIBOP: String(target === "equibop"),
                IS_VESKTOP: "false", IS_DEV: "false", IS_REPORTER: "false", IS_UPDATER_DISABLED: "true",
                IS_COMPANION_TEST: "false", IS_ANTI_CRASH_TEST: "false",
                VERSION: JSON.stringify(typeof VERSION === "undefined" ? "unknown" : VERSION),
                BUILD_TIMESTAMP: String(typeof BUILD_TIMESTAMP === "undefined" ? 0 : BUILD_TIMESTAMP)
            }
        });
        const code = result.outputFiles[0]?.text;
        if (!code || code.length > PACKAGE_LIMITS.file) throw new Error("The compiled plugin bundle is empty or exceeds 10 MiB.");
        return code;
    } finally {
        esbuild.stop();
    }
}

if (parentPort) {
    const port = parentPort;
    compile(workerData as CompilerJob).then(
        code => port.postMessage({ code } satisfies CompilerReply),
        (error: unknown) => {
            const raw = error instanceof Error ? error.message : "Plugin compilation failed.";
            const errorMessage = raw.replace(/(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)[^\s"']+/g, "[local path]").slice(0, 2000);
            port.postMessage({ error: errorMessage } satisfies CompilerReply);
        }
    );
}
