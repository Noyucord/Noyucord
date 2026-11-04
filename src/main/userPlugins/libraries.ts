/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BETTER_DISCORD_LIBRARIES } from "@shared/betterDiscord";
import { BetterDiscordLibraryId, InstalledUserPlugin, UserPluginDependency, UserPluginManifest, UserPluginSource } from "@shared/userPlugins";
import { createHash } from "crypto";

import { inspectPackage, PluginFiles, preparePackage } from "./package";
import { download } from "./sources";

export const libraryProfiles = BETTER_DISCORD_LIBRARIES;

export function libraryId(id: BetterDiscordLibraryId) {
    return `betterdiscord-library-${id}`;
}

export function assertNotLibraryProvider(manifest: Partial<UserPluginManifest>) {
    const provider = manifest.betterDiscord?.provider;
    if (provider)
        throw new Error(`The ${libraryProfiles[provider].name} library is a managed dependency. Import the plugin that requires it, then review and approve its required libraries.`);
}

export function requiredLibraries(manifest: Partial<UserPluginManifest>, installed: readonly InstalledUserPlugin[]): UserPluginDependency[] {
    return (manifest.betterDiscord?.libraries ?? []).map(id => {
        const profile = libraryProfiles[id];
        const current = installed.find(plugin => plugin.manifest.id === libraryId(id) || plugin.manifest.name === profile.name);
        if (current?.pendingRemoval)
            throw new Error(`The ${profile.name} library is pending removal. Restart Discord to finish removing it before importing this plugin.`);
        if (current && (current.manifest.runtime !== "betterdiscord" || current.manifest.name !== profile.name || current.manifest.betterDiscord?.provider !== id))
            throw new Error(`The installed plugin ${current.manifest.name} conflicts with the required ${profile.name} library. Resolve the existing installation before importing this plugin.`);
        return {
            id, name: profile.name, version: current?.manifest.version ?? profile.version,
            source: current ? current.source.url ?? "" : `https://github.com/${profile.repository}/blob/${profile.revision}/${profile.files[profile.entry].source}`,
            installed: Boolean(current)
        };
    });
}

export async function fetchLibrary(id: BetterDiscordLibraryId, fetcher: typeof download = download) {
    const profile = libraryProfiles[id];
    const entries = await Promise.all(Object.entries(profile.files).map(async ([path, file]) => {
        const response = await fetcher(`https://raw.githubusercontent.com/${profile.repository}/${profile.revision}/${file.source}`);
        if (file.sha && createHash("sha1").update(`blob ${response.data.byteLength}\0`).update(response.data).digest("hex") !== file.sha)
            throw new Error(`The ${profile.name} resource did not match its approved revision. The installed version was retained.`);
        return [path, response.data] as const;
    }));
    const files: PluginFiles = Object.fromEntries(entries);
    const candidate = inspectPackage(files).find(entry => entry.key === profile.entry);
    if (!candidate || candidate.error || candidate.manifest.name !== profile.name || candidate.manifest.version !== profile.version)
        throw new Error(`The ${profile.name} package metadata did not match its compatibility profile.`);
    const manifest: Partial<UserPluginManifest> = {
        ...candidate.manifest, id: libraryId(id), runtime: "betterdiscord",
        betterDiscord: { metadata: candidate.manifest.betterDiscord?.metadata ?? {}, libraries: [], requiresNative: true, provider: id },
        dependencies: []
    };
    const prepared = preparePackage(files, profile.entry, manifest);
    const source: UserPluginSource = {
        kind: "github", pinned: true, revision: profile.revision,
        url: `https://github.com/${profile.repository}/blob/${profile.revision}/${profile.files[profile.entry].source}`
    };
    return { ...prepared, source, candidate: profile.entry };
}
