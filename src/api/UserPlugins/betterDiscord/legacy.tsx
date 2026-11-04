/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ButtonCompat, LinkButton } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import type { ConfirmModalProps, ModalOptions, RenderModal } from "@vencord/discord-types";
import { closeModal as hostCloseModal, ConfirmModal as HostConfirmModal, Modal as HostModal, openModal as hostOpenModal, React, SelectedChannelStore } from "@webpack/common";
import type { ComponentProps, CSSProperties, ReactNode } from "react";

import { isRecord } from "./types";
import type { BetterDiscordModule } from "./webpack";

interface LegacyConfirmModalProps extends Omit<ConfirmModalProps, "title" | "cancelText" | "onConfirm"> {
    title?: ReactNode;
    header?: ReactNode;
    cancelText?: string | null;
    confirmButtonColor?: string;
    className?: string;
    onConfirm?(setError: (message: string) => void): unknown;
}

const modalRootClass = "vc-bd-legacy-modal-root";
const modalSmallClass = "vc-bd-legacy-modal-small";
const logger = new Logger("BetterDiscordLegacyModal");

interface LegacyModalOptions extends ModalOptions {
    instant?: boolean;
    backdropStyle?: CSSProperties;
}

export function createLegacyModules(assertActive: () => void, cleanup = new Set<() => void>(), reportError?: (error: unknown) => void): BetterDiscordModule[] {
    function ModalContent({ render, modalProps }: { render: RenderModal; modalProps: Parameters<RenderModal>[0]; }) {
        assertActive();
        return render(modalProps);
    }

    function ConfirmOnlyModal({ onConfirm, confirmText, variant, checkboxProps, ...props }: ConfirmModalProps) {
        assertActive();
        const [pending, setPending] = React.useState(false);
        const [failure, setFailure] = React.useState<string>();
        const mounted = React.useRef(true);
        const confirming = React.useRef(false);
        React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
        if (checkboxProps) throw new TypeError("A legacy confirmation modal without a cancel button does not support checkboxProps.");
        async function confirm() {
            assertActive();
            if (confirming.current) return;
            confirming.current = true;
            setPending(true);
            setFailure(undefined);
            let customFailure: string | undefined;
            try {
                await onConfirm?.(message => { customFailure = message; if (mounted.current) setFailure(message); });
                if (mounted.current) { assertActive(); props.onClose(); }
            } catch (error) {
                const message = isRecord(error) && typeof error.message === "string" ? error.message : typeof error === "string" ? error : "The action could not be completed.";
                if (mounted.current) setFailure(customFailure ?? message);
            } finally {
                confirming.current = false;
                if (mounted.current) setPending(false);
            }
        }
        return <HostModal {...props}
            notice={failure ? { message: failure, type: "critical" } : props.notice}
            actions={[{ text: confirmText, variant: variant ?? "critical-primary", onClick: confirm, loading: pending, disabled: pending }]}
        />;
    }

    function ConfirmModal({ header, title = header, cancelText, confirmButtonColor, className, ...props }: LegacyConfirmModalProps) {
        assertActive();
        const variant = props.variant ?? (confirmButtonColor === "BRAND" ? "primary" : confirmButtonColor === "RED" ? "critical-primary" : confirmButtonColor === "PRIMARY" ? "secondary" : undefined);
        const classes = className?.split(/\s+/).filter(Boolean) ?? [];
        const normalized = { ...props, className: [modalRootClass, ...classes].join(" "), size: props.size ?? (classes.includes(modalSmallClass) ? "sm" : undefined) };
        if (cancelText === null) return <ConfirmOnlyModal {...normalized} title={title} variant={variant} />;
        return <HostConfirmModal {...normalized} title={title} variant={variant} cancelText={cancelText}
            onConfirm={props.onConfirm ? setError => { assertActive(); return props.onConfirm?.(setError); } : undefined}
            onCancel={props.onCancel ? () => { assertActive(); props.onCancel?.(); } : undefined}
        />;
    }

    function openModal(render: RenderModal, { onCloseRequest, onCloseCallback, instant, backdropStyle, ...rest }: LegacyModalOptions = {}, contextKey?: string) {
        assertActive();
        if (typeof render !== "function") throw new TypeError("openModal requires a render function.");
        let closed = false;
        let closing = false;
        let closeRequested = false;
        const modal: { key?: string; } = {};
        const close = () => {
            if (closed || closing) return;
            if (modal.key === undefined) { closeRequested = true; return; }
            closing = true;
            cleanup.delete(close);
            hostCloseModal(modal.key, contextKey);
        };
        const options: LegacyModalOptions = {
            ...rest, onCloseRequest, instant, backdropStyle,
            onCloseCallback() {
                if (closed) return;
                closed = true;
                cleanup.delete(close);
                onCloseCallback?.();
            }
        };
        const key = hostOpenModal(props => <ErrorBoundary noop onError={({ error }) => {
            try { close(); } catch (closeError) { logger.error("Could not close a failed user-plugin modal", closeError); }
            try { reportError?.(error); } catch (reportFailure) { logger.error("Could not report a failed user-plugin modal", reportFailure); }
        }}><ModalContent render={render} modalProps={props} /></ErrorBoundary>, options, contextKey);
        modal.key = key;
        if (closeRequested) close();
        if (!closed && !closing) cleanup.add(close);
        return key;
    }

    const Button = Object.defineProperties(function LegacyButton(props: ComponentProps<typeof ButtonCompat>) {
        assertActive();
        return <ButtonCompat {...props} />;
    }, {
        Looks: { enumerable: true, get: () => ButtonCompat.Looks },
        Colors: { enumerable: true, get: () => ButtonCompat.Colors },
        Sizes: { enumerable: true, get: () => ButtonCompat.Sizes },
        Link: { enumerable: true, value: LinkButton }
    });

    return [
        { id: "noyucord:legacy:modals", exports: { ConfirmModal, openModal } },
        { id: "noyucord:legacy:voice", exports: { getVoiceChannelId() { assertActive(); return SelectedChannelStore.getVoiceChannelId() ?? null; } } },
        { id: "noyucord:legacy:button", exports: Button },
        { id: "noyucord:legacy:modal-styles", exports: { root: modalRootClass, small: modalSmallClass } }
    ];
}
