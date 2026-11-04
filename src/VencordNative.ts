/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Settings } from "@api/Settings";
import type { CspRequestResult } from "@main/csp/manager";
import type { PluginIpcMappings } from "@main/ipcPlugins";
import { UserThemeHeader } from "@main/themes";
import { UpdateData } from "@main/updater";
import { IpcEvents } from "@shared/IpcEvents";
import type { UserPluginNative, UserPluginResult } from "@shared/userPlugins";
import type { IpcRes } from "@utils/types";
import { ipcRenderer } from "electron/renderer";

export function invoke<T = any>(event: IpcEvents, ...args: any[]) {
    return ipcRenderer.invoke(event, ...args) as Promise<T>;
}

export function sendSync<T = any>(event: IpcEvents, ...args: any[]) {
    return ipcRenderer.sendSync(event, ...args) as T;
}

const PluginHelpers = {} as Record<string, Record<string, (...args: any[]) => Promise<any>>>;
const pluginIpcMap = sendSync<PluginIpcMappings>(IpcEvents.GET_PLUGIN_IPC_METHOD_MAP);

for (const [plugin, methods] of Object.entries(pluginIpcMap)) {
    const map = PluginHelpers[plugin] = {};
    for (const [methodName, method] of Object.entries(methods)) {
        map[methodName] = (...args: any[]) => invoke(method as IpcEvents, ...args);
    }
}

const userPluginNativeMethods = () => ipcRenderer.sendSync("NoyucordUserPlugins:nativeMethods") as Record<string, string[]>;
const invokeUserPluginNative = (plugin: string, method: string, args: unknown[]) =>
    ipcRenderer.invoke("NoyucordUserPlugins:invokeNative", plugin, method, args) as Promise<unknown>;

for (const [plugin, methods] of Object.entries(userPluginNativeMethods())) {
    if (Object.hasOwn(PluginHelpers, plugin)) continue;
    const map: Record<string, (...args: unknown[]) => Promise<unknown>> = Object.create(null);
    for (const method of methods) map[method] = (...args) => invokeUserPluginNative(plugin, method, args);
    PluginHelpers[plugin] = map;
}

const userPluginCall = <T>(method: string, ...args: unknown[]) =>
    ipcRenderer.invoke(`NoyucordUserPlugins:${method}`, ...args) as Promise<UserPluginResult<T>>;
const userPluginSync = <T>(method: string, ...args: unknown[]) =>
    ipcRenderer.sendSync(`NoyucordUserPlugins:${method}`, ...args) as UserPluginResult<T>;

const userPlugins: UserPluginNative = {
    inspect: input => userPluginCall("inspect", input),
    install: input => userPluginCall("install", input),
    list: () => userPluginCall("list"),
    setEnabled: (id, enabled) => userPluginCall("setEnabled", id, enabled),
    remove: (id, removeData) => userPluginCall("remove", id, removeData),
    checkUpdates: force => userPluginCall("checkUpdates", force),
    update: (id, nativeTrusted) => userPluginCall("update", id, nativeTrusted),
    rollback: id => userPluginCall("rollback", id),
    recover: () => userPluginCall("recover"),
    openFolder: () => userPluginCall("openFolder"),
    startup: () => ipcRenderer.sendSync("NoyucordUserPlugins:startup"),
    nativeMethods: userPluginNativeMethods,
    invokeNative: invokeUserPluginNative,
    betterDiscordSnapshot: id => userPluginSync("betterDiscordSnapshot", id),
    betterDiscordOperation: (id, operation) => userPluginSync("betterDiscordOperation", id, operation),
    betterDiscordRequest: (id, request) => userPluginCall("betterDiscordRequest", id, request),
    flushBetterDiscordData: () => userPluginCall("flushBetterDiscordData"),
    markStartup: id => { ipcRenderer.sendSync("NoyucordUserPlugins:markStartup", id); },
    reportFailure: (id, message) => { ipcRenderer.sendSync("NoyucordUserPlugins:reportFailure", id, message); },
    completeStartup: () => { ipcRenderer.sendSync("NoyucordUserPlugins:completeStartup"); }
};

export default {
    userPlugins,
    themes: {
        uploadTheme: async (fileName: string, fileData: string): Promise<void> => {
            throw new Error("uploadTheme is WEB only");
        },
        deleteTheme: async (fileName: string): Promise<void> => {
            throw new Error("deleteTheme is WEB only");
        },
        getThemesList: () => invoke<Array<UserThemeHeader>>(IpcEvents.GET_THEMES_LIST),
        getThemeData: (fileName: string) => invoke<string | undefined>(IpcEvents.GET_THEME_DATA, fileName),
        getSystemValues: () => invoke<Record<string, string>>(IpcEvents.GET_THEME_SYSTEM_VALUES),

        openFolder: () => invoke<void>(IpcEvents.OPEN_THEMES_FOLDER),
    },

    updater: {
        getRepo: () => invoke<IpcRes<string>>(IpcEvents.UPDATER_GET_REPO),
        getUpdates: () => invoke<IpcRes<UpdateData[]>>(IpcEvents.UPDATER_LIST_UPDATES),
        fetchUpdate: () => invoke<IpcRes<boolean>>(IpcEvents.UPDATER_FETCH_UPDATE),
        applyUpdate: () => invoke<IpcRes<boolean>>(IpcEvents.UPDATER_APPLY_UPDATE),
    },

    settings: {
        get: () => sendSync<Settings>(IpcEvents.GET_SETTINGS),
        set: (settings: Settings, pathToNotify?: string) => invoke<void>(IpcEvents.SET_SETTINGS, settings, pathToNotify),
        getSettingsDir: () => invoke<string>(IpcEvents.GET_SETTINGS_DIR),

        openFolder: () => invoke<void>(IpcEvents.OPEN_SETTINGS_FOLDER),
    },

    quickCss: {
        get: () => invoke<string>(IpcEvents.GET_QUICK_CSS),
        set: (css: string) => invoke<void>(IpcEvents.SET_QUICK_CSS, css),

        addChangeListener(cb: (newCss: string) => void) {
            ipcRenderer.on(IpcEvents.QUICK_CSS_UPDATE, (_, css) => cb(css));
        },

        addThemeChangeListener(cb: () => void) {
            ipcRenderer.on(IpcEvents.THEME_UPDATE, () => cb());
        },

        openFile: () => invoke<void>(IpcEvents.OPEN_QUICKCSS),
        openEditor: () => invoke<void>(IpcEvents.OPEN_MONACO_EDITOR),
        getEditorTheme: () => sendSync<string>(IpcEvents.GET_MONACO_THEME),
    },

    native: {
        getVersions: () => process.versions as Partial<NodeJS.ProcessVersions>,
        supportsWindowsMaterial: () => sendSync<boolean>(IpcEvents.SUPPORTS_WINDOWS_MATERIAL),
        openExternal: (url: string) => invoke<void>(IpcEvents.OPEN_EXTERNAL, url),
        getRendererCss: () => invoke<string>(IpcEvents.GET_RENDERER_CSS),
        onRendererCssUpdate: (cb: (newCss: string) => void) => {
            if (!IS_DEV) return;

            ipcRenderer.on(IpcEvents.RENDERER_CSS_UPDATE, (_e, newCss: string) => cb(newCss));
        }
    },

    csp: {
        /**
         * Note: Only supports full explicit matches, not wildcards.
         *
         * If `*.example.com` is allowed, `isDomainAllowed("https://sub.example.com")` will return false.
         */
        isDomainAllowed: (url: string, directives: string[]) => invoke<boolean>(IpcEvents.CSP_IS_DOMAIN_ALLOWED, url, directives),
        removeOverride: (url: string) => invoke<boolean>(IpcEvents.CSP_REMOVE_OVERRIDE, url),
        requestAddOverride: (url: string | string[], directives: string[], callerName: string) =>
            invoke<CspRequestResult>(IpcEvents.CSP_REQUEST_ADD_OVERRIDE, url, directives, callerName),
    },

    pluginHelpers: PluginHelpers
};
