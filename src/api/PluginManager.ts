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

import { addProfileBadge, removeProfileBadge } from "@api/Badges";
import { addChatBarButton, addChatBarButtonWrapper, removeChatBarButton, removeChatBarButtonWrapper } from "@api/ChatButtons";
import { BUILT_IN, commands as registeredCommands, registerCommand, unregisterCommand } from "@api/Commands";
import { addContextMenuPatch, removeContextMenuPatch } from "@api/ContextMenu";
import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { addMessageClickListener, addMessagePreEditListener, addMessagePreSendListener, removeMessageClickListener, removeMessagePreEditListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { addMessagePopoverButton, removeMessagePopoverButton } from "@api/MessagePopover";
import { addNicknameIcon, removeNicknameIcon } from "@api/NicknameIcons";
import { Settings, SettingsStore } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import { releaseUserPluginStyles } from "@api/UserPlugins/resources";
import { traceFunction } from "@debug/Tracer";
import { Logger } from "@utils/Logger";
import { onlyOnce } from "@utils/onlyOnce";
import { canonicalizeFind, canonicalizeReplacement } from "@utils/patches";
import { DefinedSettings, Patch, Plugin, PluginDef, PluginSettingDef, ReporterTestable, StartAt } from "@utils/types";
import { FluxEvents } from "@vencord/discord-types";
import { FluxDispatcher } from "@webpack/common";
import { patches } from "@webpack/patcher";

import Plugins, { PluginMeta } from "~plugins";
export { Plugins as plugins };

import { addAudioProcessor, removeAudioProcessor } from "./AudioPlayer";
import { addChannelToolbarButton, addHeaderBarButton, removeChannelToolbarButton, removeHeaderBarButton } from "./HeaderBar";
import { addProfileCollection, removeProfileCollection } from "./ProfileCollections";
import { addProfileSection, removeProfileSection } from "./ProfileSections";
import { addUserAreaButton, removeUserAreaButton } from "./UserArea";

const logger = new Logger("PluginManager", "#a6d189");

export const PMLogger = logger;

/** Whether we have subscribed to flux events of all the enabled plugins when FluxDispatcher was ready */
let enabledPluginsSubscribedFlux = false;
const subscribedFluxEventsPlugins = new Set<string>();

const userPluginCleanups = new Map<string, Array<() => unknown>>();
const failedUserPlugins = new Set<string>();
const failedPluginStarts = new Set<string>();
const startingUserPlugins = new Set<string>();
const userPluginStartAttempted = new Set<string>();
const pendingUserPluginStarts = new Map<string, Promise<boolean>>();
let startupStage = StartAt.Init;

function userPluginId(p: Plugin) {
    const folder = PluginMeta[p.name]?.folderName;
    return folder?.startsWith("userplugins/") ? folder.slice("userplugins/".length) : undefined;
}

function userPluginFailed(p: Plugin, error: unknown) {
    const id = userPluginId(p);
    const message = error instanceof Error ? error.message : String(error);
    const firstFailure = !failedUserPlugins.has(p.name);
    failedUserPlugins.add(p.name);
    logger.error(`User plugin ${p.name} failed: ${message}`);
    if (firstFailure && id && !IS_WEB) VencordNative.userPlugins.reportFailure(id, message);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return value !== null && (typeof value === "object" || typeof value === "function")
        && "then" in value && typeof value.then === "function";
}

export async function waitForUserPluginStartup() {
    while (pendingUserPluginStarts.size)
        await Promise.all([...pendingUserPluginStarts.values()]);
}

function cleanUserPlugin(p: Plugin) {
    const callbacks = userPluginCleanups.get(p.name) ?? [];
    userPluginCleanups.delete(p.name);
    let success = true;
    if (userPluginStartAttempted.delete(p.name)) {
        try {
            const result: unknown = p.stop?.();
            if (isThenable(result)) void Promise.resolve(result).catch(error => userPluginFailed(p, error));
        } catch (error) {
            userPluginFailed(p, error);
            success = false;
        }
    }
    for (const cleanup of callbacks.toReversed()) {
        try { cleanup(); } catch (error) {
            userPluginFailed(p, error);
            success = false;
        }
    }
    try { releaseUserPluginStyles(p); } catch (error) {
        userPluginFailed(p, error);
        success = false;
    }
    p.started = false;
    return success;
}

function startUserPlugin(p: Plugin) {
    if (p.started || pendingUserPluginStarts.has(p.name)) return true;
    if (failedUserPlugins.has(p.name)) return false;
    const foundId = userPluginId(p);
    if (!foundId) return false;
    const id = foundId;
    if (startingUserPlugins.has(p.name)) {
        userPluginFailed(p, new Error(`Dependency cycle involving ${p.name}.`));
        return false;
    }
    const {
        commands, contextMenus, managedStyle, userProfileBadges,
        onBeforeMessageEdit, onBeforeMessageSend, onMessageClick,
        chatBarButton, renderMemberListDecorator, renderMessageAccessory, renderMessageDecoration, messagePopoverButton,
        renderNicknameIcon, headerBarButton, audioProcessor, userAreaButton, renderProfileCollection, chatBarButtonWrapper,
        renderProfileSection
    } = p;
    let cancelled = false;
    const cleanups: Array<() => unknown> = [() => { cancelled = true; }];
    const register = (add: () => unknown, remove: () => unknown) => {
        cleanups.push(remove);
        add();
    };
    userPluginCleanups.set(p.name, cleanups);
    try {
        startingUserPlugins.add(p.name);
        const stageOrder = [StartAt.Init, StartAt.DOMContentLoaded, StartAt.WebpackReady];
        const pendingDependencies: Promise<boolean>[] = [];
        for (const name of p.dependencies ?? []) {
            const dependency = Plugins[name];
            if (!dependency || !isPluginEnabled(name)) throw new Error(`Required plugin ${name} is unavailable.`);
            if (failedPluginStarts.has(name) || failedUserPlugins.has(name)) throw new Error(`Required plugin ${name} failed to start.`);
            if (dependency.started) continue;
            if (stageOrder.indexOf(dependency.startAt ?? StartAt.WebpackReady) > stageOrder.indexOf(startupStage))
                throw new Error(`Required plugin ${name} starts after ${p.name}. Use a later startup stage.`);
            if (!startPlugin(dependency)) throw new Error(`Required plugin ${name} failed to start.`);
            const pending = pendingUserPluginStarts.get(name);
            if (pending) pendingDependencies.push(pending);
        }
        function activate() {
            if (cancelled) return false;
            if (commands?.length && !BUILT_IN) throw new Error("Commands are not ready at this plugin's startup stage.");
            for (const command of commands ?? []) register(
                () => registerCommand(command, p.name),
                () => { if (registeredCommands[command.name] === command) unregisterCommand(command.name); }
            );
            if (p.flux) {
                cleanups.push(() => unsubscribePluginFluxEvents(p, FluxDispatcher));
                if (enabledPluginsSubscribedFlux) subscribePluginFluxEvents(p, FluxDispatcher);
            }
            for (const [navId, handler] of Object.entries(contextMenus ?? {}))
                register(() => addContextMenuPatch(navId, handler), () => removeContextMenuPatch(navId, handler));
            if (managedStyle) register(() => enableStyle(managedStyle), () => disableStyle(managedStyle));
            for (const badge of userProfileBadges ?? []) register(() => addProfileBadge(badge), () => removeProfileBadge(badge));
            if (onBeforeMessageEdit) register(() => addMessagePreEditListener(onBeforeMessageEdit), () => removeMessagePreEditListener(onBeforeMessageEdit));
            if (onBeforeMessageSend) register(() => addMessagePreSendListener(onBeforeMessageSend), () => removeMessagePreSendListener(onBeforeMessageSend));
            if (onMessageClick) register(() => addMessageClickListener(onMessageClick), () => removeMessageClickListener(onMessageClick));
            if (chatBarButton) register(() => addChatBarButton(p.name, chatBarButton.render, chatBarButton.icon), () => removeChatBarButton(p.name));
            if (renderMemberListDecorator) register(() => addMemberListDecorator(p.name, renderMemberListDecorator), () => removeMemberListDecorator(p.name));
            if (renderMessageDecoration) register(() => addMessageDecoration(p.name, renderMessageDecoration), () => removeMessageDecoration(p.name));
            if (renderMessageAccessory) register(() => addMessageAccessory(p.name, renderMessageAccessory), () => removeMessageAccessory(p.name));
            if (messagePopoverButton) register(() => addMessagePopoverButton(p.name, messagePopoverButton.render, messagePopoverButton.icon), () => removeMessagePopoverButton(p.name));
            if (renderNicknameIcon) register(() => addNicknameIcon(p.name, renderNicknameIcon), () => removeNicknameIcon(p.name));
            if (headerBarButton) {
                if (headerBarButton.location === "channeltoolbar")
                    register(() => addChannelToolbarButton(p.name, headerBarButton.render, headerBarButton.priority), () => removeChannelToolbarButton(p.name));
                else register(() => addHeaderBarButton(p.name, headerBarButton.render, headerBarButton.priority), () => removeHeaderBarButton(p.name));
            }
            if (audioProcessor) register(() => addAudioProcessor(p.name, audioProcessor), () => removeAudioProcessor(p.name));
            if (userAreaButton) register(() => addUserAreaButton(p.name, userAreaButton.render, userAreaButton.priority), () => removeUserAreaButton(p.name));
            if (renderProfileCollection) register(() => addProfileCollection(p.name, renderProfileCollection.render, renderProfileCollection.priority), () => removeProfileCollection(p.name));
            if (chatBarButtonWrapper) register(() => addChatBarButtonWrapper(p.name, chatBarButtonWrapper.wrapper, chatBarButtonWrapper.priority), () => removeChatBarButtonWrapper(p.name));
            if (renderProfileSection) register(() => addProfileSection(p.name, renderProfileSection.render, renderProfileSection.priority), () => removeProfileSection(p.name));
            p.started = true;
            if (!IS_WEB) VencordNative.userPlugins.reportFailure(id, "");
            return true;
        }
        function begin() {
            if (cancelled) return false;
            for (const name of p.dependencies ?? []) {
                if (!Plugins[name]?.started || failedPluginStarts.has(name) || failedUserPlugins.has(name))
                    throw new Error(`Required plugin ${name} failed to start.`);
            }
            if (!IS_WEB) VencordNative.userPlugins.markStartup(id);
            userPluginStartAttempted.add(p.name);
            const result: unknown = p.start?.();
            return isThenable(result) ? Promise.resolve(result).then(activate) : activate();
        }
        const result = pendingDependencies.length
            ? Promise.all(pendingDependencies).then(begin)
            : begin();
        if (isThenable(result)) {
            let timer: ReturnType<typeof setTimeout>;
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Plugin startup exceeded the 30 second limit.")), 30_000);
            });
            const pending = Promise.race([Promise.resolve(result), timeout]).then(() => !cancelled, error => {
                cancelled = true;
                userPluginFailed(p, error);
                cleanUserPlugin(p);
                return false;
            }).finally(() => {
                clearTimeout(timer);
                pendingUserPluginStarts.delete(p.name);
                if (!IS_WEB) VencordNative.userPlugins.markStartup(null);
            });
            pendingUserPluginStarts.set(p.name, pending);
            return true;
        }
        return result;

    } catch (error) {
        userPluginFailed(p, error);
        cleanUserPlugin(p);
        return false;
    } finally {
        startingUserPlugins.delete(p.name);
        if (!IS_WEB && !pendingUserPluginStarts.has(p.name)) VencordNative.userPlugins.markStartup(null);
    }
}

export function isPluginEnabled(p: string) {
    return (
        Plugins[p]?.required ||
        Plugins[p]?.isDependency ||
        Settings.plugins[p]?.enabled
    ) ?? false;
}
export function isPluginRequired(p: string) {
    return (
        Plugins[p]?.required
    ) ?? false;
}

export function isSettingHidden(settings: DefinedSettings, setting: PluginSettingDef) {
    if (!("hidden" in setting)) return false;

    return typeof setting.hidden === "function"
        ? setting.hidden.call(settings)
        : Boolean(setting.hidden);
}

export function isSettingDisabled(settings: DefinedSettings, setting: PluginSettingDef) {
    if (!("disabled" in setting)) return false;

    return typeof setting.disabled === "function"
        ? setting.disabled.call(settings)
        : Boolean(setting.disabled);
}

export function hasAnyVisibleSettings({ settings }: Plugin) {
    return !!settings && Object.values(settings.def).some(s => !isSettingHidden(settings, s));
}

export function addPatch(newPatch: Omit<Patch, "plugin">, pluginName: string, pluginPath = `Vencord.Plugins.plugins[${JSON.stringify(pluginName)}]`) {
    // TODO: this causes crashes
    if (pluginName === "Vesktop" && newPatch.find === ".STREAMING_AUTO_STREAMER_MODE,") return;
    if (pluginName === "Equibop" && newPatch.find === ".STREAMING_AUTO_STREAMER_MODE,") return;

    const patch = newPatch as Patch;
    patch.plugin = pluginName;

    if (IS_REPORTER) {
        delete patch.predicate;
        delete patch.group;
    }

    if (patch.predicate && !patch.predicate()) return;

    canonicalizeFind(patch);
    if (!Array.isArray(patch.replacement)) {
        patch.replacement = [patch.replacement];
    }

    for (const replacement of patch.replacement) {
        canonicalizeReplacement(replacement, pluginPath);

        if (IS_REPORTER) {
            delete replacement.predicate;
        }
    }

    patch.replacement = patch.replacement.filter(({ predicate }) => !predicate || predicate());

    patches.push(patch);
}

function isReporterTestable(p: Plugin, part: ReporterTestable) {
    return p.reporterTestable == null
        ? true
        : (p.reporterTestable & part) === part;
}

export function pluginRequiresRestart(p: Plugin) {
    return p.requiresRestart !== false && (p.requiresRestart || !!p.patches?.length);
}

export const startAllPlugins = traceFunction("startAllPlugins", function startAllPlugins(target: StartAt) {
    startupStage = target;
    logger.info(`Starting plugins (stage ${target})`);
    for (const name in Plugins) {
        if (isPluginEnabled(name) && (!IS_REPORTER || isReporterTestable(Plugins[name], ReporterTestable.Start))) {
            const p = Plugins[name];

            const startAt = p.startAt ?? StartAt.WebpackReady;
            if (startAt !== target) continue;

            if (!startPlugin(Plugins[name])) failedPluginStarts.add(name);
        }
    }
});

export function startDependenciesRecursive(p: Plugin) {
    const settings = Settings.plugins;
    let restartNeeded = false;
    const failures: string[] = [];

    p.dependencies?.forEach(d => {
        if (!settings[d].enabled) {
            const dep = Plugins[d];
            startDependenciesRecursive(dep);

            // If the plugin has patches, don't start the plugin, just enable it.
            settings[d].enabled = true;
            dep.isDependency = true;

            if (pluginRequiresRestart(dep)) {
                logger.warn(`Enabling dependency ${d} requires restart.`);
                restartNeeded = true;
                return;
            }

            const result = startPlugin(dep);
            if (!result) failures.push(d);
        }
    });

    return { restartNeeded, failures };
}

export function subscribePluginFluxEvents(p: Plugin, fluxDispatcher: typeof FluxDispatcher) {
    if (p.flux && !subscribedFluxEventsPlugins.has(p.name) && (!IS_REPORTER || isReporterTestable(p, ReporterTestable.FluxEvents))) {
        subscribedFluxEventsPlugins.add(p.name);

        logger.debug("Subscribing to flux events of plugin", p.name);
        for (const [event, handler] of Object.entries(p.flux)) {
            const wrappedHandler = p.flux[event] = function () {
                if (p.name === "Encryptcord" && event === "MESSAGE_CREATE") return;
                try {
                    const res = handler!.apply(p, arguments as any);
                    return res instanceof Promise
                        ? res.catch(e => logger.error(`${p.name}: Error while handling ${event}\n`, e))
                        : res;
                } catch (e) {
                    logger.error(`${p.name}: Error while handling ${event}\n`, e);
                }
            };

            fluxDispatcher.subscribe(event as FluxEvents, wrappedHandler);
        }
    }
}

export function unsubscribePluginFluxEvents(p: Plugin, fluxDispatcher: typeof FluxDispatcher) {
    if (p.flux) {
        subscribedFluxEventsPlugins.delete(p.name);

        logger.debug("Unsubscribing from flux events of plugin", p.name);
        for (const [event, handler] of Object.entries(p.flux)) {
            fluxDispatcher.unsubscribe(event as FluxEvents, handler!);
        }
    }
}

export function subscribeAllPluginsFluxEvents(fluxDispatcher: typeof FluxDispatcher) {
    enabledPluginsSubscribedFlux = true;

    for (const name in Plugins) {
        if (!isPluginEnabled(name) || failedUserPlugins.has(name)) continue;
        const plugin = Plugins[name];
        if (!userPluginId(plugin)) subscribePluginFluxEvents(plugin, fluxDispatcher);
        else if (plugin.started) try { subscribePluginFluxEvents(plugin, fluxDispatcher); } catch (error) {
            userPluginFailed(plugin, error);
            cleanUserPlugin(plugin);
        }
    }
}

export const startPlugin = traceFunction("startPlugin", function startPlugin(p: Plugin) {
    if (userPluginId(p)) return startUserPlugin(p);
    const {
        name, commands, contextMenus, managedStyle, userProfileBadges,
        onBeforeMessageEdit, onBeforeMessageSend, onMessageClick,
        chatBarButton, renderMemberListDecorator, renderMessageAccessory, renderMessageDecoration, messagePopoverButton,
        // Custom
        renderNicknameIcon, headerBarButton, audioProcessor, userAreaButton, renderProfileCollection, chatBarButtonWrapper,
        renderProfileSection
    } = p;

    if (p.start) {
        logger.info("Starting plugin", name);
        if (p.started) {
            logger.warn(`${name} already started`);
            return false;
        }
        try {
            p.start();
        } catch (e) {
            logger.error(`Failed to start ${name}\n`, e);
            return false;
        }
    }

    p.started = true;

    if (commands?.length) {
        logger.debug("Registering commands of plugin", name);
        for (const cmd of commands) {
            try {
                registerCommand(cmd, name);
            } catch (e) {
                logger.error(`Failed to register command ${cmd.name}\n`, e);
                return false;
            }
        }
    }

    if (enabledPluginsSubscribedFlux) {
        subscribePluginFluxEvents(p, FluxDispatcher);
    }

    if (contextMenus) {
        logger.debug("Adding context menus patches of plugin", name);
        for (const navId in contextMenus) {
            addContextMenuPatch(navId, contextMenus[navId]);
        }
    }

    if (managedStyle) enableStyle(managedStyle);

    if (userProfileBadges) userProfileBadges.forEach(e => addProfileBadge(e));

    if (onBeforeMessageEdit) addMessagePreEditListener(onBeforeMessageEdit);
    if (onBeforeMessageSend) addMessagePreSendListener(onBeforeMessageSend);
    if (onMessageClick) addMessageClickListener(onMessageClick);

    if (chatBarButton) addChatBarButton(name, chatBarButton.render, chatBarButton.icon);
    if (renderMemberListDecorator) addMemberListDecorator(name, renderMemberListDecorator);
    if (renderMessageDecoration) addMessageDecoration(name, renderMessageDecoration);
    if (renderMessageAccessory) addMessageAccessory(name, renderMessageAccessory);
    if (messagePopoverButton) addMessagePopoverButton(name, messagePopoverButton.render, messagePopoverButton.icon);

    // Custom
    if (renderNicknameIcon) addNicknameIcon(name, renderNicknameIcon);
    if (headerBarButton) {
        if (headerBarButton.location === "channeltoolbar") {
            addChannelToolbarButton(name, headerBarButton.render, headerBarButton.priority);
        } else {
            addHeaderBarButton(name, headerBarButton.render, headerBarButton.priority);
        }
    }
    if (audioProcessor) addAudioProcessor(name, audioProcessor);
    if (userAreaButton) addUserAreaButton(name, userAreaButton.render, userAreaButton.priority);
    if (renderProfileCollection) addProfileCollection(name, renderProfileCollection.render, renderProfileCollection.priority);
    if (chatBarButtonWrapper) addChatBarButtonWrapper(name, chatBarButtonWrapper.wrapper, chatBarButtonWrapper.priority);
    if (renderProfileSection) addProfileSection(name, renderProfileSection.render, renderProfileSection.priority);

    return true;
}, p => `startPlugin ${p.name}`);

export const stopPlugin = traceFunction("stopPlugin", function stopPlugin(p: Plugin) {
    if (userPluginId(p)) return cleanUserPlugin(p);
    const {
        name, commands, contextMenus, managedStyle, userProfileBadges,
        onBeforeMessageEdit, onBeforeMessageSend, onMessageClick,
        chatBarButton, renderMemberListDecorator, renderMessageAccessory, renderMessageDecoration, messagePopoverButton,
        // Custom
        renderNicknameIcon, headerBarButton, audioProcessor, userAreaButton, renderProfileCollection, chatBarButtonWrapper,
        renderProfileSection
    } = p;

    if (p.stop) {
        logger.info("Stopping plugin", name);
        if (!p.started) {
            logger.warn(`${name} already stopped`);
            return false;
        }
        try {
            p.stop();
        } catch (e) {
            logger.error(`Failed to stop ${name}\n`, e);
            return false;
        }
    }

    p.started = false;

    if (commands?.length) {
        logger.debug("Unregistering commands of plugin", name);
        for (const cmd of commands) {
            try {
                unregisterCommand(cmd.name);
            } catch (e) {
                logger.error(`Failed to unregister command ${cmd.name}\n`, e);
                return false;
            }
        }
    }

    unsubscribePluginFluxEvents(p, FluxDispatcher);

    if (contextMenus) {
        logger.debug("Removing context menus patches of plugin", name);
        for (const navId in contextMenus) {
            removeContextMenuPatch(navId, contextMenus[navId]);
        }
    }

    if (managedStyle) disableStyle(managedStyle);

    if (userProfileBadges) userProfileBadges.forEach(e => removeProfileBadge(e));

    if (onBeforeMessageEdit) removeMessagePreEditListener(onBeforeMessageEdit);
    if (onBeforeMessageSend) removeMessagePreSendListener(onBeforeMessageSend);
    if (onMessageClick) removeMessageClickListener(onMessageClick);

    if (chatBarButton) removeChatBarButton(name);
    if (renderMemberListDecorator) removeMemberListDecorator(name);
    if (renderMessageDecoration) removeMessageDecoration(name);
    if (renderMessageAccessory) removeMessageAccessory(name);
    if (messagePopoverButton) removeMessagePopoverButton(name);

    // Custom
    if (renderNicknameIcon) removeNicknameIcon(name);
    if (headerBarButton) {
        if (headerBarButton.location === "channeltoolbar") {
            removeChannelToolbarButton(name);
        } else {
            removeHeaderBarButton(name);
        }
    }
    if (audioProcessor) removeAudioProcessor(name);
    if (userAreaButton) removeUserAreaButton(name);
    if (renderProfileCollection) removeProfileCollection(name);
    if (chatBarButtonWrapper) removeChatBarButtonWrapper(name);
    if (renderProfileSection) removeProfileSection(name);

    return true;
}, p => `stopPlugin ${p.name}`);

export const initPluginManager = onlyOnce(function init() {
    const pluginsValues = Object.values(Plugins);
    const settings = Settings.plugins;

    const pluginKeysToBind: Array<keyof PluginDef & `${"on" | "render"}${string}`> = [
        "onBeforeMessageEdit", "onBeforeMessageSend", "onMessageClick",
        "renderMemberListDecorator", "renderMessageAccessory", "renderMessageDecoration",
        // Custom
        "renderNicknameIcon"
    ];

    const neededApiPlugins = new Set<string>();

    // First round-trip to mark and force enable dependencies
    //
    // FIXME: might need to revisit this if there's ever nested (dependencies of dependencies) dependencies since this only
    // goes for the top level and their children, but for now this works okay with the current API plugins
    for (const p of pluginsValues) if (isPluginEnabled(p.name)) {
        p.dependencies?.forEach(d => {
            const dep = Plugins[d];

            if (!dep) {
                const error = new Error(`Plugin ${p.name} has unresolved dependency ${d}`);

                if (IS_DEV) {
                    throw error;
                }

                logger.warn(error);
                return;
            }

            settings[d].enabled = true;
            dep.isDependency = true;
        });

        if (p.commands?.length) neededApiPlugins.add("CommandsAPI");
        if (p.onBeforeMessageEdit || p.onBeforeMessageSend || p.onMessageClick) neededApiPlugins.add("MessageEventsAPI");
        if (p.chatBarButton) neededApiPlugins.add("ChatInputButtonAPI");
        if (p.renderMemberListDecorator) neededApiPlugins.add("MemberListDecoratorsAPI");
        if (p.renderMessageAccessory) neededApiPlugins.add("MessageAccessoriesAPI");
        if (p.renderMessageDecoration) neededApiPlugins.add("MessageDecorationsAPI");
        if (p.messagePopoverButton) neededApiPlugins.add("MessagePopoverAPI");
        if (p.userProfileBadge) neededApiPlugins.add("BadgeAPI");

        // Custom
        if (p.renderNicknameIcon) neededApiPlugins.add("NicknameIconsAPI");
        if (p.headerBarButton) neededApiPlugins.add("HeaderBarAPI");
        if (p.audioProcessor) neededApiPlugins.add("AudioPlayerAPI");
        if (p.userAreaButton) neededApiPlugins.add("UserAreaAPI");
        if (p.renderProfileCollection) neededApiPlugins.add("ProfileCollectionsAPI");
        if (p.chatBarButtonWrapper) neededApiPlugins.add("ChatInputButtonAPI");
        if (p.renderProfileSection) neededApiPlugins.add("ProfileSectionsAPI");

        for (const key of pluginKeysToBind) {
            p[key] &&= (p[key] as Function).bind(p) as any;
        }
    }

    for (const p of neededApiPlugins) {
        Plugins[p].isDependency = true;
        settings[p].enabled = true;
    }

    for (const p of pluginsValues) {
        if (failedUserPlugins.has(p.name)) continue;
        const ownedPatches = patches.length;
        const settingsListeners: Array<{ path: string; callback: (value: unknown) => void; }> = [];
        try {
            if (p.settings) {
                p.settings.pluginName = p.name;

                for (const [key, def] of Object.entries(p.settings.def)) {
                    if (def.onChange) {
                        const path = `plugins.${p.name}.${key}`;
                        SettingsStore.addChangeListener(path, def.onChange);
                        settingsListeners.push({ path, callback: def.onChange });
                    }
                }
            }

            if (p.patches && isPluginEnabled(p.name)) {
                if (!IS_REPORTER || isReporterTestable(p, ReporterTestable.Patches)) {
                    for (const patch of p.patches) {
                        addPatch(patch, p.name);
                    }
                }
            }
        } catch (error) {
            if (!userPluginId(p)) throw error;
            userPluginFailed(p, error);
            patches.splice(ownedPatches);
            for (const { path, callback } of settingsListeners) SettingsStore.removeChangeListener(path, callback);
        }
    }
});
