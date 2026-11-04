/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { DATA_DIR } from "@main/utils/constants";
import { BetterDiscordOperation, BetterDiscordRequest, USER_PLUGIN_API_VERSION, USER_PLUGIN_COMPILER_VERSION, UserPluginCandidate, UserPluginInspection, UserPluginManifest, UserPluginResult, UserPluginSource, UserPluginStartup, UserPluginStatus } from "@shared/userPlugins";
import { randomUUID } from "crypto";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { join } from "path";

import authorRegistries from "~userplugin-authors";

import { createBetterDiscordBridge } from "./betterDiscord";
import { compileNativePackage, compilePackage } from "./compiler";
import { readLocalPackage } from "./files";
import { assertNotLibraryProvider, fetchLibrary, requiredLibraries } from "./libraries";
import { createUserPluginNativeRuntime } from "./native";
import { inspectPackage, PluginFiles, preparePackage, validateManifest } from "./package";
import { fetchRemotePackage, fetchRemoteRevision, ReleaseAsset, releaseAssets, RemoteError } from "./sources";
import { createUserPluginStore, PreparedUserPlugin, sourceRevision, validId } from "./store";

interface Inspection {
    files?: PluginFiles;
    assets?: ReleaseAsset[];
    candidates: UserPluginCandidate[];
    source: UserPluginSource;
    revision: string;
    created: number;
    sender: number;
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function message(error: unknown) {
    if (!(error instanceof Error)) return "The user-plugin operation failed.";
    return /^(The |This |Enter |Use |Select |Required |Enable |Disable |Restart |Plugin |BetterDiscord |A |An |Only |Unable |Each |Dynamic |Computed |Package |Unsupported |CSS |Native |Remove |Build failed)/.test(error.message)
        ? error.message.slice(0, 1000) : "The user-plugin operation failed. Check the package and try again.";
}

function registerUnavailableUserPlugins(error: string) {
    for (const method of ["inspect", "install", "setEnabled", "remove", "checkUpdates", "update", "rollback", "recover", "openFolder", "betterDiscordRequest"])
        ipcMain.handle(`NoyucordUserPlugins:${method}`, () => ({ ok: false, error }));
    ipcMain.handle("NoyucordUserPlugins:list", () => ({
        ok: true, value: { plugins: [], recovery: true, disabled: true, lastChecked: 0, error }
    }));
    ipcMain.on("NoyucordUserPlugins:startup", event => {
        event.returnValue = { plugins: [], recovery: true, disabled: true, errors: [{ id: "startup", message: error }] };
    });
    for (const method of ["markStartup", "reportFailure", "completeStartup"])
        ipcMain.on(`NoyucordUserPlugins:${method}`, event => { event.returnValue = null; });
    ipcMain.on("NoyucordUserPlugins:nativeMethods", event => { event.returnValue = {}; });
    ipcMain.handle("NoyucordUserPlugins:invokeNative", () => { throw new Error(error); });
    ipcMain.handle("NoyucordUserPlugins:flushBetterDiscordData", () => ({ ok: true, value: undefined }));
    for (const method of ["betterDiscordSnapshot", "betterDiscordOperation"])
        ipcMain.on(`NoyucordUserPlugins:${method}`, event => { event.returnValue = { ok: false, error }; });
}

export function registerUserPluginIpc(bundledNames: string[]) {
    const directory = join(DATA_DIR, "userplugins");
    let store: ReturnType<typeof createUserPluginStore>;
    try {
        store = createUserPluginStore(directory, bundledNames, process.argv.includes("--noyucord-disable-userplugins"), name => {
            if (RendererSettings.store.plugins) delete RendererSettings.store.plugins[name];
        }, {
            target: IS_DISCORD_DESKTOP ? "discordDesktop" : "equibop",
            apiVersion: USER_PLUGIN_API_VERSION,
            compilerVersion: USER_PLUGIN_COMPILER_VERSION
        });
    } catch (error) {
        registerUnavailableUserPlugins(`User plugins could not be initialized. ${message(error)} Check the existing userplugins folder before restarting.`);
        return;
    }
    const inspections = new Map<string, Inspection>();
    const nativeRuntime = createUserPluginNativeRuntime(bundledNames, { markStartup: store.markStartup, reportFailure: store.reportFailure });
    const betterDiscord = createBetterDiscordBridge(directory, store, { clipboard, openExternal: url => shell.openExternal(url) });
    app.on("before-quit", () => { void betterDiscord.flush().catch(error => console.error("Noyucord could not save BetterDiscord plugin data", error)); });
    let startupFailure: UserPluginStartup | undefined;
    function startup(): UserPluginStartup {
        if (startupFailure) return startupFailure;
        try {
            const result = store.startup();
            nativeRuntime.initialize(store.nativeStartup(), result);
            return result;
        } catch (error) {
            return startupFailure = { plugins: [], recovery: true, disabled: false, errors: [{ id: "startup", message: `User plugins could not start. ${message(error)} Fully quit and reopen the client after checking its userplugins folder.` }] };
        }
    }
    let queue: Promise<unknown> = Promise.resolve();

    async function outcome<T>(operation: () => Promise<T> | T): Promise<UserPluginResult<T>> {
        try { return { ok: true, value: await operation() }; }
        catch (error) { return { ok: false, error: message(error) }; }
    }

    function serialize<T>(operation: () => Promise<T> | T): Promise<UserPluginResult<T>> {
        const result = queue.then(() => outcome(operation));
        queue = result;
        return result;
    }

    function cleanInspections() {
        for (const [token, inspection] of inspections)
            if (Date.now() - inspection.created > 15 * 60_000) inspections.delete(token);
        while (inspections.size >= 4) {
            const oldest = inspections.keys().next().value;
            if (oldest) inspections.delete(oldest);
        }
    }

    function inspectionFor(token: unknown, sender: number) {
        if (typeof token !== "string") throw new Error("The import session is invalid.");
        const inspection = inspections.get(token);
        if (!inspection || inspection.sender !== sender || Date.now() - inspection.created > 15 * 60_000) throw new Error("The import session expired. Select the package again.");
        return inspection;
    }

    function saveInspection(inspection: Inspection): UserPluginInspection {
        for (const candidate of inspection.candidates) {
            try { assertNotLibraryProvider(candidate.manifest); }
            catch (error) { candidate.error = message(error); }
        }
        cleanInspections();
        const token = randomUUID();
        inspections.set(token, inspection);
        const installed = store.status().plugins;
        const dependencies = [...new Map(inspection.candidates.flatMap(candidate => requiredLibraries(candidate.manifest, installed)).map(dependency => [dependency.id, dependency])).values()];
        return { token, source: inspection.source, candidates: inspection.candidates, ...(dependencies.length ? { dependencies } : {}) };
    }

    ipcMain.handle("NoyucordUserPlugins:inspect", (event, input: unknown) => serialize(async () => {
        if (!object(input) || !["file", "folder", "url"].includes(String(input.kind))) throw new Error("Select a file, folder, or HTTPS source.");
        if (input.token !== undefined) {
            const current = inspectionFor(input.token, event.sender.id);
            if (typeof input.candidate !== "string") throw new Error("Select a release asset.");
            const asset = current.assets?.find(entry => entry.key === input.candidate);
            if (!asset || !current.source.url) throw new Error("The selected release asset was not found.");
            const remote = await fetchRemotePackage(current.source.url, asset.name);
            const inspection = saveInspection({ ...remote, candidates: inspectPackage(remote.files, authorRegistries), created: Date.now(), sender: event.sender.id });
            inspections.delete(String(input.token));
            return inspection;
        }
        if (input.kind === "url") {
            if (typeof input.url !== "string") throw new Error("Enter a public HTTPS source URL.");
            const assets = await releaseAssets(input.url);
            if (assets && assets.length > 1) {
                return saveInspection({
                    assets, source: { kind: "github", url: input.url }, revision: "",
                    candidates: assets.map(asset => ({ key: asset.key, label: asset.name, manifest: {}, needsInspection: true })),
                    created: Date.now(), sender: event.sender.id
                });
            }
            const remote = await fetchRemotePackage(input.url);
            return saveInspection({ ...remote, candidates: inspectPackage(remote.files, authorRegistries), created: Date.now(), sender: event.sender.id });
        }
        const window = BrowserWindow.fromWebContents(event.sender);
        const options: Electron.OpenDialogOptions = input.kind === "folder"
            ? { title: "Select a user-plugin folder", properties: ["openDirectory"] }
            : { title: "Select a user-plugin file", properties: ["openFile"], filters: [{ name: "Plugin files", extensions: ["zip", "js", "jsx", "ts", "tsx"] }] };
        const selection = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        if (selection.canceled || !selection.filePaths[0]) return null;
        const files = await readLocalPackage(selection.filePaths[0]);
        return saveInspection({
            files, source: { kind: "local" }, revision: sourceRevision(files),
            candidates: inspectPackage(files, authorRegistries), created: Date.now(), sender: event.sender.id
        });
    }));

    ipcMain.handle("NoyucordUserPlugins:install", (event, input: unknown) => serialize(async () => {
        if (!object(input) || typeof input.candidate !== "string") throw new Error("The import selection is invalid.");
        const inspection = inspectionFor(input.token, event.sender.id);
        const candidate = inspection.candidates.find(candidate => candidate.key === input.candidate);
        if (!inspection.files || !candidate) throw new Error("Select a plugin package before installing.");
        if (candidate.error) throw new Error(candidate.error);
        const manifest = validateManifest(input.manifest);
        if (input.replaceId !== undefined && (!validId(input.replaceId) || input.replaceId !== manifest.id)) throw new Error("The replacement plugin identity does not match.");
        const replacing = typeof input.replaceId === "string";
        if (replacing) store.recordFor(manifest.id);
        store.assertAvailable(manifest, replacing ? manifest.id : undefined);
        const prepared = preparePackage(inspection.files, input.candidate, manifest);
        assertNotLibraryProvider(prepared.manifest);
        const libraries = requiredLibraries(prepared.manifest, store.status().plugins);
        if (libraries.some(library => !library.installed && (!Array.isArray(input.approvedLibraries) || !input.approvedLibraries.includes(library.id))))
            throw new Error("Review and approve the required libraries before installing this plugin.");
        if ((prepared.manifest.native || prepared.manifest.betterDiscord?.requiresNative || libraries.some(library => !library.installed)) && input.nativeTrusted !== true)
            throw new Error("This plugin needs native computer access. Review and accept the native code warning before installing.");
        const target = IS_DISCORD_DESKTOP ? "discordDesktop" : "equibop";
        const [code, nativeCode] = await Promise.all([
            compilePackage(prepared.files, prepared.manifest, target),
            compileNativePackage(prepared.files, prepared.manifest, target)
        ]);
        const dependencies: PreparedUserPlugin[] = [];
        for (const library of libraries.filter(library => !library.installed)) {
            const dependency = await fetchLibrary(library.id);
            dependencies.push({
                ...dependency, code: await compilePackage(dependency.files, dependency.manifest, target),
                compatibilityTrusted: input.nativeTrusted === true
            });
        }
        const selected = {
            ...prepared, code, source: { ...inspection.source, revision: inspection.revision }, candidate: input.candidate, updating: replacing,
            native: nativeCode === undefined ? undefined : { code: nativeCode, trusted: input.nativeTrusted === true },
            compatibilityTrusted: input.nativeTrusted === true
        };
        const installed = dependencies.length ? store.installBatch([...dependencies, selected]).at(-1)
            : store.install(selected.manifest, selected.files, selected.code, selected.source, selected.candidate, replacing, selected.native, selected.compatibilityTrusted);
        if (!installed) throw new Error("The plugin installation did not complete.");
        inspections.delete(String(input.token));
        return installed;
    }));

    ipcMain.handle("NoyucordUserPlugins:list", () => outcome(() => store.status()));
    ipcMain.handle("NoyucordUserPlugins:setEnabled", (_, id: unknown, enabled: unknown) => serialize(() => {
        if (!validId(id) || typeof enabled !== "boolean") throw new Error("The plugin enable state is invalid.");
        store.setEnabled(id, enabled);
    }));
    ipcMain.handle("NoyucordUserPlugins:remove", (_, id: unknown, removeData: unknown) => serialize(() => {
        if (!validId(id) || typeof removeData !== "boolean") throw new Error("The plugin removal request is invalid.");
        store.remove(id, removeData);
    }));

    let checkingUpdates: Promise<UserPluginStatus> | undefined;
    async function checkUpdates(force: boolean): Promise<UserPluginStatus> {
        if (checkingUpdates) return checkingUpdates;
        if (!store.canCheck(force)) return store.status();
        checkingUpdates = checkRemoteUpdates();
        try { return await checkingUpdates; }
        finally { checkingUpdates = undefined; }
    }

    async function checkRemoteUpdates(): Promise<UserPluginStatus> {
        const plugins = store.status().plugins.map(plugin => ({ ...plugin, source: { ...plugin.source } }));
        const updates = new Map<string, boolean>();
        let retryAt = 0;
        let error: string | undefined;
        for (const plugin of plugins) {
            if (plugin.pendingRemoval || plugin.source.kind === "local" || plugin.source.pinned || !plugin.source.url) continue;
            try {
                const revision = await fetchRemoteRevision(plugin.source.url, plugin.source.asset);
                updates.set(plugin.manifest.id, revision !== plugin.revision);
            } catch (failure) {
                error = message(failure);
                if (failure instanceof RemoteError && failure.retryAt) {
                    retryAt = failure.retryAt;
                    break;
                }
            }
        }
        const committed = await serialize(() => {
            const current = new Map(store.status().plugins.map(plugin => [plugin.manifest.id, plugin]));
            for (const plugin of plugins) {
                const entry = current.get(plugin.manifest.id);
                if (!entry || entry.pendingRemoval || entry.revision !== plugin.revision || entry.source.url !== plugin.source.url ||
                    entry.source.asset !== plugin.source.asset || entry.source.pinned !== plugin.source.pinned || entry.source.kind !== plugin.source.kind)
                    updates.delete(plugin.manifest.id);
            }
            store.updateCheckState(Date.now(), retryAt, error, updates);
            return store.status();
        });
        if (!committed.ok) throw new Error(committed.error);
        return committed.value;
    }

    ipcMain.handle("NoyucordUserPlugins:checkUpdates", (_, force: unknown) => outcome(() => {
        if (force !== undefined && typeof force !== "boolean") throw new Error("The update check request is invalid.");
        return checkUpdates(force === true);
    }));
    ipcMain.handle("NoyucordUserPlugins:update", (_, id: unknown, nativeTrusted: unknown) => serialize(async () => {
        if (!validId(id)) throw new Error("The plugin ID is invalid.");
        const installed = store.recordFor(id);
        if (installed.source.kind === "local") throw new Error("Select the updated local file or folder to replace this plugin.");
        if (installed.source.pinned) throw new Error("This plugin is pinned to a commit. Import another revision to change it.");
        if (!installed.source.url) throw new Error("This plugin has no remembered update source.");
        const remote = await fetchRemotePackage(installed.source.url, installed.source.asset);
        const candidates = inspectPackage(remote.files, authorRegistries);
        const candidate = candidates.find(entry => entry.key === installed.candidate);
        if (!candidate) throw new Error("The source layout changed. Import the package again to select its new entry.");
        if (candidate.error) throw new Error(candidate.error);
        const manifest: UserPluginManifest = { ...installed.manifest, native: undefined, ...candidate.manifest, id: installed.manifest.id, name: installed.manifest.name };
        const prepared = preparePackage(remote.files, candidate.key, manifest);
        assertNotLibraryProvider(prepared.manifest);
        if (requiredLibraries(prepared.manifest, store.status().plugins).some(library => !library.installed))
            throw new Error("This update changes required libraries. Import its source again to review the complete installation.");
        if ((prepared.manifest.native || prepared.manifest.betterDiscord?.requiresNative) && nativeTrusted !== true) throw new Error("This update includes native code with computer access. Import its source again to review and approve it before updating.");
        const target = IS_DISCORD_DESKTOP ? "discordDesktop" : "equibop";
        const [code, nativeCode] = await Promise.all([
            compilePackage(prepared.files, prepared.manifest, target),
            compileNativePackage(prepared.files, prepared.manifest, target)
        ]);
        store.install(prepared.manifest, prepared.files, code, remote.source, candidate.key, true,
            nativeCode === undefined ? undefined : { code: nativeCode, trusted: nativeTrusted === true }, nativeTrusted === true);
    }));
    ipcMain.handle("NoyucordUserPlugins:rollback", (_, id: unknown) => serialize(() => {
        if (!validId(id)) throw new Error("The plugin ID is invalid.");
        store.rollback(id);
    }));
    ipcMain.handle("NoyucordUserPlugins:recover", () => serialize(() => store.recover()));
    ipcMain.handle("NoyucordUserPlugins:openFolder", () => serialize(async () => {
        const error = await shell.openPath(directory);
        if (error) throw new Error("The user-plugin folder could not be opened.");
    }));

    ipcMain.on("NoyucordUserPlugins:startup", event => {
        event.returnValue = startup();
    });
    ipcMain.on("NoyucordUserPlugins:nativeMethods", event => {
        const result = startup();
        event.returnValue = result.recovery || result.disabled ? {} : nativeRuntime.methods();
    });
    ipcMain.handle("NoyucordUserPlugins:invokeNative", (event, plugin: unknown, method: unknown, args: unknown) => {
        const result = startup();
        if (result.recovery || result.disabled) throw new Error("Native user plugins were skipped. Fully quit and reopen the client after clearing recovery.");
        return nativeRuntime.invoke(event, plugin, method, args);
    });
    for (const method of ["betterDiscordSnapshot", "betterDiscordOperation"] as const) ipcMain.on(`NoyucordUserPlugins:${method}`, (event, id: unknown, operation: BetterDiscordOperation) => {
        try {
            const result = startup();
            if (result.recovery || result.disabled || !validId(id)) throw new Error("BetterDiscord plugins are unavailable in this session.");
            event.returnValue = { ok: true, value: method === "betterDiscordSnapshot" ? betterDiscord.snapshot(id) : betterDiscord.operation(id, operation) };
        } catch (error) { event.returnValue = { ok: false, error: message(error) }; }
    });
    ipcMain.handle("NoyucordUserPlugins:betterDiscordRequest", (_, id: unknown, input: BetterDiscordRequest) => outcome(async () => {
        const result = startup();
        if (result.recovery || result.disabled || !validId(id)) throw new Error("BetterDiscord plugins are unavailable in this session.");
        return betterDiscord.request(id, input);
    }));
    ipcMain.handle("NoyucordUserPlugins:flushBetterDiscordData", () => outcome(() => betterDiscord.flush()));
    ipcMain.on("NoyucordUserPlugins:markStartup", (event, id: unknown) => {
        try {
            if (id !== null && !validId(id)) throw new Error("The startup plugin identity is invalid.");
            store.markStartup(id);
            event.returnValue = null;
        } catch { event.returnValue = null; }
    });
    ipcMain.on("NoyucordUserPlugins:reportFailure", (event, id: unknown, failure: unknown) => {
        try {
            if (validId(id) && typeof failure === "string") store.reportFailure(id, failure.slice(0, 1000));
            event.returnValue = null;
        } catch { event.returnValue = null; }
    });
    ipcMain.on("NoyucordUserPlugins:completeStartup", event => {
        try { store.completeStartup(); } finally { event.returnValue = null; }
    });
}
