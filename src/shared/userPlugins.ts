/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const USER_PLUGIN_API_VERSION = 1;
export const USER_PLUGIN_COMPILER_VERSION = "0.28.1";
export const USER_PLUGIN_MANIFEST = "noyucord.plugin.json";
export const BETTER_DISCORD_COMPATIBILITY_VERSION = 1;

export type BetterDiscordLibraryId = "zeres" | "bdfdb";

export interface BetterDiscordMetadata {
    metadata: Record<string, string>;
    libraries: BetterDiscordLibraryId[];
    requiresNative: boolean;
    provider?: BetterDiscordLibraryId;
}

export interface BetterDiscordReport {
    libraries: BetterDiscordLibraryId[];
    nativeModules: string[];
    unknownRequires: boolean;
    warnings: string[];
}

export interface BetterDiscordSnapshot {
    filename: string;
    directory: string;
    files: Record<string, string>;
    data: Record<string, unknown>;
    dataOperations?: "keys";
    nativeTrusted: boolean;
    platform: string;
    arch: string;
}

export type BetterDiscordOperation =
    | { type: "data"; data: Record<string, unknown>; }
    | { type: "dataSet"; key: string; value: unknown; }
    | { type: "dataDelete"; key: string; }
    | { type: "fs"; method: "readFile" | "writeFile" | "exists" | "readdir" | "mkdir" | "stat" | "unlink" | "rename" | "rm"; path: string; destination?: string; content?: string; encoding?: "utf8" | "base64"; }
    | { type: "clipboard"; method: "readText" | "writeText"; text?: string; }
    | { type: "openExternal"; url: string; };

export interface BetterDiscordRequest {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}

export interface BetterDiscordResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    url: string;
}

export interface UserPluginDependency {
    id: BetterDiscordLibraryId;
    name: string;
    version: string;
    source: string;
    installed: boolean;
}

export interface UserPluginAuthor {
    name: string;
    id?: string;
}

export type UserPluginAuthorRegistries = Readonly<Record<"Devs" | "EquicordDevs" | "NoyucordDevs", Readonly<Record<string, UserPluginAuthor>>>>;

export interface UserPluginManifest {
    schemaVersion: 1;
    apiVersion: 1;
    id: string;
    name: string;
    version: string;
    description: string;
    authors: UserPluginAuthor[];
    entry: string;
    native?: string;
    format: "source" | "prebuilt";
    target: "desktop" | "discordDesktop" | "equibop";
    dependencies: string[];
    runtime?: "noyucord" | "betterdiscord";
    betterDiscord?: BetterDiscordMetadata;
}

export interface UserPluginSource {
    kind: "local" | "url" | "github";
    url?: string;
    revision?: string;
    pinned?: boolean;
    asset?: string;
}

export interface UserPluginCandidate {
    key: string;
    label: string;
    manifest: Partial<UserPluginManifest>;
    needsInspection?: boolean;
    warnings?: string[];
    error?: string;
    compatibility?: BetterDiscordReport;
}

export interface UserPluginInspection {
    token: string;
    source: UserPluginSource;
    candidates: UserPluginCandidate[];
    dependencies?: UserPluginDependency[];
}

export interface InstalledUserPlugin {
    manifest: UserPluginManifest;
    source: UserPluginSource;
    enabled: boolean;
    pendingRemoval?: boolean;
    removeData?: boolean;
    error?: string;
    updateAvailable?: boolean;
    installedAt: number;
    revision: string;
    hasBackup: boolean;
}

export interface UserPluginStartup {
    plugins: Array<{ manifest: UserPluginManifest; code: string; revision?: string; }>;
    recovery: boolean;
    disabled: boolean;
    errors: Array<{ id: string; message: string; }>;
}

export interface UserPluginStatus {
    plugins: InstalledUserPlugin[];
    recovery: boolean;
    disabled: boolean;
    lastChecked: number;
    error?: string;
}

export type UserPluginResult<T> = { ok: true; value: T; } | { ok: false; error: string; };

export interface UserPluginNative {
    inspect(input: { kind: "file" | "folder" | "url"; url?: string; token?: string; candidate?: string; }): Promise<UserPluginResult<UserPluginInspection | null>>;
    install(input: { token: string; candidate: string; manifest: UserPluginManifest; replaceId?: string; nativeTrusted?: boolean; approvedLibraries?: BetterDiscordLibraryId[]; }): Promise<UserPluginResult<InstalledUserPlugin>>;
    list(): Promise<UserPluginResult<UserPluginStatus>>;
    setEnabled(id: string, enabled: boolean): Promise<UserPluginResult<void>>;
    remove(id: string, removeData: boolean): Promise<UserPluginResult<void>>;
    checkUpdates(force?: boolean): Promise<UserPluginResult<UserPluginStatus>>;
    update(id: string, nativeTrusted?: boolean): Promise<UserPluginResult<void>>;
    rollback(id: string): Promise<UserPluginResult<void>>;
    recover(): Promise<UserPluginResult<void>>;
    openFolder(): Promise<UserPluginResult<void>>;
    startup(): UserPluginStartup;
    markStartup(id: string | null): void;
    reportFailure(id: string, message: string): void;
    completeStartup(): void;
    nativeMethods(): Record<string, string[]>;
    invokeNative(plugin: string, method: string, args: unknown[]): Promise<unknown>;
    betterDiscordSnapshot(id: string): UserPluginResult<BetterDiscordSnapshot>;
    betterDiscordOperation(id: string, operation: BetterDiscordOperation): UserPluginResult<unknown>;
    betterDiscordRequest(id: string, request: BetterDiscordRequest): Promise<UserPluginResult<BetterDiscordResponse>>;
    flushBetterDiscordData(): Promise<UserPluginResult<void>>;
}
