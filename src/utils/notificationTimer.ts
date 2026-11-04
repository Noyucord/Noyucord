/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./notificationTimer.css";

import { useEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties } from "react";

export function useNotificationTimer(timeout: number, paused: boolean, permanent: boolean | undefined, onClose: (() => void) | undefined, resetOnHover = false) {
    const start = useRef(Date.now());
    const pause = useRef<number | null>(null);
    const close = useRef(onClose);
    const [progress, setProgress] = useState({ elapsed: 0, version: 0 });
    close.current = onClose;

    useEffect(() => {
        if (permanent || (timeout === 0 && !resetOnHover)) return;
        const now = Date.now();
        if (resetOnHover) start.current = now;
        else if (paused) pause.current ??= now;
        else if (pause.current !== null) {
            start.current += now - pause.current;
            pause.current = null;
        }
        const elapsed = resetOnHover ? 0 : (pause.current ?? now) - start.current;
        setProgress(previous => ({ elapsed, version: previous.version + 1 }));
        if (paused) return;
        const timer = setTimeout(() => close.current?.(), Math.max(0, timeout - elapsed));
        return () => clearTimeout(timer);
    }, [timeout, paused, permanent, resetOnHover]);

    const style: CSSProperties = {
        animationDuration: `${timeout}ms`,
        animationDelay: `${-progress.elapsed}ms`,
        animationPlayState: paused ? "paused" : "running"
    };
    return { key: progress.version, style };
}
