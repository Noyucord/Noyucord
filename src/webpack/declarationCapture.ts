/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { exposeFactoryDeclarations } from "./declarations";
import type { AnyModuleFactory } from "./types";

const logger = new Logger("UserPluginDeclarations");
const factories = new WeakMap<AnyModuleFactory, AnyModuleFactory>();
let enabled = false;

export function enableUserPluginDeclarations() {
    enabled = true;
}

export function runFactoryWithDeclarations(factory: AnyModuleFactory, receiver: unknown, args: Parameters<AnyModuleFactory>) {
    if (!enabled) return factory.apply(receiver, args);
    Object.assign(args[0], { declarations: Object.seal(Object.create(null)) });
    let captured = factories.get(factory);
    if (!captured) {
        captured = factory;
        try {
            const transformed = exposeFactoryDeclarations(String(factory));
            if (transformed) {
                const source = `${transformed.source}\n//# sourceURL=noyucord://webpack-declarations/${encodeURIComponent(String(args[0].id))}.js`;
                const evaluated: unknown = (0, eval)(source);
                if (typeof evaluated !== "function") throw new TypeError("The instrumented module factory is not callable.");
                captured = evaluated as AnyModuleFactory;
            }
        } catch (error) {
            logger.warn(`Could not capture declarations for module ${String(args[0].id)}. Its original factory will run.`, error);
        }
        factories.set(factory, captured);
    }
    return captured.apply(receiver, args);
}
