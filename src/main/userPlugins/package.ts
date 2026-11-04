/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BetterDiscordLibraryId, BetterDiscordMetadata, BetterDiscordReport, USER_PLUGIN_MANIFEST, UserPluginAuthor, UserPluginAuthorRegistries, UserPluginCandidate, UserPluginManifest } from "@shared/userPlugins";
import { posix } from "path";
import ts from "typescript";

export type PluginFiles = Record<string, Uint8Array>;
export const PACKAGE_LIMITS = { files: 2000, total: 50 * 1024 * 1024, file: 10 * 1024 * 1024 } as const;
const sourceExtension = /\.[jt]sx?$/i;
const reservedNames = new Set(["__proto__", "prototype", "constructor"]);
const emptyRegistries: UserPluginAuthorRegistries = { Devs: {}, EquicordDevs: {}, NoyucordDevs: {} };
const betterDiscordLibraries: Record<BetterDiscordLibraryId, string> = { zeres: "ZeresPluginLibrary", bdfdb: "BDFDB" };
const betterDiscordNativeModules = new Set(["fs", "path", "process", "request", "electron"]);
const betterDiscordReactModules = new Set(["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"]);

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, limit: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value);
}

function runtimeMetadata(value: Record<string, unknown>): Pick<UserPluginManifest, "runtime" | "betterDiscord"> {
    if (value.runtime !== undefined && value.runtime !== "noyucord" && value.runtime !== "betterdiscord") throw new Error("The plugin manifest runtime is unsupported.");
    if (value.betterDiscord === undefined) return value.runtime === undefined ? {} : { runtime: value.runtime };
    const metadata = value.betterDiscord;
    if (value.runtime !== "betterdiscord" || !record(metadata) || !record(metadata.metadata) || Object.keys(metadata.metadata).length > 64)
        throw new Error("The plugin manifest BetterDiscord metadata must belong to a BetterDiscord plugin.");
    const header: Record<string, string> = Object.create(null);
    for (const [key, text] of Object.entries(metadata.metadata)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || typeof text !== "string" || text.length > 2048 || /[\u0000-\u001f]/.test(text))
            throw new Error("The plugin manifest BetterDiscord header fields must contain bounded text.");
        header[key] = text;
    }
    if (!Array.isArray(metadata.libraries) || metadata.libraries.length > 2 || !metadata.libraries.every((library: unknown): library is BetterDiscordLibraryId => library === "zeres" || library === "bdfdb") || typeof metadata.requiresNative !== "boolean")
        throw new Error("The plugin manifest BetterDiscord libraries and native access must be valid.");
    if (metadata.provider !== undefined && metadata.provider !== "zeres" && metadata.provider !== "bdfdb") throw new Error("The plugin manifest BetterDiscord library provider is unsupported.");
    if (metadata.provider !== undefined && (value.name !== betterDiscordLibraries[metadata.provider] || header.name !== value.name)) throw new Error("The plugin manifest BetterDiscord provider must match its original library name.");
    return {
        runtime: "betterdiscord",
        betterDiscord: {
            metadata: header, libraries: [...new Set<BetterDiscordLibraryId>(metadata.libraries)], requiresNative: metadata.requiresNative,
            ...(metadata.provider === undefined ? {} : { provider: metadata.provider })
        }
    };
}

export function validatePackagePath(path: string) {
    if (!boundedString(path, 512) || path.includes("\\") || path.startsWith("/") || path.includes(":") || path.split("/").some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
        throw new Error("The package contains an unsafe file path.");
    return path;
}

export function validatePackageFiles(files: PluginFiles) {
    const entries = Object.entries(files);
    if (!entries.length || entries.length > PACKAGE_LIMITS.files) throw new Error("The package must contain between 1 and 2000 files.");
    let size = 0;
    const seen = new Set<string>();
    for (const [path, bytes] of entries) {
        validatePackagePath(path);
        const lower = path.toLowerCase();
        if (seen.has(lower)) throw new Error("The package contains conflicting file paths.");
        seen.add(lower);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > PACKAGE_LIMITS.file) throw new Error("A package file exceeds the 10 MiB limit.");
        size += bytes.byteLength;
    }
    if (size > PACKAGE_LIMITS.total) throw new Error("The package exceeds the 50 MiB limit.");
    return files;
}

export function validateManifest(value: unknown): UserPluginManifest {
    if (!record(value) || value.schemaVersion !== 1 || value.apiVersion !== 1) throw new Error("This plugin requires an unsupported manifest or API version.");
    const id = typeof value.id === "string" ? value.id.toLowerCase() : value.id;
    if (!boundedString(id, 100) || !/^[a-z0-9][a-z0-9._-]*$/.test(id) || reservedNames.has(id) || /^(?:noyucord|vencord|equicord)(?:[._-]|$)/.test(id))
        throw new Error("Use a unique plugin ID with lowercase letters, numbers, dots, underscores, or hyphens, outside reserved product namespaces.");
    validatePackagePath(id);
    if (!boundedString(value.name, 100) || reservedNames.has(value.name)) throw new Error("Enter a plugin name of at most 100 characters.");
    if (!boundedString(value.version, 64)) throw new Error("Enter a plugin version of at most 64 characters.");
    if (!boundedString(value.description, 1000)) throw new Error("Enter a plugin description of at most 1000 characters.");
    if (!Array.isArray(value.authors) || !value.authors.length || value.authors.length > 50) throw new Error("Enter at least one plugin author.");
    const authors = value.authors.map(author => {
        if (!record(author) || !boundedString(author.name, 100) || (author.id !== undefined && (typeof author.id !== "string" || !/^\d{1,20}$/.test(author.id))))
            throw new Error("Each author needs a name and, optionally, a numeric Discord user ID.");
        return { name: author.name, ...(typeof author.id === "string" ? { id: author.id } : {}) };
    });
    if (typeof value.entry !== "string" || !sourceExtension.test(value.entry)) throw new Error("Select a JavaScript or TypeScript plugin entry file.");
    validatePackagePath(value.entry);
    if (value.native !== undefined) {
        if (typeof value.native !== "string" || !sourceExtension.test(value.native)) throw new Error("Select a JavaScript or TypeScript native helper entry file.");
        validatePackagePath(value.native);
        if (value.native === value.entry) throw new Error("The renderer and native helper must use different entry files.");
    }
    if (value.format !== "source" && value.format !== "prebuilt") throw new Error("Select source or prebuilt package format.");
    if (value.format === "prebuilt" && !/\.jsx?$/i.test(value.entry)) throw new Error("Prebuilt plugins must use a JavaScript entry file.");
    if (value.target !== "desktop" && value.target !== "discordDesktop" && value.target !== "equibop") throw new Error("Select a supported desktop plugin target.");
    if (!Array.isArray(value.dependencies) || value.dependencies.length > 100 || !value.dependencies.every(d => boundedString(d, 100) && !reservedNames.has(d)))
        throw new Error("Plugin dependencies must be a list of plugin names.");
    if (value.dependencies.includes(value.name)) throw new Error("A plugin cannot depend on itself.");
    const runtime = runtimeMetadata(value);
    if (runtime.runtime === "betterdiscord" && (!runtime.betterDiscord || value.format !== "prebuilt" || value.native !== undefined)) throw new Error("BetterDiscord plugins need compatibility metadata and a prebuilt renderer entry, without a native helper.");
    const dependencies = [...new Set([...value.dependencies, ...(runtime.betterDiscord?.libraries.map(library => betterDiscordLibraries[library]) ?? [])])];
    if (dependencies.includes(value.name)) throw new Error("A plugin cannot depend on itself.");
    return {
        schemaVersion: 1, apiVersion: 1, id, name: value.name, version: value.version,
        description: value.description, authors, entry: value.entry, ...(typeof value.native === "string" ? { native: value.native } : {}), format: value.format,
        target: value.target, dependencies, ...runtime
    };
}

function property(object: ts.ObjectLiteralExpression, name: string) {
    const entry = object.properties.find(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
    return entry && ts.isPropertyAssignment(entry) ? entry.initializer : undefined;
}

function literal(node: ts.Node | undefined): string | undefined {
    return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function pluginDefinition(source: ts.SourceFile) {
    let definition: ts.ObjectLiteralExpression | undefined;
    for (const statement of source.statements) {
        const exported = ts.isExportAssignment(statement) ? statement.expression
            : ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && statement.expression.left.getText(source) === "module.exports"
                ? statement.expression.right : undefined;
        if (!exported) continue;
        const object = ts.isCallExpression(exported) && exported.arguments.length && ts.isIdentifier(exported.expression) && exported.expression.text === "definePlugin" ? exported.arguments[0] : exported;
        if (ts.isObjectLiteralExpression(object)) definition = object;
    }
    return definition;
}

function sourceAuthors(source: ts.SourceFile, node: ts.Expression | undefined, registries: UserPluginAuthorRegistries, warnings: string[]): UserPluginAuthor[] {
    const bindings = new Map<string, keyof UserPluginAuthorRegistries>();
    const namespaces = new Set<string>();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@utils/constants" || statement.importClause?.isTypeOnly) continue;
        const imports = statement.importClause?.namedBindings;
        if (imports && ts.isNamespaceImport(imports)) namespaces.add(imports.name.text);
        if (!imports || !ts.isNamedImports(imports)) continue;
        for (const entry of imports.elements) {
            const name = (entry.propertyName ?? entry.name).text;
            if (!entry.isTypeOnly && Object.hasOwn(registries, name)) bindings.set(entry.name.text, name as keyof UserPluginAuthorRegistries);
        }
    }
    if (!node || !ts.isArrayLiteralExpression(node)) return [];
    return node.elements.flatMap(author => {
        if (ts.isObjectLiteralExpression(author)) {
            const name = literal(property(author, "name"));
            const idNode = property(author, "id");
            const id = idNode && ts.isBigIntLiteral(idNode) ? idNode.text.replace(/n$/, "") : literal(idNode);
            return name ? [{ name, ...(id ? { id } : {}) }] : [];
        }
        const key = ts.isPropertyAccessExpression(author) ? author.name.text
            : ts.isElementAccessExpression(author) ? literal(author.argumentExpression) : undefined;
        const owner = ts.isPropertyAccessExpression(author) || ts.isElementAccessExpression(author) ? author.expression : undefined;
        const registry = owner && ts.isIdentifier(owner) ? bindings.get(owner.text)
            : owner && ts.isPropertyAccessExpression(owner) && ts.isIdentifier(owner.expression) && namespaces.has(owner.expression.text) && Object.hasOwn(registries, owner.name.text)
                ? owner.name.text as keyof UserPluginAuthorRegistries : undefined;
        if (!registry || !key) {
            warnings.push(`The author expression ${author.getText(source).slice(0, 100)} could not be read without running code. Enter its original author below.`);
            return [];
        }
        if (Object.hasOwn(registries[registry], key)) return [{ ...registries[registry][key] }];
        warnings.push(`This build has no ${registry}.${key} contributor record. The source handle is used without a Discord ID. You can correct its name and ID below.`);
        return [{ name: key }];
    });
}

function betterDiscordHeader(path: string, text: string, warnings: string[]): Record<string, string> | null {
    if (!/\.jsx?$/i.test(path)) return null;
    const header: Record<string, string> = Object.create(null);
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
    let headerSize = 0;
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
        if (token !== ts.SyntaxKind.MultiLineCommentTrivia) {
            if ([ts.SyntaxKind.WhitespaceTrivia, ts.SyntaxKind.NewLineTrivia, ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.ShebangTrivia].includes(token)) continue;
            break;
        }
        const comment = scanner.getTokenText();
        if (!comment.startsWith("/**")) continue;
        headerSize += comment.length;
        if (headerSize > 32 * 1024) throw new Error("The BetterDiscord metadata header exceeds 32 KiB.");
        if (!/@(?:name|author|description|version)\b/.test(comment)) continue;
        let key: string | undefined;
        for (const line of comment.slice(3, -2).split(/\r?\n/)) {
            const text = line.replace(/^\s*\*?\s?/, "").trim();
            const tag = /^@([A-Za-z][A-Za-z0-9_-]{0,63})(?:\s+(.*))?$/.exec(text);
            if (tag) {
                key = tag[1];
                header[key] = (tag[2] ?? "").trim();
            } else if (key && text) header[key] += " " + text;
        }
    }
    if (!/\.plugin\.js$/i.test(path) && !(Object.hasOwn(header, "name") && Object.hasOwn(header, "author"))) return null;
    if (Object.keys(header).length > 64 || Object.entries(header).some(([key, value]) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || value.length > 2048 || /[\u0000-\u001f]/.test(value)))
        throw new Error("The BetterDiscord metadata header has too many fields or an invalid field.");
    for (const key of ["name", "author", "description", "version"]) {
        if (!header[key]) warnings.push(`The BetterDiscord header is missing @${key}. Enter it below before installing.`);
    }
    return header;
}

export function inspectBetterDiscordCompatibility(path: string, bytes: Uint8Array): BetterDiscordReport {
    const source = ts.createSourceFile(path, new TextDecoder().decode(bytes), ts.ScriptTarget.Latest, true);
    const scopes = new Map<ts.Node, Set<string>>();
    const aliases = new Map<Set<string>, Map<string, string[]>>();
    function bind(name: ts.BindingName, names: Set<string>) {
        if (ts.isIdentifier(name)) names.add(name.text);
        else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name, names);
    }
    function collect(node: ts.Node, scope: Set<string>) {
        if (ts.isFunctionDeclaration(node) && node.name) scope.add(node.name.text);
        if (ts.isClassDeclaration(node) && node.name) scope.add(node.name.text);
        if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node) || ts.isCatchClause(node)) {
            scope = new Set<string>();
            scopes.set(node, scope);
            if (ts.isFunctionLike(node)) for (const parameter of node.parameters) bind(parameter.name, scope);
        }
        if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bind(node.name, scope);
        if (ts.isImportClause(node) && node.name) scope.add(node.name.text);
        if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) scope.add(node.name.text);
        ts.forEachChild(node, child => collect(child, scope));
    }
    collect(source, new Set());
    function access(node: ts.Expression): string[] | undefined {
        if (ts.isParenthesizedExpression(node)) return access(node.expression);
        if (ts.isIdentifier(node)) {
            for (let owner: ts.Node | undefined = node; owner; owner = owner.parent) {
                const scope = scopes.get(owner);
                if (scope?.has(node.text)) return aliases.get(scope)?.get(node.text);
            }
            return [node.text];
        }
        if (ts.isPropertyAccessExpression(node)) {
            const owner = access(node.expression);
            return owner && [...owner, node.name.text];
        }
        if (ts.isElementAccessExpression(node)) {
            const owner = access(node.expression);
            const name = literal(node.argumentExpression);
            return owner && name ? [...owner, name] : undefined;
        }
    }
    function globalNames(reference: string[] | undefined) {
        return reference && ["window", "global", "globalThis", "self"].includes(reference[0]) ? reference.slice(1) : reference;
    }
    function collectAliases(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.initializer) {
            const reference = globalNames(access(ts.isNewExpression(node.initializer) ? node.initializer.expression : node.initializer));
            if (reference && ["BdApi", "ZLibrary", "ZeresPluginLibrary", "BDFDB_Global"].includes(reference[0])) {
                let owner: ts.Node | undefined = node.parent;
                while (owner && !scopes.has(owner)) owner = owner.parent;
                const scope = owner && scopes.get(owner);
                if (scope) {
                    const bindings = aliases.get(scope) ?? new Map<string, string[]>();
                    aliases.set(scope, bindings);
                    function bindAlias(name: ts.BindingName, path: string[]) {
                        if (ts.isIdentifier(name)) bindings.set(name.text, path);
                        else if (ts.isObjectBindingPattern(name)) {
                            for (const entry of name.elements) {
                                const key = entry.propertyName && (ts.isIdentifier(entry.propertyName) || ts.isStringLiteral(entry.propertyName)) ? entry.propertyName.text : ts.isIdentifier(entry.name) ? entry.name.text : undefined;
                                if (key && !entry.dotDotDotToken) bindAlias(entry.name, [...path, key]);
                            }
                        }
                    }
                    bindAlias(node.name, reference);
                }
            }
        }
        ts.forEachChild(node, collectAliases);
    }
    collectAliases(source);
    const libraries = new Set<BetterDiscordLibraryId>();
    const nativeModules = new Set<string>();
    const unsupported = new Set<string>();
    let unknownRequires = false;
    function inspectImport(name: string) {
        if (name.startsWith(".") || betterDiscordReactModules.has(name)) return;
        nativeModules.add(name);
        if (!betterDiscordNativeModules.has(name)) unsupported.add(name);
    }
    function visit(node: ts.Node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) inspectImport(node.moduleSpecifier.text);
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
            const names = globalNames(access(node));
            if (names?.[0] === "process" && names.length > 1) nativeModules.add("process");
        }
        if (ts.isCallExpression(node)) {
            const reference = access(node.expression);
            if (reference?.length === 1 && reference[0] === "require") {
                const name = node.arguments.length === 1 ? literal(node.arguments[0]) : undefined;
                if (name === undefined) unknownRequires = true;
                else inspectImport(name);
            }
            const names = globalNames(reference);
            if (names && names.length > 1 && names[names.length - 1] === "buildPlugin") {
                if (names[0] === "ZeresPluginLibrary" || names[0] === "ZLibrary") libraries.add("zeres");
                if (names[0] === "BDFDB_Global") libraries.add("bdfdb");
            }
            if (names?.[0] === "process" && names.length > 1) nativeModules.add("process");
            if (names?.join(".") === "fetch" || names?.join(".") === "BdApi.Net.fetch") nativeModules.add("request");
            if (["BdApi.openLink", "BdApi.Native.openLink", "BdApi.Native.clipboard.readText", "BdApi.Native.clipboard.writeText"].includes(names?.join(".") ?? "")) nativeModules.add("electron");
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    const warnings: string[] = [];
    if (unsupported.size) warnings.push(`Unsupported BetterDiscord imports: ${[...unsupported].sort().join(", ")}. This compatibility layer does not provide arbitrary Node modules or npm packages.`);
    if (unknownRequires) warnings.push("Computed require calls cannot be fully checked during import. Only the approved compatibility modules will be available when this plugin runs.");
    return { libraries: [...libraries].sort(), nativeModules: [...nativeModules].sort(), unknownRequires, warnings };
}

function inspectBetterDiscordPackage(files: PluginFiles, entry: string): BetterDiscordReport {
    const pending = [entry];
    const visited = new Set<string>();
    const libraries = new Set<BetterDiscordLibraryId>();
    const nativeModules = new Set<string>();
    const warnings = new Set<string>();
    let unknownRequires = false;
    while (pending.length) {
        const path = pending.pop();
        if (!path || visited.has(path) || !Object.hasOwn(files, path)) continue;
        visited.add(path);
        const report = inspectBetterDiscordCompatibility(path, files[path]);
        for (const library of report.libraries) libraries.add(library);
        for (const module of report.nativeModules) nativeModules.add(module);
        for (const warning of report.warnings) warnings.add(warning);
        unknownRequires ||= report.unknownRequires;
        const source = ts.createSourceFile(path, new TextDecoder().decode(files[path]), ts.ScriptTarget.Latest, true);
        const directory = posix.dirname(path);
        function visit(node: ts.Node) {
            const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? literal(node.moduleSpecifier)
                : ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1 ? literal(node.arguments[0]) : undefined;
            if (specifier?.startsWith(".")) {
                const local = posix.normalize(posix.join(directory, specifier));
                const found = [local, ...[".js", ".jsx", ".ts", ".tsx"].map(extension => local + extension), ...["index.js", "index.jsx", "index.ts", "index.tsx"].map(index => local + "/" + index)].find(file => Object.hasOwn(files, file));
                if (found && sourceExtension.test(found)) pending.push(found);
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
    }
    return { libraries: [...libraries].sort(), nativeModules: [...nativeModules].sort(), unknownRequires, warnings: [...warnings] };
}

function extractBetterDiscordMetadata(path: string, bytes: Uint8Array, warnings: string[]): Partial<UserPluginManifest> | null {
    const metadata = betterDiscordHeader(path, new TextDecoder().decode(bytes), warnings);
    if (!metadata) return null;
    const report = inspectBetterDiscordCompatibility(path, bytes);
    const provider = Object.entries(betterDiscordLibraries).find(([, name]) => metadata.name === name)?.[0] as BetterDiscordLibraryId | undefined;
    const libraries = report.libraries.filter(library => library !== provider);
    const authorId = /^\d{1,20}$/.test(metadata.authorId) ? metadata.authorId : undefined;
    if (metadata.authorId && !authorId) warnings.push("The BetterDiscord @authorId is not a Discord user ID. Its author name is kept without an ID.");
    const betterDiscord: BetterDiscordMetadata = {
        metadata, libraries, requiresNative: report.nativeModules.length > 0 || report.unknownRequires, ...(provider ? { provider } : {})
    };
    return {
        schemaVersion: 1, apiVersion: 1, runtime: "betterdiscord", betterDiscord,
        ...(metadata.name ? { name: metadata.name, id: metadata.name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9._-]+/g, "-") } : {}),
        version: metadata.version || undefined, description: metadata.description || undefined,
        authors: metadata.author ? [{ name: metadata.author, ...(authorId ? { id: authorId } : {}) }] : [],
        dependencies: libraries.map(library => betterDiscordLibraries[library]), format: "prebuilt", target: "desktop"
    };
}

export function extractMetadata(path: string, bytes: Uint8Array, registries: UserPluginAuthorRegistries = emptyRegistries, warnings: string[] = []): Partial<UserPluginManifest> | null {
    const betterDiscord = extractBetterDiscordMetadata(path, bytes, warnings);
    if (betterDiscord) return betterDiscord;
    const source = ts.createSourceFile(path, new TextDecoder().decode(bytes), ts.ScriptTarget.Latest, true);
    const definition = pluginDefinition(source);
    if (!definition) return null;
    const name = literal(property(definition, "name"));
    const authors = sourceAuthors(source, property(definition, "authors"), registries, warnings);
    const dependenciesNode = property(definition, "dependencies");
    const dependencies = dependenciesNode && ts.isArrayLiteralExpression(dependenciesNode)
        ? dependenciesNode.elements.map(literal).filter((v): v is string => v !== undefined) : [];
    return {
        schemaVersion: 1, apiVersion: 1, ...(name ? { name, id: name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9._-]+/g, "-") } : {}),
        version: literal(property(definition, "version")) ?? "0.0.0",
        description: literal(property(definition, "description")), authors, dependencies,
        format: /\.tsx?$/i.test(path) ? "source" : "prebuilt", target: "desktop"
    };
}

export function prepareRendererSource(path: string, bytes: Uint8Array, manifest: UserPluginManifest) {
    const text = new TextDecoder().decode(bytes);
    if (path !== manifest.entry || manifest.runtime === "betterdiscord") return text;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const definition = pluginDefinition(source);
    if (!definition) return text;
    const authors = property(definition, "authors");
    const original = authors && ts.isArrayLiteralExpression(authors) && authors.elements.length === manifest.authors.length ? authors.elements : undefined;
    const replacement = `[${manifest.authors.map((author, index) => {
        const entry = original?.[index];
        const extra = entry && (ts.isObjectLiteralExpression(entry) || ts.isPropertyAccessExpression(entry) || ts.isElementAccessExpression(entry)) ? `...(${entry.getText(source)}),` : "";
        return `{${extra}name:${JSON.stringify(author.name)},id:${BigInt(author.id ?? "0")}n}`;
    }).join(",")}]`;
    if (authors) return text.slice(0, authors.getStart(source)) + replacement + text.slice(authors.end);
    const shorthand = definition.properties.find(entry => entry.name && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === "authors");
    if (shorthand) return text.slice(0, shorthand.getStart(source)) + "authors:" + replacement + text.slice(shorthand.end);
    const start = definition.getStart(source) + 1;
    return text.slice(0, start) + "authors:" + replacement + "," + text.slice(start);
}

function parseManifest(bytes: Uint8Array): unknown {
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new Error("The plugin manifest is not valid JSON.");
    }
}

function previewManifest(value: unknown): Partial<UserPluginManifest> {
    if (!record(value)) throw new Error("The plugin manifest must be an object.");
    const preview: Partial<UserPluginManifest> = {};
    for (const field of ["id", "name", "version", "description", "entry", "native"] as const) {
        if (value[field] === undefined) continue;
        if (typeof value[field] !== "string" || value[field].length > (field === "description" ? 1000 : 512)) throw new Error(`The plugin manifest ${field} must be text.`);
        preview[field] = field === "id" ? value[field].toLowerCase() : value[field];
    }
    for (const field of ["schemaVersion", "apiVersion"] as const) {
        if (value[field] === undefined) continue;
        if (value[field] !== 1) throw new Error(`The plugin manifest ${field} is unsupported.`);
        preview[field] = 1;
    }
    if (value.format !== undefined) {
        if (value.format !== "source" && value.format !== "prebuilt") throw new Error("The plugin manifest format must be source or prebuilt.");
        preview.format = value.format;
    }
    if (value.target !== undefined) {
        if (value.target !== "desktop" && value.target !== "discordDesktop" && value.target !== "equibop") throw new Error("The plugin manifest target must be a supported desktop target.");
        preview.target = value.target;
    }
    if (value.authors !== undefined) {
        if (!Array.isArray(value.authors) || value.authors.length > 50) throw new Error("The plugin manifest authors must be an array of author objects.");
        preview.authors = value.authors.map(author => {
            if (!record(author) || !boundedString(author.name, 100) || (author.id !== undefined && (typeof author.id !== "string" || !/^\d{1,20}$/.test(author.id)))) throw new Error("The plugin manifest authors need text names and optional numeric Discord IDs.");
            return { name: author.name, ...(typeof author.id === "string" ? { id: author.id } : {}) };
        });
    }
    if (value.dependencies !== undefined) {
        if (!Array.isArray(value.dependencies) || value.dependencies.length > 100 || !value.dependencies.every(name => boundedString(name, 100))) throw new Error("The plugin manifest dependencies must be an array of plugin names.");
        preview.dependencies = [...value.dependencies];
    }
    Object.assign(preview, runtimeMetadata(value));
    return preview;
}

function inspectNative(files: PluginFiles, candidate: UserPluginCandidate) {
    const root = posix.dirname(candidate.key);
    const prefix = root === "." ? "" : root + "/";
    if (candidate.manifest.runtime === "betterdiscord") {
        const entry = candidate.manifest.entry && prefix + candidate.manifest.entry;
        if (!entry || !Object.hasOwn(files, entry)) return;
        const compatibility = inspectBetterDiscordPackage(files, entry);
        const provider = candidate.manifest.betterDiscord?.provider;
        compatibility.libraries = [...new Set([...compatibility.libraries, ...(candidate.manifest.betterDiscord?.libraries ?? [])])].filter(library => library !== provider);
        candidate.compatibility = compatibility;
        candidate.warnings = [...new Set([...(candidate.warnings ?? []), ...compatibility.warnings])];
        if (candidate.manifest.betterDiscord) {
            candidate.manifest.betterDiscord.libraries = compatibility.libraries;
            candidate.manifest.betterDiscord.requiresNative ||= compatibility.nativeModules.length > 0 || compatibility.unknownRequires;
            candidate.manifest.dependencies = [...new Set([...(candidate.manifest.dependencies ?? []), ...compatibility.libraries.map(library => betterDiscordLibraries[library])])];
        }
        return;
    }
    if (candidate.manifest.native) return;
    const entries = Object.keys(files).filter(path => path.startsWith(prefix) && /^native(?:\/index)?\.[jt]sx?$/i.test(path.slice(prefix.length)));
    if (entries.length === 1) candidate.manifest.native = entries[0].slice(prefix.length);
    else if (entries.length > 1) candidate.error = "The package has multiple native helper entries. Declare the native entry in its manifest.";
}

export function inspectPackage(files: PluginFiles, registries: UserPluginAuthorRegistries = emptyRegistries): UserPluginCandidate[] {
    validatePackageFiles(files);
    const manifests = Object.keys(files).filter(path => posix.basename(path) === USER_PLUGIN_MANIFEST).sort();
    const candidates: UserPluginCandidate[] = manifests.map(key => {
        const parsed = previewManifest(parseManifest(files[key]));
        const warnings: string[] = [];
        const entry = parsed.entry && posix.join(posix.dirname(key), parsed.entry);
        const metadata = entry && Object.hasOwn(files, entry) ? extractMetadata(entry, files[entry], registries, warnings) : null;
        return { key, label: parsed.name ?? key, manifest: { ...(metadata?.runtime === "betterdiscord" || metadata?.authors?.length ? metadata : {}), ...parsed }, warnings };
    });
    for (const [path, bytes] of Object.entries(files)) {
        if (!sourceExtension.test(path) || manifests.some(m => path.startsWith(posix.dirname(m) === "." ? "" : posix.dirname(m) + "/"))) continue;
        const warnings: string[] = [];
        const metadata = extractMetadata(path, bytes, registries, warnings);
        if (!metadata) continue;
        candidates.push({ key: path, label: metadata.name ?? path, manifest: { ...metadata, entry: posix.basename(path) }, warnings });
    }
    if (!candidates.length && Object.keys(files).filter(path => sourceExtension.test(path)).length === 1) {
        const key = Object.keys(files).find(path => sourceExtension.test(path));
        if (key) candidates.push({ key, label: key, manifest: { schemaVersion: 1, apiVersion: 1, entry: posix.basename(key), format: "source", target: "desktop", dependencies: [], version: "0.0.0" } });
    }
    for (const candidate of candidates) inspectNative(files, candidate);
    return candidates;
}

export function preparePackage(files: PluginFiles, candidateKey: string, input: unknown) {
    validatePackageFiles(files);
    if (!Object.hasOwn(files, candidateKey)) throw new Error("The selected plugin is no longer available.");
    let manifest = validateManifest(input);
    const root = posix.dirname(candidateKey);
    const prefix = root === "." ? "" : root + "/";
    const selected: PluginFiles = Object.create(null);
    for (const [path, bytes] of Object.entries(files)) {
        if (!path.startsWith(prefix)) continue;
        const local = path.slice(prefix.length);
        if (/(^|\/)(?:node_modules|\.git)(?:\/|$)/.test(local)) throw new Error("Remove repository metadata and dependencies from the plugin package.");
        if (posix.basename(local) === "package.json") {
            const pkg = parseManifest(bytes);
            if (record(pkg) && (pkg.scripts !== undefined || pkg.dependencies !== undefined || pkg.optionalDependencies !== undefined)) throw new Error("Plugin packages cannot install dependencies or run package scripts. Bundle dependencies before distributing the plugin.");
        }
        selected[local] = bytes;
    }
    if (!Object.hasOwn(selected, manifest.entry)) throw new Error("The selected entry file is missing from this plugin package.");
    if (manifest.native && !Object.hasOwn(selected, manifest.native)) throw new Error("The selected native helper entry file is missing from this plugin package.");
    const nativeEntries = Object.keys(selected).filter(path => /^native(?:\/index)?\.[jt]sx?$/i.test(path));
    if (manifest.runtime !== "betterdiscord" && !manifest.native && nativeEntries.length) throw new Error("The package includes a native helper. Inspect it again to review native access before installation.");
    if (manifest.runtime === "betterdiscord" && manifest.betterDiscord) {
        const compatibility = inspectBetterDiscordPackage(selected, manifest.entry);
        const original = extractBetterDiscordMetadata(manifest.entry, selected[manifest.entry], [])?.betterDiscord;
        const provider = original?.provider;
        const libraries = [...new Set([...manifest.betterDiscord.libraries, ...compatibility.libraries])].filter(library => library !== provider);
        manifest = validateManifest({
            ...manifest,
            betterDiscord: {
                metadata: original?.metadata ?? manifest.betterDiscord.metadata, libraries,
                requiresNative: manifest.betterDiscord.requiresNative || compatibility.nativeModules.length > 0 || compatibility.unknownRequires,
                ...(provider ? { provider } : {})
            }
        });
    }
    const manifestRoot = selected[USER_PLUGIN_MANIFEST];
    if (manifestRoot) {
        const original = parseManifest(manifestRoot);
        if (record(original) && original.id !== undefined && (typeof original.id !== "string" || original.id.toLowerCase() !== manifest.id)) throw new Error("The plugin ID cannot differ from its package manifest.");
    }
    return { files: validatePackageFiles(selected), manifest };
}
