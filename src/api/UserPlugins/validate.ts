/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserPluginManifest } from "@shared/userPlugins";
import { OptionType, Plugin, StartAt } from "@utils/types";

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalFunction(value: Record<string, unknown>, key: string) {
    if (value[key] !== undefined && typeof value[key] !== "function") throw new Error(`${key} must be a function.`);
}

function validatePatch(value: unknown) {
    if (!isRecord(value) || !(typeof value.find === "string" || value.find instanceof RegExp)) throw new Error("Each patch needs a string or regex find anchor.");
    optionalFunction(value, "predicate");
    const replacements = Array.isArray(value.replacement) ? value.replacement : [value.replacement];
    if (!replacements.length) throw new Error("A patch needs at least one replacement.");
    for (const replacement of replacements) {
        if (!isRecord(replacement) || !(typeof replacement.match === "string" || replacement.match instanceof RegExp) ||
            !(typeof replacement.replace === "string" || typeof replacement.replace === "function")) throw new Error("Each patch replacement needs a match and replacement.");
        optionalFunction(replacement, "predicate");
    }
}

function validateSettings(value: unknown) {
    if (!isRecord(value) || !isRecord(value.def) || typeof value.use !== "function" || typeof value.withPrivateSettings !== "function")
        throw new Error("Plugin settings must use definePluginSettings.");
    for (const [name, definition] of Object.entries(value.def)) {
        if (!isRecord(definition) || typeof definition.type !== "number" || ![OptionType.STRING, OptionType.NUMBER, OptionType.BIGINT, OptionType.BOOLEAN, OptionType.SELECT,
            OptionType.SLIDER, OptionType.COMPONENT, OptionType.CUSTOM].includes(definition.type)) throw new Error(`Setting ${name} has an invalid type.`);
        optionalFunction(definition, "onChange");
        optionalFunction(definition, "isValid");
        for (const key of ["hidden", "disabled"]) {
            if (definition[key] !== undefined && typeof definition[key] !== "boolean" && typeof definition[key] !== "function") throw new Error(`Setting ${name}.${key} must be a boolean or function.`);
        }
        if (definition.type === OptionType.COMPONENT) {
            if (typeof definition.component !== "function") throw new Error(`Setting ${name} needs a component.`);
        } else if (typeof definition.description !== "string") throw new Error(`Setting ${name} needs a description.`);
        if (definition.type === OptionType.SELECT && (!Array.isArray(definition.options) || !definition.options.length || definition.options.some(option =>
            !isRecord(option) || typeof option.label !== "string" || !["string", "boolean", "number"].includes(typeof option.value)))) throw new Error(`Setting ${name} needs valid options.`);
        if (definition.type === OptionType.SLIDER && (!Array.isArray(definition.markers) || definition.markers.length < 2 ||
            definition.markers.some(marker => typeof marker !== "number" || !Number.isFinite(marker)) || typeof definition.default !== "number")) throw new Error(`Setting ${name} needs numeric markers and a default.`);
    }
}

export function validateDefinition(value: unknown, manifest: UserPluginManifest): asserts value is Plugin {
    if (!isRecord(value) || value.name !== manifest.name || typeof value.description !== "string" || !Array.isArray(value.authors))
        throw new Error("The exported plugin must match its manifest name and include a description and authors.");
    if (value.required || value.hidden) throw new Error("User plugins cannot be required or hidden.");
    if (value.startAt !== undefined && ![StartAt.Init, StartAt.DOMContentLoaded, StartAt.WebpackReady].includes(value.startAt as StartAt)) throw new Error("The plugin startup stage is invalid.");
    for (const method of ["start", "stop", "settingsAboutComponent", "audioProcessor", "onBeforeMessageEdit", "onBeforeMessageSend", "onMessageClick",
        "renderMemberListDecorator", "renderMessageAccessory", "renderMessageDecoration", "renderNicknameIcon"])
        optionalFunction(value, method);
    for (const field of ["flux", "contextMenus"]) {
        if (value[field] !== undefined && (!isRecord(value[field]) || Object.values(value[field]).some(handler => typeof handler !== "function"))) throw new Error(`${field} handlers must be functions.`);
    }
    for (const field of ["chatBarButton", "messagePopoverButton", "headerBarButton", "userAreaButton", "renderProfileCollection", "renderProfileSection"]) {
        if (value[field] !== undefined && (!isRecord(value[field]) || typeof value[field].render !== "function")) throw new Error(`${field} needs a render function.`);
    }
    if (value.chatBarButtonWrapper !== undefined && (!isRecord(value.chatBarButtonWrapper) || typeof value.chatBarButtonWrapper.wrapper !== "function")) throw new Error("chatBarButtonWrapper needs a wrapper function.");
    if (value.commands !== undefined && (!Array.isArray(value.commands) || value.commands.some(command => !isRecord(command) ||
        typeof command.name !== "string" || typeof command.description !== "string" || typeof command.execute !== "function"))) throw new Error("Commands need a name, description, and execute function.");
    if (value.managedStyle !== undefined && typeof value.managedStyle !== "string") throw new Error("managedStyle must be a registered style name.");
    for (const field of ["searchTerms", "tags"]) {
        if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some(item => typeof item !== "string"))) throw new Error(`${field} must contain strings.`);
    }
    value.authors = value.authors.map(author => {
        if (!isRecord(author) || typeof author.name !== "string" || (author.id !== undefined && typeof author.id !== "bigint")) throw new Error("Plugin authors must have a name and an optional bigint Discord ID.");
        return author.id === undefined ? { ...author, id: 0n } : author;
    });
    if (value.patches !== undefined) {
        if (!Array.isArray(value.patches)) throw new Error("Plugin patches must be an array.");
        value.patches.forEach(validatePatch);
    }
    if (value.dependencies !== undefined && (!Array.isArray(value.dependencies) || value.dependencies.some(d => typeof d !== "string"))) throw new Error("Plugin dependencies must be an array of names.");
    const dependencies: unknown[] = Array.isArray(value.dependencies) ? value.dependencies : [];
    if (dependencies.length !== manifest.dependencies.length || dependencies.some(d => !manifest.dependencies.includes(String(d)))) throw new Error("The exported plugin dependencies do not match its manifest.");
    if (value.settings !== undefined) validateSettings(value.settings);
}
