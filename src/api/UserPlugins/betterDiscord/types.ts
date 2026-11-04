/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { BetterDiscordOperation, BetterDiscordRequest, BetterDiscordResponse, BetterDiscordSnapshot, UserPluginManifest, UserPluginResult } from "@shared/userPlugins";

import type { createBetterDiscordPatcher } from "./patcher";

export interface BetterDiscordApiPeer {
    data: {
        load(key: string): unknown;
        save(key: string, value: unknown): void;
        delete(key: string): void;
        subscribe(key: string, listener: () => void): () => void;
    };
    patcher: ReturnType<typeof createBetterDiscordPatcher>;
    dom?: {
        addStyle(id: string, css: string): void;
        removeStyle(id: string): void;
    };
}

export interface BetterDiscordAddon {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    filename: string;
    enabled: boolean;
    instance?: unknown;
    exports?: unknown;
    provider?: string;
}

export interface BetterDiscordApiContext {
    manifest: UserPluginManifest;
    snapshot: BetterDiscordSnapshot;
    operation(operation: BetterDiscordOperation): UserPluginResult<unknown>;
    request(request: BetterDiscordRequest): Promise<UserPluginResult<BetterDiscordResponse>>;
    flushData(): Promise<UserPluginResult<void>>;
    addons(): BetterDiscordAddon[];
    themes?(): BetterDiscordAddon[];
    setEnabled(id: string, enabled: boolean): void | Promise<void>;
    reload(id: string): void | Promise<void>;
    checkUpdates(): void | Promise<void>;
    reportError(error: unknown): void;
    resolve?(name: string): BetterDiscordApiPeer | undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && (typeof value === "object" || typeof value === "function");
}

export function unsupported(name: string): never {
    throw new Error(`${name} is not supported by Noyucord's BetterDiscord compatibility API.`);
}

export function unwrap<T>(result: UserPluginResult<T>): T {
    if (!result.ok) throw new Error(result.error);
    return result.value;
}
