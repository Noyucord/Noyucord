/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";
import "../plugins/styles.css";

import { hasAnyVisibleSettings } from "@api/PluginManager";
import { getActiveId, getActiveIds, getActiveRevision, getActiveRevisions, getFailure, isRecovering, native } from "@api/UserPlugins";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { HeadingTertiary } from "@components/Heading";
import { CogWheel, InfoIcon } from "@components/Icons";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { AddonCard } from "@components/settings/AddonCard";
import { SettingsTab } from "@components/settings/tabs/BaseTab";
import { openPluginModal } from "@components/settings/tabs/plugins/PluginModal";
import { Switch } from "@components/Switch";
import { BetterDiscordLibraryId, InstalledUserPlugin, UserPluginCandidate, UserPluginInspection, UserPluginManifest, UserPluginResult, UserPluginStatus } from "@shared/userPlugins";
import { classNameFactory } from "@utils/css";
import { promptToRestart } from "@utils/promptToRestart";
import { React, TextInput, useEffect, useMemo, useRef, useState } from "@webpack/common";

import Plugins from "~plugins";

const cl = classNameFactory("vc-userplugins-");

function message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

interface RuntimeSnapshot {
    active: ReadonlyMap<string, string>;
    revisions: ReadonlyMap<string, string>;
}

function runtimeSnapshot(): RuntimeSnapshot {
    return { active: getActiveIds(), revisions: getActiveRevisions() };
}

function pendingPluginNames(status: UserPluginStatus | undefined, changed: readonly string[], { active, revisions } = runtimeSnapshot()) {
    return [...new Set([
        ...changed,
        ...(status?.plugins.filter(plugin => {
            const loaded = active.get(plugin.manifest.name) === plugin.manifest.id;
            return plugin.pendingRemoval || loaded !== plugin.enabled || (loaded && revisions.get(plugin.manifest.id) !== plugin.revision);
        }).map(plugin => plugin.manifest.name) ?? [])
    ])];
}

function promptForRestart(names: readonly string[]) {
    if (!names.length) return;
    const displayed = names.slice(0, 15);
    promptToRestart("relaunch", {
        subtitle: "Restart Discord to apply your user plugin changes.",
        children: <>
            <Paragraph>The following plugins require a restart:</Paragraph>
            <Paragraph>{displayed.map((name, index) => <React.Fragment key={name}>{index > 0 && ", "}<code>{name}</code></React.Fragment>)}{names.length > displayed.length && ` and ${names.length - displayed.length} more`}</Paragraph>
        </>,
        cancelText: "Later"
    });
}

interface CandidateFormProps {
    inspection: UserPluginInspection;
    candidate: UserPluginCandidate;
    busy: boolean;
    installed: InstalledUserPlugin[];
    onInstall(manifest: UserPluginManifest, nativeTrusted: boolean, approvedLibraries: BetterDiscordLibraryId[]): void;
    onCancel(): void;
}

function CandidateForm({ inspection, candidate, busy, installed, onInstall, onCancel }: CandidateFormProps) {
    const meta = candidate.manifest;
    const [name, setName] = useState(meta.name ?? "");
    const [id, setId] = useState(meta.id?.toLowerCase() ?? "");
    const [version, setVersion] = useState(meta.version ?? (meta.runtime === "betterdiscord" ? "" : "1.0.0"));
    const [description, setDescription] = useState(meta.description ?? "");
    const originalAuthors = (meta.authors ?? []).map(a => `${a.name}${a.id ? `:${a.id}` : ""}`).join(", ");
    const [authors, setAuthors] = useState(originalAuthors);
    const [dependencies, setDependencies] = useState((meta.dependencies ?? []).join(", "));
    const [trusted, setTrusted] = useState(false);
    const [nativeTrusted, setNativeTrusted] = useState(false);
    const [librariesApproved, setLibrariesApproved] = useState(false);
    const replacing = installed.some(plugin => plugin.manifest.id === id);
    const requiredLibraries = (inspection.dependencies ?? []).filter(library => meta.betterDiscord?.libraries.includes(library.id));
    const missingLibraries = requiredLibraries.filter(library => !library.installed);
    const needsNativeTrust = Boolean(meta.native || meta.betterDiscord?.requiresNative || missingLibraries.length);

    function install() {
        onInstall({
            schemaVersion: 1, apiVersion: 1, id: id.toLowerCase(), name, version, description,
            authors: authors === originalAuthors ? [...(meta.authors ?? [])] : authors.split(",").map(a => a.trim()).filter(Boolean).map(a => {
                const [name, id] = a.split(":");
                return { name: name.trim(), ...(id?.trim() ? { id: id.trim() } : {}) };
            }),
            entry: meta.entry ?? candidate.key,
            ...(meta.native ? { native: meta.native } : {}),
            ...(meta.runtime ? { runtime: meta.runtime } : {}),
            ...(meta.betterDiscord ? { betterDiscord: meta.betterDiscord } : {}),
            format: meta.format ?? "source",
            target: meta.target ?? "desktop",
            dependencies: dependencies.split(",").map(s => s.trim()).filter(Boolean)
        }, nativeTrusted, librariesApproved ? missingLibraries.map(library => library.id) : []);
    }

    return (
        <section className={cl("import")} aria-label="Review plugin installation">
            <HeadingTertiary>{replacing ? "Replace installed plugin" : "Review installation"}</HeadingTertiary>
            <Paragraph>{inspection.source.url ?? "Local files"}</Paragraph>
            {candidate.error && <Paragraph role="alert">{candidate.error}</Paragraph>}
            {candidate.warnings?.map(warning => <Paragraph key={warning} role="status">{warning}</Paragraph>)}
            {meta.runtime === "betterdiscord" && <Paragraph>BetterDiscord compatibility is experimental. Check the plugin's behavior after restarting.</Paragraph>}
            <label>Name<TextInput value={name} onChange={setName} /></label>
            <label>Stable ID<TextInput value={id} onChange={value => setId(value.toLowerCase())} placeholder="my-plugin" /></label>
            <label>Version<TextInput value={version} onChange={setVersion} /></label>
            <label>Description<TextInput value={description} onChange={setDescription} /></label>
            <label>Authors (name:Discord ID, separated by commas)<TextInput value={authors} onChange={setAuthors} /></label>
            <label>Dependencies (plugin names, separated by commas)<TextInput value={dependencies} onChange={setDependencies} /></label>
            {requiredLibraries.length > 0 && <section aria-labelledby="vc-userplugins-library-review">
                <HeadingTertiary id="vc-userplugins-library-review">Required libraries</HeadingTertiary>
                <ul className={cl("dependency-list")}>
                    {requiredLibraries.map(library => <li key={library.id}>
                        <strong>{library.name}</strong> {library.version}, {library.installed ? "already installed" : "will be installed"}
                        <Paragraph className={cl("meta")}>{library.source ? <Link href={library.source}>{library.source}</Link> : "Local files"}</Paragraph>
                    </li>)}
                </ul>
                {missingLibraries.length > 0 && <div className={cl("choice")}>
                    <span id="vc-userplugins-library-trust">Install these required library versions from the sources shown above.</span>
                    <Switch checked={librariesApproved} onChange={setLibrariesApproved} disabled={busy} aria-labelledby="vc-userplugins-library-trust" />
                </div>}
            </section>}
            <Paragraph>
                This plugin can access your Discord session and renderer data. Only install code you trust.
                Noyucord does not review user plugins. Installation does not enable the plugin.
            </Paragraph>
            {replacing && <Paragraph>This replaces the installed package after restart. Its settings and enable state will be kept.</Paragraph>}
            <div className={cl("choice")}>
                <span id="vc-userplugins-trust">I trust this source.</span>
                <Switch checked={trusted} onChange={setTrusted} disabled={busy} aria-labelledby="vc-userplugins-trust" />
            </div>
            {needsNativeTrust && <>
                <Paragraph>{meta.native
                    ? `Native helper: ${meta.native}. This code runs in Electron's main process with Node access. It can read or change files and run programs on your computer. Quit the client completely and reopen it for native changes to take effect.`
                    : "This version or its required libraries can read and change managed plugin files, make public HTTPS requests, use the clipboard, and open HTTPS links. Only allow this for code you trust."}</Paragraph>
                <div className={cl("choice")}>
                    <span id="vc-userplugins-native-trust">{meta.native ? "I trust this version with access to my computer." : "Allow compatibility access for these versions."}</span>
                    <Switch checked={nativeTrusted} onChange={setNativeTrusted} disabled={busy} aria-labelledby="vc-userplugins-native-trust" />
                </div>
            </>}
            <div className={cl("actions")}>
                <Button disabled={busy || Boolean(candidate.error) || !trusted || (needsNativeTrust && !nativeTrusted) || (missingLibraries.length > 0 && !librariesApproved) || !name.trim() || !id.trim() || !version.trim() || !description.trim() || !authors.trim()} onClick={install}>{replacing ? "Replace plugin" : "Install disabled"}</Button>
                <Button variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
            </div>
        </section>
    );
}

interface PluginRowProps {
    plugin: InstalledUserPlugin;
    libraries: InstalledUserPlugin[];
    dependents: ReadonlyMap<string, InstalledUserPlugin[]>;
    busy: boolean;
    run<T>(action: () => Promise<UserPluginResult<T>>, restartPlugin?: string): Promise<void>;
}

interface DependencyListProps {
    libraries: InstalledUserPlugin[];
    dependents: ReadonlyMap<string, InstalledUserPlugin[]>;
    busy: boolean;
    run: PluginRowProps["run"];
}

function DependencyList({ libraries, dependents, busy, run }: DependencyListProps) {
    return <ul className={cl("dependency-list")}>
        {libraries.map(library => {
            const requiredBy = dependents.get(library.manifest.name) ?? [];
            const inUse = requiredBy.length > 0;
            return <li key={library.manifest.id}>
                <strong>{library.manifest.name}</strong> {library.manifest.version}
                <Paragraph className={cl("meta")}>{library.source.url ?? "Local library installation"}</Paragraph>
                <Paragraph className={cl("meta")}>{library.pendingRemoval ? "Removal pending restart" : library.enabled ? "Enabled" : "Disabled"}{inUse ? `. Required by ${requiredBy.map(plugin => plugin.manifest.name).join(", ")}. Disable those plugins before changing this library.` : ". No enabled plugins use this library."}</Paragraph>
                <div className={cl("actions")}>
                    {library.enabled && !library.pendingRemoval && <Button variant="secondary" disabled={busy || inUse} onClick={() => { void run(() => native().setEnabled(library.manifest.id, false)); }}>Disable library</Button>}
                    {!library.pendingRemoval && <Button variant="dangerSecondary" disabled={busy || inUse} onClick={() => { void run(() => native().remove(library.manifest.id, false), library.manifest.name); }}>Remove unused library</Button>}
                </div>
            </li>;
        })}
    </ul>;
}

function PluginRow({ plugin, libraries, dependents, busy, run }: PluginRowProps) {
    const { manifest } = plugin;
    const [confirmRemoval, setConfirmRemoval] = useState(false);
    const [removeData, setRemoveData] = useState(false);
    const [confirmUpdate, setConfirmUpdate] = useState(false);
    const [nativeUpdateTrusted, setNativeUpdateTrusted] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const loaded = getActiveId(manifest.name) === manifest.id;
    const active = loaded && Plugins[manifest.name]?.started === true;
    const error = plugin.error ?? getFailure(manifest.id);
    const pending = plugin.pendingRemoval || loaded !== plugin.enabled || (loaded && getActiveRevision(manifest.id) !== plugin.revision);
    const loadedPlugin = loaded ? Plugins[manifest.name] : undefined;
    const needsNativeTrust = Boolean(manifest.native || manifest.betterDiscord?.requiresNative);
    const detailsId = `vc-userplugins-details-${manifest.id}`;
    return (
        <AddonCard
            name={manifest.name}
            description={manifest.description}
            author={manifest.authors.map(author => author.name).join(", ")}
            sourceBadge={<img src="https://equicord.org/assets/icons/misc/userplugin.png" alt="User plugin" className="vc-plugins-source" />}
            tooltip={manifest.runtime === "betterdiscord" ? "BetterDiscord user plugin" : "User plugin"}
            enabled={plugin.enabled && !plugin.pendingRemoval}
            disabled={busy || plugin.pendingRemoval}
            toggleLabel={manifest.name}
            setEnabled={enabled => { void run(() => native().setEnabled(manifest.id, enabled)); }}
            infoButton={<button
                type="button"
                aria-label={`Settings and details for ${manifest.name}`}
                disabled={busy}
                className="vc-plugins-info-button"
                aria-expanded={loadedPlugin ? undefined : detailsOpen}
                aria-controls={loadedPlugin ? undefined : detailsId}
                onClick={() => {
                    if (loadedPlugin) openPluginModal(loadedPlugin, () => { void run(() => native().list(), manifest.name); });
                    else setDetailsOpen(value => !value);
                }}
            >
                {loadedPlugin && hasAnyVisibleSettings(loadedPlugin) ? <CogWheel className="vc-plugins-info-icon" /> : <InfoIcon className="vc-plugins-info-icon" />}
            </button>}
            footer={<>
                <Paragraph className={cl("meta")}>
                    {manifest.version} · {plugin.pendingRemoval ? "Removal pending restart" : active ? "Active this session" : "Inactive this session"}
                    {pending && !plugin.pendingRemoval ? " · Restart required" : ""}
                </Paragraph>
                <Paragraph className={cl("meta")}>{plugin.source.url ?? "Local installation"}</Paragraph>
                {manifest.native && <Paragraph className={cl("meta")}>Native helper with computer access. Quit the client completely and reopen it after changes.</Paragraph>}
                <details id={detailsId} className={cl("details")} open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
                    <summary>Plugin details{libraries.length ? ` and ${libraries.length === 1 ? "dependency" : "dependencies"}` : ""}</summary>
                    <Paragraph className={cl("meta")}>{manifest.runtime === "betterdiscord" ? "BetterDiscord compatibility" : "Noyucord user plugin"}. ID: {manifest.id}. Target: {manifest.target}.</Paragraph>
                    {manifest.betterDiscord?.requiresNative && <Paragraph className={cl("meta")}>Compatibility access covers managed plugin files, public HTTPS requests, clipboard access, and opening HTTPS links.</Paragraph>}
                    {manifest.dependencies.length > 0 && <Paragraph className={cl("meta")}>Requires: {manifest.dependencies.join(", ")}.</Paragraph>}
                    {libraries.length > 0 && <DependencyList libraries={libraries} dependents={dependents} busy={busy} run={run} />}
                    {!loaded && <Paragraph className={cl("meta")}>Enable this plugin and restart Discord to access any settings it provides.</Paragraph>}
                </details>
                {error && <Paragraph role="alert">{error}</Paragraph>}
                <div className={cl("actions")}>
                    {plugin.updateAvailable && !plugin.pendingRemoval && <Button disabled={busy} onClick={() => {
                        if (needsNativeTrust) { setNativeUpdateTrusted(false); setConfirmUpdate(true); }
                        else void run(() => native().update(manifest.id), manifest.name);
                    }}>Update</Button>}
                    {plugin.hasBackup && !plugin.pendingRemoval && <Button variant="secondary" disabled={busy} onClick={() => { void run(() => native().rollback(manifest.id), manifest.name); }}>Restore previous version</Button>}
                    {!plugin.pendingRemoval && <Button variant="dangerSecondary" disabled={busy} onClick={() => setConfirmRemoval(true)}>Uninstall</Button>}
                </div>
                {confirmUpdate && <div className={cl("remove")}>
                    <Paragraph>{manifest.native ? "This update includes native code. The new version can read or change files and run programs on your computer." : "The new version can use compatibility access for managed plugin files, public HTTPS requests, the clipboard, and opening HTTPS links."}</Paragraph>
                    <div className={cl("choice")}>
                        <span id={`vc-userplugins-update-trust-${manifest.id}`}>{manifest.native ? "I trust the new version with access to my computer." : "Allow compatibility access for the new version."}</span>
                        <Switch checked={nativeUpdateTrusted} onChange={setNativeUpdateTrusted} aria-labelledby={`vc-userplugins-update-trust-${manifest.id}`} />
                    </div>
                    <div className={cl("actions")}>
                        <Button disabled={busy || !nativeUpdateTrusted} onClick={() => { setConfirmUpdate(false); void run(() => native().update(manifest.id, true), manifest.name); }}>Update plugin</Button>
                        <Button variant="secondary" disabled={busy} onClick={() => setConfirmUpdate(false)}>Cancel</Button>
                    </div>
                </div>}
                {confirmRemoval && (
                    <div className={cl("remove")}>
                        <Paragraph>Remove {manifest.name} after restart? Settings are kept unless you choose to remove them.</Paragraph>
                        <div className={cl("choice")}>
                            <span id={`vc-userplugins-remove-${manifest.id}`}>Also remove saved settings</span>
                            <Switch checked={removeData} onChange={setRemoveData} aria-labelledby={`vc-userplugins-remove-${manifest.id}`} />
                        </div>
                        <div className={cl("actions")}>
                            <Button variant="dangerPrimary" disabled={busy} onClick={() => { setConfirmRemoval(false); void run(() => native().remove(manifest.id, removeData), manifest.name); }}>Confirm uninstall</Button>
                            <Button variant="secondary" disabled={busy} onClick={() => setConfirmRemoval(false)}>Cancel</Button>
                        </div>
                    </div>
                )}
            </>}
        />
    );
}

export default function UserPluginsTab() {
    const [status, setStatus] = useState<UserPluginStatus>();
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [url, setUrl] = useState("");
    const [search, setSearch] = useState("");
    const [inspection, setInspection] = useState<UserPluginInspection>();
    const [candidate, setCandidate] = useState<UserPluginCandidate>();
    const [changedPlugins, setChangedPlugins] = useState<string[]>([]);
    const runtime = runtimeSnapshot();
    const pendingNames = pendingPluginNames(status, changedPlugins, runtime);
    const pendingRef = useRef(pendingNames);
    const mountedRef = useRef(true);
    const promptedRef = useRef(false);
    pendingRef.current = pendingNames;

    useEffect(() => {
        mountedRef.current = true;
        let cancelled = false;
        native().list().then(result => {
            if (cancelled) return;
            if (result.ok) {
                pendingRef.current = pendingPluginNames(result.value, []);
                setStatus(result.value);
            }
            else setError(result.error);
        }).catch(error => { if (!cancelled) setError(message(error)); });
        return () => {
            cancelled = true;
            mountedRef.current = false;
            if (pendingRef.current.length && !promptedRef.current) {
                promptedRef.current = true;
                promptForRestart(pendingRef.current);
            }
        };
    }, []);

    async function run<T>(action: () => Promise<UserPluginResult<T>>, restartPlugin?: string) {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            const result = await action();
            if (!result.ok) throw new Error(result.error);
            const next = await native().list();
            if (!next.ok) throw new Error(next.error);
            const changed = restartPlugin ? [...new Set([...changedPlugins, restartPlugin])] : changedPlugins;
            const pending = pendingPluginNames(next.value, changed);
            if (mountedRef.current) {
                if (restartPlugin || pending.join("\0") !== pendingRef.current.join("\0")) promptedRef.current = false;
                pendingRef.current = pending;
                setChangedPlugins(changed);
                setStatus(next.value);
            } else if (!promptedRef.current && pending.length) {
                pendingRef.current = pending;
                promptedRef.current = true;
                promptForRestart(pendingRef.current);
            }
        } catch (error) {
            if (mountedRef.current) setError(message(error));
        } finally {
            if (mountedRef.current) setBusy(false);
        }
    }

    async function inspect(kind: "file" | "folder" | "url", selected?: UserPluginCandidate) {
        await run(async () => {
            const result = await native().inspect({ kind, url: kind === "url" ? url : undefined,
                ...(selected && inspection ? { token: inspection.token, candidate: selected.key } : {}) });
            if (result.ok && result.value) {
                setInspection(result.value);
                setCandidate(result.value.candidates.length === 1 && !result.value.candidates[0].needsInspection ? result.value.candidates[0] : undefined);
            }
            return result;
        });
    }

    function choose(selected: UserPluginCandidate) {
        if (selected.needsInspection) void inspect("url", selected);
        else setCandidate(selected);
    }

    const { visiblePlugins, searchText, librariesByPlugin, dependents, unusedLibraries } = useMemo(() => {
        const installed = status?.plugins ?? [];
        const providers = installed.filter(plugin => plugin.manifest.betterDiscord?.provider);
        const providerOrder = new Map(providers.map((plugin, index) => [plugin, index]));
        const providersByName = new Map(providers.map(plugin => [plugin.manifest.name, plugin]));
        const visiblePlugins = installed.filter(plugin => !plugin.manifest.betterDiscord?.provider);
        const librariesByPlugin = new Map<string, InstalledUserPlugin[]>();
        const dependents = new Map<string, InstalledUserPlugin[]>();
        const referenced = new Set<string>();
        for (const plugin of installed) {
            const libraries: InstalledUserPlugin[] = [];
            for (const name of new Set(plugin.manifest.dependencies)) {
                const provider = providersByName.get(name);
                if (provider) libraries.push(provider);
                if (plugin.enabled && !plugin.pendingRemoval) {
                    const list = dependents.get(name) ?? [];
                    list.push(plugin);
                    dependents.set(name, list);
                }
                if (!plugin.manifest.betterDiscord?.provider && !plugin.pendingRemoval) referenced.add(name);
            }
            libraries.sort((a, b) => (providerOrder.get(a) ?? 0) - (providerOrder.get(b) ?? 0));
            librariesByPlugin.set(plugin.manifest.id, libraries);
        }
        const searchText = new Map(visiblePlugins.map(p => [p.manifest.id, `${p.manifest.name} ${p.manifest.description} ${p.manifest.authors.map(a => a.name).join(" ")} ${p.manifest.runtime ?? "noyucord"} ${p.manifest.dependencies.join(" ")}`.toLowerCase()]));
        return { visiblePlugins, searchText, librariesByPlugin, dependents, unusedLibraries: providers.filter(plugin => !referenced.has(plugin.manifest.name)) };
    }, [status]);
    const query = search.toLowerCase();
    const plugins = visiblePlugins.filter(plugin => searchText.get(plugin.manifest.id)?.includes(query));
    const startupError = getFailure("startup");
    return (
        <SettingsTab>
            <div className={cl("root")}>
                <Card className={`vc-plugins-info-card${pendingNames.length ? " vc-warning-card" : ""}`}>
                    <HeadingTertiary>{pendingNames.length ? "Restart required" : "User plugin management"}</HeadingTertiary>
                    <Paragraph>{pendingNames.length ? "Restart Discord to apply your user plugin changes." : "Install custom plugins or BetterDiscord .plugin.js files. Use the switch to enable or disable a plugin."}</Paragraph>
                    {pendingNames.length > 0 && <Button variant="primary" className="vc-plugins-restart-button" disabled={busy} onClick={() => { promptedRef.current = true; promptForRestart(pendingRef.current); }}>Restart</Button>}
                </Card>
                <HeadingTertiary>Install a plugin</HeadingTertiary>
                {Boolean(status?.lastChecked) && <Paragraph className={cl("meta")}>Last update check: {new Date(status?.lastChecked ?? 0).toLocaleString()}</Paragraph>}
                <div className={cl("actions")}>
                    <Button disabled={busy} onClick={() => { void inspect("file"); }}>Install from file</Button>
                    <Button variant="secondary" disabled={busy} onClick={() => { void inspect("folder"); }}>Install from folder</Button>
                    <Button variant="secondary" disabled={busy} onClick={() => { void run(() => native().openFolder()); }}>Open folder</Button>
                    <Button variant="secondary" disabled={busy} onClick={() => { void run(() => native().checkUpdates(true)); }}>Check for updates</Button>
                </div>
                <label>Public GitHub or HTTPS package URL<TextInput value={url} onChange={setUrl} placeholder="https://github.com/owner/repository" /></label>
                <Button variant="secondary" disabled={busy || !url.trim()} onClick={() => { void inspect("url"); }}>Inspect URL</Button>
                {busy && <Paragraph role="status">Working…</Paragraph>}
                {(error || status?.error || startupError) && <Paragraph role="alert">{error || status?.error || startupError}</Paragraph>}
                {(status?.recovery || isRecovering()) && <section className={cl("recovery")}>
                    <HeadingTertiary>User plugins were skipped</HeadingTertiary>
                    <Paragraph>Review plugins before restarting. Clearing recovery disables every user plugin. If you started with --noyucord-disable-userplugins, remove that flag before trying again.</Paragraph>
                    <Button disabled={busy} onClick={() => { void run(() => native().recover(), "User plugins"); }}>Disable all and clear recovery</Button>
                </section>}
                {inspection && !candidate && <section className={cl("import")}>
                    <HeadingTertiary>Choose a plugin or release file</HeadingTertiary>
                    <div className={cl("candidates")}>{inspection.candidates.map(c => <Button key={c.key} variant="secondary" disabled={busy} onClick={() => choose(c)}>{c.label}</Button>)}</div>
                    <Button variant="secondary" disabled={busy} onClick={() => setInspection(undefined)}>Cancel</Button>
                </section>}
                {inspection && candidate && <CandidateForm key={`${inspection.token}/${candidate.key}`} inspection={inspection} candidate={candidate} busy={busy} installed={status?.plugins ?? []}
                    onCancel={() => { setCandidate(undefined); setInspection(undefined); }}
                    onInstall={(manifest, nativeTrusted, approvedLibraries) => { void run(async () => {
                        const replaceId = status?.plugins.some(plugin => plugin.manifest.id === manifest.id) ? manifest.id : undefined;
                        const result = await native().install({ token: inspection.token, candidate: candidate.key, manifest, replaceId, nativeTrusted, approvedLibraries });
                        if (result.ok) { setInspection(undefined); setCandidate(undefined); }
                        return result;
                    }, manifest.name); }} />}
                <HeadingTertiary>Filters</HeadingTertiary>
                <label>Search installed plugins<TextInput value={search} onChange={setSearch} /></label>
                {status && !visiblePlugins.length && <Paragraph>No user plugins installed.</Paragraph>}
                {status && visiblePlugins.length > 0 && !plugins.length && <Paragraph>No plugins match your search.</Paragraph>}
                <HeadingTertiary>Installed plugins</HeadingTertiary>
                <div className={`vc-plugins-grid ${cl("grid")}`}>
                    {plugins.map(plugin => <PluginRow key={plugin.manifest.id} plugin={plugin} libraries={librariesByPlugin.get(plugin.manifest.id) ?? []} dependents={dependents} busy={busy} run={run} />)}
                </div>
                {unusedLibraries.length > 0 && <details className={cl("details")}>
                    <summary>Unused dependencies</summary>
                    <DependencyList libraries={unusedLibraries} dependents={dependents} busy={busy} run={run} />
                </details>}
            </div>
        </SettingsTab>
    );
}
