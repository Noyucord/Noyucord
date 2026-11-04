/*
 * Noyucord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// @ts-check

import "../suppressExperimentalWarnings.js";
import "../checkNodeVersion.js";

import { exec, execSync } from "child_process";
import esbuild, { build, context } from "esbuild";
import { constants as FsConstants, readFileSync } from "fs";
import { access, readdir, readFile } from "fs/promises";
import { minify as minifyHtml } from "html-minifier-terser";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import ts from "typescript";

import { getPluginTarget } from "../utils.mjs";

const PackageJSON = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf-8"));

export const VERSION = PackageJSON.version;
// https://reproducible-builds.org/docs/source-date-epoch/
export const BUILD_TIMESTAMP = Number(process.env.SOURCE_DATE_EPOCH) * 1000 || Date.now();

export const watch = process.argv.includes("--watch");
export const IS_DEV = watch || process.argv.includes("--dev");
export const IS_REPORTER = process.argv.includes("--reporter");
export const IS_ANTI_CRASH_TEST = process.argv.includes("--anti-crash-test");
export const IS_STANDALONE = process.argv.includes("--standalone");
export const IS_COMPANION_TEST = IS_REPORTER && process.argv.includes("--companion-test");
if (!IS_COMPANION_TEST && process.argv.includes("--companion-test"))
    console.error("--companion-test must be run with --reporter for any effect");

export const IS_UPDATER_DISABLED = process.argv.includes("--disable-updater");
export const gitHash = process.env.EQUICORD_HASH || execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();

export const banner = {
    js: `
// Equicord ${gitHash}
// Standalone: ${IS_STANDALONE}
// Platform: ${IS_STANDALONE === false ? process.platform : "Universal"}
// Updater Disabled: ${IS_UPDATER_DISABLED}
`.trim()
};

/**
 * JSON.stringify all values in an object
 * @type {(obj: Record<string, any>) => Record<string, string>}
 */
export function stringifyValues(obj) {
    for (const key in obj) {
        obj[key] = JSON.stringify(obj[key]);
    }
    return obj;
}

/**
 * @param {import("esbuild").BuildOptions[]} buildConfigs
 */
export async function buildOrWatchAll(buildConfigs) {
    if (watch) {
        await Promise.all(buildConfigs.map(cfg =>
            context(cfg).then(ctx => ctx.watch())
        ));
    } else {
        for (const cfg of buildConfigs) {
            await build(cfg).catch(error => {
                console.error(error.message);
                process.exit(1);
            });
        }
    }
}

/**
 * @param {string} base
 * @param {import("fs").Dirent} dirent
 */
export async function resolvePluginName(base, dirent) {
    const fullPath = join(base, dirent.name);
    let entryPoint = fullPath;
    const content = dirent.isFile()
        ? await readFile(fullPath, "utf-8")
        : await (async () => {
            for (const file of ["index.ts", "index.tsx"]) {
                try {
                    const source = await readFile(join(fullPath, file), "utf-8");
                    entryPoint = join(fullPath, file);
                    return source;
                } catch {
                    continue;
                }
            }
            throw new Error(`Invalid plugin ${fullPath}: could not resolve entry point`);
        })();

    const source = ts.createSourceFile(entryPoint, content, ts.ScriptTarget.Latest);
    for (const statement of source.statements) {
        if (!ts.isExportAssignment(statement) || !ts.isCallExpression(statement.expression)) continue;
        const call = statement.expression;
        if (!ts.isIdentifier(call.expression) || call.expression.text !== "definePlugin") continue;
        const definition = call.arguments[0];
        if (!definition || !ts.isObjectLiteralExpression(definition)) continue;
        const name = definition.properties.find(property =>
            ts.isPropertyAssignment(property)
            && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            && property.name.text === "name"
        );
        if (name && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer))
            return name.initializer.text;
    }
    throw new Error(`Invalid plugin ${fullPath}: must export definePlugin with a string name property.`);
}

export async function exists(path) {
    return await access(path, FsConstants.F_OK)
        .then(() => true)
        .catch(() => false);
}

// https://github.com/evanw/esbuild/issues/619#issuecomment-751995294
/**
 * @type {import("esbuild").Plugin}
 */
export const makeAllPackagesExternalPlugin = {
    name: "make-all-packages-external",
    setup(build) {
        const filter = /^[^./]|^\.[^./]|^\.\.[^/]/; // Must not start with "/" or "./" or "../"
        build.onResolve({ filter }, args => ({ path: args.path, external: true }));
    }
};

export const bundledPluginRoots = ["plugins/vencord", "plugins/equicord", "noyucordplugins", "userplugins"];

/** @type {import("esbuild").Plugin} */
export const userPluginAuthors = {
    name: "userplugin-authors",
    setup(build) {
        build.onResolve({ filter: /^~userplugin-authors$/ }, () => ({ path: "authors", namespace: "userplugin-authors" }));
        build.onLoad({ filter: /.*/, namespace: "userplugin-authors" }, async () => {
            const path = resolve("src/utils/constants.ts");
            const source = ts.createSourceFile(path, await readFile(path, "utf-8"), ts.ScriptTarget.Latest);
            const declarations = source.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []);
            const registries = Object.fromEntries(["Devs", "EquicordDevs", "NoyucordDevs"].map(name => {
                const declaration = declarations.find(entry => ts.isIdentifier(entry.name) && entry.name.text === name);
                const initializer = declaration?.initializer;
                const invalid = () => new Error(`Cannot generate user plugin authors: unsupported ${name} registry format.`);
                if (!initializer || !ts.isCallExpression(initializer) || !ts.isPropertyAccessExpression(initializer.expression)
                    || !ts.isIdentifier(initializer.expression.expression) || initializer.expression.expression.text !== "Object"
                    || initializer.expression.name.text !== "freeze" || initializer.arguments.length !== 1) throw invalid();
                const value = initializer.arguments[0];
                if (!ts.isSatisfiesExpression(value) || !ts.isObjectLiteralExpression(value.expression)) throw invalid();
                const authors = Object.fromEntries(value.expression.properties.map(entry => {
                    if (!ts.isPropertyAssignment(entry) || !(ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) || !ts.isObjectLiteralExpression(entry.initializer)) throw invalid();
                    const properties = entry.initializer.properties;
                    const authorName = properties.find(property => ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "name");
                    const authorId = properties.find(property => ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "id");
                    if (!authorName || !ts.isPropertyAssignment(authorName) || !ts.isStringLiteral(authorName.initializer)
                        || !authorId || !ts.isPropertyAssignment(authorId) || !ts.isBigIntLiteral(authorId.initializer)) throw invalid();
                    const id = authorId.initializer.text.slice(0, -1);
                    if (!/^\d{1,20}$/.test(id)) throw invalid();
                    return [entry.name.text, { name: authorName.initializer.text, id }];
                }));
                return [name, authors];
            }));
            return { contents: `export default ${JSON.stringify(registries)};`, loader: "js", watchFiles: [path] };
        });
    }
};

export const bundledPluginNames = {
    name: "bundled-plugin-names",
    setup(build) {
        build.onResolve({ filter: /^~bundled-plugin-names$/ }, () => ({ path: "names", namespace: "bundled-plugin-names" }));
        build.onLoad({ filter: /.*/, namespace: "bundled-plugin-names" }, async () => {
            const names = [];
            for (const root of bundledPluginRoots) {
                for (const dir of [root, `${root}/_api`, `${root}/_core`]) {
                    const base = join("src", dir);
                    if (!await exists(base)) continue;
                    for (const file of await readdir(base, { withFileTypes: true })) {
                        if (file.name.startsWith("_") || file.name.startsWith(".") || file.name === "index.ts") continue;
                        names.push(await resolvePluginName(base, file));
                    }
                }
            }
            return { contents: `export default ${JSON.stringify(names.sort())};`, loader: "js" };
        });
    }
};

/**
 * @type {(kind: "web" | "discordDesktop" | "vesktop" | "equibop") => import("esbuild").Plugin}
 */
export const globPlugins = kind => ({
    name: "glob-plugins",
    setup: build => {
        const filter = /^~plugins$/;
        build.onResolve({ filter }, args => {
            return {
                namespace: "import-plugins",
                path: args.path
            };
        });

        build.onLoad({ filter, namespace: "import-plugins" }, async () => {
            const pluginDirs = ["plugins/vencord/_api", "plugins/vencord/_core", "plugins/vencord", "plugins/equicord/_api", "plugins/equicord/_core", "plugins/equicord", "noyucordplugins/_api", "noyucordplugins/_core", "noyucordplugins", "userplugins"];
            let code = "";
            let pluginsCode = "\n";
            let metaCode = "\n";
            let excludedCode = "\n";
            let i = 0;
            for (const dir of pluginDirs) {
                const userPlugin = dir === "userplugins";
                const origin = userPlugin ? "user" : dir.startsWith("plugins/vencord") ? "vencord" : dir.startsWith("plugins/equicord") ? "equicord" : "noyucord";

                const fullDir = `./src/${dir}`;
                if (!await exists(fullDir)) continue;
                const files = await readdir(fullDir, { withFileTypes: true });
                for (const file of files) {
                    const fileName = file.name;
                    if (fileName.startsWith("_") || fileName.startsWith(".")) continue;
                    if (fileName === "index.ts") continue;
                    if (/\.(zip|rar|7z|tar|gz|bz2)/.test(fileName)) continue;

                    const target = getPluginTarget(fileName);

                    if (target && !IS_REPORTER) {
                        const excluded =
                            (target === "dev" && !IS_DEV) ||
                            (target === "web" && kind === "discordDesktop") ||
                            (target === "browser" && kind !== "web") ||
                            (target === "desktop" && kind === "web") ||
                            (target === "discordDesktop" && kind !== "discordDesktop") ||
                            (target === "vesktop" && kind !== "vesktop" && kind !== "equibop") ||
                            (target === "equibop" && kind !== "equibop" && kind !== "vesktop");

                        if (excluded) {
                            const name = await resolvePluginName(fullDir, file);
                            excludedCode += `${JSON.stringify(name)}:${JSON.stringify(target)},\n`;
                            continue;
                        }
                    }

                    const folderName = `src/${dir}/${fileName}`;

                    const mod = `p${i}`;
                    code += `import ${mod} from "./${dir}/${fileName.replace(/\.tsx?$/, "")}";\n`;
                    pluginsCode += `[${mod}.name]:${mod},\n`;
                    metaCode += `[${mod}.name]:${JSON.stringify({ folderName, userPlugin, origin })},\n`;
                    i++;
                }
            }
            code += `export default {${pluginsCode}};export const PluginMeta={${metaCode}};export const ExcludedPlugins={${excludedCode}};`;
            return {
                contents: code,
                resolveDir: "./src",
                watchDirs: pluginDirs.map(d => resolve("src", d)),
            };
        });
    }
});

/**
 * @type {import("esbuild").Plugin}
 */
export const gitHashPlugin = {
    name: "git-hash-plugin",
    setup: build => {
        const filter = /^~git-hash$/;
        build.onResolve({ filter }, args => ({
            namespace: "git-hash", path: args.path
        }));
        build.onLoad({ filter, namespace: "git-hash" }, () => ({
            contents: `export default "${gitHash}"`
        }));
    }
};

/**
 * @type {import("esbuild").Plugin}
 */
export const gitRemotePlugin = {
    name: "git-remote-plugin",
    setup: build => {
        const filter = /^~git-remote$/;
        build.onResolve({ filter }, args => ({
            namespace: "git-remote", path: args.path
        }));
        build.onLoad({ filter, namespace: "git-remote" }, async () => {
            let remote = process.env.EQUICORD_REMOTE;
            if (!remote) {
                const res = await promisify(exec)("git remote get-url origin", { encoding: "utf-8" });
                remote = res.stdout.trim()
                    .replace("https://github.com/", "")
                    .replace("git@github.com:", "")
                    .replace(/.git$/, "");
            }

            return { contents: `export default "${remote}"` };
        });
    }
};

/**
 * @type {import("esbuild").Plugin}
 */
export const fileUrlPlugin = {
    name: "file-uri-plugin",
    setup: build => {
        const filter = /^file:\/\/.+$/;
        build.onResolve({ filter }, args => ({
            namespace: "file-uri",
            path: args.path,
            pluginData: {
                uri: args.path,
                path: join(args.resolveDir, args.path.slice("file://".length).split("?")[0])
            }
        }));
        build.onLoad({ filter, namespace: "file-uri" }, async ({ pluginData: { path, uri } }) => {
            const { searchParams } = new URL(uri);
            const base64 = searchParams.has("base64");
            const minify = searchParams.has("minify");
            const noTrim = searchParams.get("trim") === "false";

            const encoding = base64 ? "base64" : "utf-8";

            let content;
            if (!minify) {
                content = await readFile(path, encoding);
                if (!noTrim) content = content.trimEnd();
            } else {
                if (path.endsWith(".html")) {
                    content = await minifyHtml(await readFile(path, "utf-8"), {
                        collapseWhitespace: true,
                        removeComments: true,
                        minifyCSS: true,
                        minifyJS: true,
                        removeEmptyAttributes: true,
                        removeRedundantAttributes: true,
                        removeScriptTypeAttributes: true,
                        removeStyleLinkTypeAttributes: true,
                        useShortDoctype: true
                    });
                } else if (/[mc]?[jt]sx?$/.test(path)) {
                    const res = await esbuild.build({
                        entryPoints: [path],
                        write: false,
                        minify: true
                    });
                    content = res.outputFiles[0].text;
                } else {
                    throw new Error(`Don't know how to minify file type: ${path}`);
                }

                if (base64 && !content.startsWith("data:"))
                    content = Buffer.from(content).toString("base64");
            }

            return {
                contents: `export default ${JSON.stringify(content)}`
            };
        });
    }
};

/**
 * @type {(filter: RegExp, message: string) => import("esbuild").Plugin}
 */
export const banImportPlugin = (filter, message) => ({
    name: "ban-imports",
    setup: build => {
        build.onResolve({ filter }, () => {
            return { errors: [{ text: message }] };
        });
    }
});

const styleModule = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "module/style.js"), "utf-8");

/**
 * @type {import("esbuild").Plugin}
 */
export const stylePlugin = {
    name: "style-plugin",
    setup: ({ onResolve, onLoad }) => {
        onResolve({ filter: /\.css\?managed$/, namespace: "file" }, ({ path, resolveDir }) => ({
            path: relative(process.cwd(), join(resolveDir, path.replace("?managed", ""))),
            namespace: "managed-style",
        }));
        onLoad({ filter: /\.css$/, namespace: "managed-style" }, async ({ path }) => {
            const css = await readFile(path, "utf-8");
            const name = relative(process.cwd(), path).replaceAll("\\", "/");

            return {
                loader: "js",
                contents: styleModule
                    .replaceAll("STYLE_SOURCE", JSON.stringify(css))
                    .replaceAll("STYLE_NAME", JSON.stringify(name))
            };
        });
    }
};

/**
 * @type {import("esbuild").BuildOptions}
 */
export const commonOpts = {
    logLevel: "info",
    bundle: true,
    minify: !watch && !IS_REPORTER,
    sourcemap: watch ? "inline" : "external",
    legalComments: "linked",
    banner,
    plugins: [fileUrlPlugin, gitHashPlugin, gitRemotePlugin, stylePlugin],
    external: ["~plugins", "~git-hash", "~git-remote", "/assets/*"],
    inject: [join(dirname(fileURLToPath(import.meta.url)), "inject/react.mjs")],
    jsx: "transform",
    jsxFactory: "VencordCreateElement",
    jsxFragment: "VencordFragment"
};

export const userPluginModules = {
    name: "userplugin-modules",
    setup(build) {
        build.onResolve({ filter: /^~userplugin-modules$/ }, () => ({ path: "modules", namespace: "userplugin-modules" }));
        build.onLoad({ filter: /.*/, namespace: "userplugin-modules" }, async () => {
            const source = await readFile("src/shared/userPluginModules.ts", "utf-8");
            const list = source.match(/USER_PLUGIN_HOST_MODULES\s*=\s*\[([\s\S]*?)\] as const/);
            if (!list) throw new Error("User plugin host modules are missing.");
            const names = [...list[1].matchAll(/"([^"\n]+)"/g)].map(match => match[1]);
            const imports = names.map((name, index) => `import * as m${index} from ${JSON.stringify(name)};`).join("\n");
            const entries = names.map((name, index) => `${JSON.stringify(name)}:facade(m${index})`).join(",");
            return {
                contents: `${imports}\nconst facade = module => Object.defineProperties({ __esModule: true }, Object.fromEntries(Object.keys(module).filter(key => key !== "__esModule").map(key => [key, { enumerable: true, get: () => module[key] }])));\nexport default {${entries}};`,
                loader: "js",
                resolveDir: process.cwd()
            };
        });
    }
};

export const acornLicense = {
    name: "acorn-license",
    setup(build) {
        build.onLoad({ filter: /[\\/]acorn[\\/]dist[\\/]acorn\.(?:m)?js$/ }, async args => {
            const licensePath = join(dirname(args.path), "../LICENSE");
            const [source, license] = await Promise.all([readFile(args.path, "utf-8"), readFile(licensePath, "utf-8")]);
            return { contents: `/*! Acorn\n${license}\n*/\n${source}`, loader: "js", resolveDir: dirname(args.path), watchFiles: [args.path, licensePath] };
        });
    }
};

export const commonRendererPlugins = [
    acornLicense,
    userPluginModules,
    banImportPlugin(/^react$/, "Cannot import from react. React and hooks should be imported from @webpack/common"),
    banImportPlugin(/^electron(\/.*)?$/, "Cannot import electron in browser code. You need to use a native.ts file"),
    banImportPlugin(/^ts-pattern$/, "Cannot import from ts-pattern. match and P should be imported from @webpack/common"),
    // @ts-expect-error this is never undefined
    ...commonOpts.plugins
];
