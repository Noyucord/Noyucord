/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { disableStyle, styleMap } from "@api/Styles";
import type { Plugin } from "@utils/types";

const pluginStyles = new WeakMap<Plugin, string[]>();

export function trackUserPluginStyles(plugin: Plugin, styles: string[]) {
    pluginStyles.set(plugin, styles);
}

export function releaseUserPluginStyles(plugin: Plugin) {
    for (const name of pluginStyles.get(plugin) ?? []) {
        disableStyle(name);
        styleMap.delete(name);
    }
    pluginStyles.delete(plugin);
}
