/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button as HostButton, TextButton } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Switch } from "@components/Switch";
import { Checkbox, React, Select, Slider, TextInput, Tooltip } from "@webpack/common";
import type { CSSProperties, ElementType, KeyboardEvent, MouseEvent, ReactNode } from "react";

import { isRecord } from "./types";

type ClassValue = string | null | undefined | false;
const cx = (...values: ClassValue[]) => values.filter(Boolean).join(" ");

export interface Setting {
    type: string;
    id?: string;
    name?: string;
    note?: string;
    value?: unknown;
    disabled?: boolean;
    enableWith?: string;
    disableWith?: string;
    settings?: Setting[];
    options?: Array<{ label?: string; name?: string; value: unknown; }>;
    children?: ReactNode;
    min?: number;
    max?: number;
    markers?: Array<number | { value: number; }>;
    color?: string;
    look?: string;
    size?: string;
    onClick?(event: MouseEvent): void;
    onChange?(value: unknown): void;
}

export interface PanelOptions {
    settings: Setting[];
    onChange?(category: string | null, id: string, value: unknown): void;
}

const Looks = Object.freeze({ FILLED: "bd-button-filled", OUTLINED: "bd-button-outlined", LINK: "bd-button-link", BLANK: "bd-button-blank" });
const Colors = Object.freeze({ BRAND: "bd-button-color-brand", BLURPLE: "bd-button-color-blurple", RED: "bd-button-color-red", GREEN: "bd-button-color-green", YELLOW: "bd-button-color-yellow", PRIMARY: "bd-button-color-primary", LINK: "bd-button-color-link", WHITE: "bd-button-color-white", TRANSPARENT: "bd-button-color-transparent", CUSTOM: "" });
const Sizes = Object.freeze({ NONE: "", TINY: "bd-button-tiny", SMALL: "bd-button-small", MEDIUM: "bd-button-medium", LARGE: "bd-button-large", ICON: "bd-button-icon" });
const variants: Record<string, "primary" | "secondary" | "dangerPrimary" | "dangerSecondary" | "overlayPrimary" | "positive" | "link" | "none"> = {
    [Colors.BRAND]: "primary", [Colors.BLURPLE]: "primary", [Colors.RED]: "dangerPrimary", [Colors.GREEN]: "positive", [Colors.YELLOW]: "secondary",
    [Colors.PRIMARY]: "secondary", [Colors.LINK]: "link", [Colors.WHITE]: "overlayPrimary", [Colors.TRANSPARENT]: "secondary", [Colors.CUSTOM]: "none"
};
const sizes: Record<string, "min" | "xs" | "small" | "medium" | "iconOnly"> = { [Sizes.NONE]: "min", [Sizes.TINY]: "xs", [Sizes.SMALL]: "small", [Sizes.MEDIUM]: "medium", [Sizes.LARGE]: "medium", [Sizes.ICON]: "iconOnly" };
const TextColors = Object.freeze({ STANDARD: "bd-text-normal", MUTED: "bd-text-muted", ERROR: "bd-text-error", BRAND: "bd-text-brand", LINK: "bd-text-link", HEADER_PRIMARY: "bd-header-primary", HEADER_SECONDARY: "bd-header-secondary", STATUS_YELLOW: "bd-text-yellow", STATUS_GREEN: "bd-text-green", STATUS_RED: "bd-text-red", ALWAYS_WHITE: "bd-text-white", CUSTOM: null });
const TextSizes = Object.freeze({ SIZE_10: "bd-text-10", SIZE_12: "bd-text-12", SIZE_14: "bd-text-14", SIZE_16: "bd-text-16", SIZE_20: "bd-text-20", SIZE_24: "bd-text-24", SIZE_32: "bd-text-32" });
const Direction = Object.freeze({ VERTICAL: "bd-flex-vertical", HORIZONTAL: "bd-flex-horizontal", HORIZONTAL_REVERSE: "bd-flex-reverse" });
const Justify = Object.freeze({ START: "bd-flex-justify-start", END: "bd-flex-justify-end", CENTER: "bd-flex-justify-center", BETWEEN: "bd-flex-justify-between", AROUND: "bd-flex-justify-around" });
const Align = Object.freeze({ START: "bd-flex-align-start", END: "bd-flex-align-end", CENTER: "bd-flex-align-center", STRETCH: "bd-flex-align-stretch", BASELINE: "bd-flex-align-baseline" });
const Wrap = Object.freeze({ NO_WRAP: "bd-flex-no-wrap", WRAP: "bd-flex-wrap", WRAP_REVERSE: "bd-flex-wrap-reverse" });
const SpinnerTypes = Object.freeze({ WANDERING_CUBES: "wandering-cubes", CHASING_DOTS: "chasing-dots", PULSING_ELLIPSIS: "pulsing-ellipsis", SPINNING_CIRCLE: "spinning-circle", SPINNING_CIRCLE_SIMPLE: "spinning-circle-simple", LOW_MOTION: "low-motion" });

interface ItemProps<T> { value?: T; defaultValue?: T; disabled?: boolean; onChange?(value: T): void; }

function useItemState<T>(props: ItemProps<T>): [T, (value: T) => void] {
    const [controlled] = React.useState(() => "value" in props);
    const [internal, setInternal] = React.useState(props.defaultValue);
    const state = (controlled ? props.value : internal) as T;
    return [state, (value: T) => { if (props.disabled) return; props.onChange?.(value); setInternal(value); }];
}

function Text({ tag: Tag = "div", className, children = null, color = TextColors.STANDARD, size = TextSizes.SIZE_14, selectable, strong, ...rest }: { tag?: ElementType; className?: string; children?: ReactNode; color?: string | null; size?: string; selectable?: boolean; strong?: boolean; [key: string]: unknown; }) {
    return <Tag className={cx(color, size, className, selectable && "bd-selectable", strong && "bd-text-strong")} {...rest}>{children}</Tag>;
}
Object.assign(Text, { Colors: TextColors, Sizes: TextSizes });

function Flex({ children, className, style, shrink = 1, grow = 1, basis = "auto", direction = Direction.HORIZONTAL, align = Align.STRETCH, justify = Justify.START, wrap = Wrap.NO_WRAP, ...rest }: { children?: ReactNode; className?: string; style?: CSSProperties; shrink?: number; grow?: number; basis?: string; direction?: string; align?: string; justify?: string; wrap?: string; [key: string]: unknown; }) {
    return <div {...rest} className={cx("bd-flex", direction, justify, align, wrap, className)} style={{ flexShrink: shrink, flexGrow: grow, flexBasis: basis, ...style }}>{children}</div>;
}
Object.assign(Flex, { Child: (props: { className?: string; [key: string]: unknown; }) => <Flex {...props} className={cx(props.className, "bd-flex-child")} />, Direction, Align, Justify, Wrap });

function Spinner({ type = SpinnerTypes.WANDERING_CUBES, animated = true, className, itemClassName, ...rest }: { type?: string; animated?: boolean; className?: string; itemClassName?: string; "aria-label"?: string; }) {
    const dots = type === SpinnerTypes.PULSING_ELLIPSIS || type === SpinnerTypes.LOW_MOTION ? 3 : 2;
    return <span role="img" {...rest} className={cx("bd-spinner", `bd-spinner-${type}`, !animated && "bd-spinner-stopAnimation", className)}>
        <span className="bd-spinner-inner">{Array.from({ length: dots }, (_, index) => <span key={index} className={cx("bd-spinner-path", itemClassName)} />)}</span>
    </span>;
}
Object.assign(Spinner, { Type: SpinnerTypes });

function Button({ className, children, onClick, buttonRef, disabled = false, type = "button", look = Looks.FILLED, color = Colors.BRAND, size = Sizes.MEDIUM, grow = true, submitting = false, ...rest }: { className?: string; children?: ReactNode; onClick?(event: MouseEvent<HTMLButtonElement>): void; buttonRef?: React.Ref<HTMLButtonElement>; disabled?: boolean; type?: "button" | "submit" | "reset"; look?: string; color?: string; size?: string; grow?: boolean; submitting?: boolean; [key: string]: unknown; }) {
    const click = (event: MouseEvent<HTMLButtonElement>) => { event.preventDefault(); event.stopPropagation(); onClick?.(event); };
    const props = { ...rest, ref: buttonRef, type, disabled, onClick: disabled ? undefined : click, className: cx("bd-button", className, look, color, grow && "bd-button-grow") };
    const content = submitting ? <Spinner type={SpinnerTypes.PULSING_ELLIPSIS} /> : children;
    if (look === Looks.LINK) return <TextButton {...props} variant={color === Colors.RED ? "danger" : "link"}>{content}</TextButton>;
    const variant = look === Looks.BLANK ? "none" : look === Looks.OUTLINED ? color === Colors.RED ? "dangerSecondary" : "secondary" : variants[color] ?? "primary";
    return <HostButton {...props} variant={variant} size={sizes[size] ?? "medium"}>{content}</HostButton>;
}
Object.assign(Button, { Looks, Colors, Sizes });

function SettingItem({ id, name, note, inline = true, children, divider = true }: { id?: string; name?: ReactNode; note?: ReactNode; inline?: boolean; children?: ReactNode; divider?: boolean; }) {
    return <div className={cx("bd-setting-item", inline && "inline", divider && "bd-setting-divider")} id={id}>
        <div className="bd-setting-header">{name && <HeadingTertiary>{name}</HeadingTertiary>}{inline && children}</div>
        {note && <Paragraph className="bd-setting-note">{note}</Paragraph>}
        {!inline && children}
    </div>;
}

function SettingGroup({ name, children }: { name?: ReactNode; children?: ReactNode; }) {
    return <section className="bd-settings-group">{name && <HeadingTertiary>{name}</HeadingTertiary>}{children}</section>;
}

function TextInputItem(props: ItemProps<string> & { placeholder?: string; maxLength?: number; onKeyDown?(event: KeyboardEvent): void; type?: string; }) {
    const [value, setValue] = useItemState(props);
    return <TextInput type={props.type} value={value ?? ""} placeholder={props.placeholder} maxLength={props.maxLength} onKeyDown={props.onKeyDown} disabled={props.disabled} onChange={setValue} />;
}

function NumberInput(props: ItemProps<number> & { min?: number; max?: number; step?: number; }) {
    const [value, setValue] = useItemState(props);
    return <TextInput type="number" value={String(value ?? "")} min={props.min} max={props.max} step={props.step ?? 1} disabled={props.disabled} onChange={next => setValue(Number(next))} />;
}

function SwitchInput(props: ItemProps<boolean>) {
    const [value, setValue] = useItemState(props);
    return <Switch checked={Boolean(value)} disabled={props.disabled} onChange={setValue} />;
}

function DropdownInput(props: ItemProps<unknown> & { options: Array<{ label?: string; name?: string; value: unknown; }>; }) {
    const [value, setValue] = useItemState(props);
    return <Select options={props.options.map(option => ({ ...option, label: option.label ?? option.name ?? String(option.value) }))} isSelected={item => item === value} select={setValue} serialize={item => String(item)} isDisabled={props.disabled} />;
}

function SliderInput(props: ItemProps<number> & { min?: number; max?: number; markers?: Array<number | { value: number; }>; }) {
    const [value, setValue] = useItemState(props);
    return <Slider initialValue={typeof value === "number" ? value : props.min ?? 0} minValue={props.min ?? 0} maxValue={props.max ?? 100} markers={props.markers?.map(marker => typeof marker === "number" ? marker : marker.value)} onValueChange={setValue} disabled={props.disabled} />;
}

function RadioInput(props: ItemProps<unknown> & { name?: string; options: Array<{ name: string; value: unknown; description?: string; }>; }) {
    const [value, setValue] = useItemState(props);
    const [group] = React.useState(() => props.name ?? `bd-radio-${Math.random().toString(36).slice(2)}`);
    return <div className="bd-radio-group" role="radiogroup">{props.options.map((option, index) =>
        <label key={index} className={cx("bd-radio-option", option.value === value && "bd-radio-selected")}>
            <input type="radio" name={group} checked={option.value === value} disabled={props.disabled} onChange={() => setValue(option.value)} />
            <span><span className="bd-radio-title">{option.name}</span>{option.description && <span className="bd-radio-description">{option.description}</span>}</span>
        </label>)}</div>;
}

function ColorInput(props: ItemProps<string | number> & { colors?: Array<string | number>; defaultColor?: string | number; }) {
    const [value, setValue] = useItemState(props);
    const hex = (color: unknown) => typeof color === "number" ? `#${color.toString(16).padStart(6, "0")}` : String(color ?? "#000000");
    return <div className="bd-color-picker">
        <input type="color" value={hex(value)} disabled={props.disabled} onChange={event => setValue(event.currentTarget.value)} />
        {[props.defaultColor, ...props.colors ?? []].filter(color => color !== undefined).map((color, index) =>
            <button key={index} type="button" className="bd-color-swatch" style={{ backgroundColor: hex(color) }} aria-label={hex(color)} disabled={props.disabled} onClick={() => setValue(color as string | number)} />)}
    </div>;
}

function SearchInput(props: ItemProps<string> & { placeholder?: string; className?: string; onKeyDown?(event: KeyboardEvent): void; }) {
    return <div className={props.className}><TextInputItem {...props} type="search" /></div>;
}

function KeybindInput(props: ItemProps<string[]> & { max?: number; clearable?: boolean; }) {
    const [value, setValue] = useItemState(props);
    const [recording, setRecording] = React.useState(false);
    const record = (event: KeyboardEvent) => {
        if (!recording) return;
        event.preventDefault();
        const keys = [event.ctrlKey && "Control", event.shiftKey && "Shift", event.altKey && "Alt", event.metaKey && "Meta"].filter((key): key is string => Boolean(key));
        if (!["Control", "Shift", "Alt", "Meta"].includes(event.key)) { keys.push(event.key); setRecording(false); }
        setValue(keys.slice(0, props.max ?? 4));
    };
    return <div className="bd-keybind">
        <button type="button" className={cx("bd-keybind-input", recording && "recording")} disabled={props.disabled} onClick={() => setRecording(current => !current)} onKeyDown={record}>
            {recording ? "Press keys" : value?.length ? value.map(key => key === "Control" ? "Ctrl" : key).join(" + ") : "No keybind set"}
        </button>
        {props.clearable && <TextButton variant="secondary" disabled={props.disabled} onClick={() => setValue([])}>Clear</TextButton>}
    </div>;
}

function CheckboxInput(props: ItemProps<boolean> & { label?: ReactNode; reverse?: boolean; }) {
    const [value, setValue] = useItemState(props);
    return <Checkbox value={Boolean(value)} disabled={props.disabled} reverse={props.reverse} onChange={(_, checked) => setValue(checked)}>{props.label}</Checkbox>;
}

function settingDisabled(setting: Setting, switches: Record<string, unknown>) {
    if (setting.enableWith) return !switches[setting.enableWith];
    if (setting.disableWith) return Boolean(switches[setting.disableWith]);
    return Boolean(setting.disabled);
}

interface ControlProps { setting: Setting; category: string | null; onChange: PanelOptions["onChange"]; switches?: Record<string, unknown>; setSwitch?(category: string | null, id: string, value: unknown): void; }

function SettingControl({ setting, category, onChange, switches = {}, setSwitch }: ControlProps) {
    const [value, setValue] = React.useState(setting.value);
    const change = (next: unknown) => { setValue(next); if (setting.type === "switch") setSwitch?.(category, setting.id ?? "", next); setting.onChange?.(next); onChange?.(category, setting.id ?? "", next); };
    const label = setting.name ?? setting.id ?? "Setting";
    const scope = category === null ? switches : isRecord(switches[category]) ? switches[category] as Record<string, unknown> : {};
    const disabled = settingDisabled(setting, scope);
    if (setting.type === "category") return <section><HeadingTertiary>{label}</HeadingTertiary>{setting.note && <Paragraph>{setting.note}</Paragraph>}{setting.settings?.map((child, index) => <SettingControl key={child.id ?? index} setting={child} category={setting.id ?? null} onChange={onChange} switches={switches} setSwitch={setSwitch} />)}</section>;
    if (setting.type === "switch") return <FormSwitch title={label} description={setting.note} value={Boolean(value)} onChange={change} disabled={disabled} />;
    if (setting.type === "custom") return <div>{setting.name && <Paragraph>{setting.name}</Paragraph>}{setting.children}{setting.note && <Paragraph>{setting.note}</Paragraph>}</div>;
    let control: ReactNode;
    if (setting.type === "text" || setting.type === "number") control = <TextInput aria-label={label} type={setting.type} value={String(value ?? "")} onChange={next => change(setting.type === "number" ? Number(next) : next)} disabled={disabled} />;
    else if (setting.type === "dropdown" || setting.type === "radio") control = <Select options={(setting.options ?? []).map(option => ({ ...option, label: option.label ?? option.name ?? String(option.value) }))} isSelected={item => item === value} select={change} serialize={item => String(item)} isDisabled={disabled} />;
    else if (setting.type === "slider") control = <Slider initialValue={typeof value === "number" ? value : setting.min ?? 0} minValue={setting.min ?? 0} maxValue={setting.max ?? 100} markers={setting.markers?.map(marker => typeof marker === "number" ? marker : marker.value)} onValueChange={change} disabled={disabled} />;
    else if (setting.type === "button") control = <Button color={setting.color} look={setting.look} size={setting.size} disabled={disabled} onClick={setting.onClick}>{setting.children ?? label}</Button>;
    else if (setting.type === "color") control = <ColorInput {...setting} value={value as string} onChange={change} disabled={disabled} />;
    else if (setting.type === "keybind") control = <KeybindInput {...setting} value={Array.isArray(value) ? value : []} onChange={change} disabled={disabled} />;
    else control = <Paragraph>This setting type ({setting.type}) is not available in Noyucord.</Paragraph>;
    return <div><Paragraph>{label}</Paragraph>{control}{setting.note && <Paragraph>{setting.note}</Paragraph>}</div>;
}

export function SettingsPanel({ settings, onChange }: PanelOptions) {
    const [switches, setSwitches] = React.useState(() => {
        const state: Record<string, unknown> = {};
        for (const setting of settings) {
            if (setting.type === "switch" && setting.id) state[setting.id] = setting.value;
            if (setting.type === "category" && setting.id) state[setting.id] = Object.fromEntries((setting.settings ?? []).filter(child => child.type === "switch" && child.id).map(child => [child.id, child.value]));
        }
        return state;
    });
    const setSwitch = (category: string | null, id: string, value: unknown) => setSwitches(current => category === null
        ? { ...current, [id]: value }
        : { ...current, [category]: { ...isRecord(current[category]) ? current[category] : {}, [id]: value } });
    return <div className="bd-settings-panel">{settings.map((setting, index) => <SettingControl key={setting.id ?? index} setting={setting} category={null} onChange={onChange} switches={switches} setSwitch={setSwitch} />)}</div>;
}

export function SettingItemControl({ setting }: { setting: Setting; }) {
    return <SettingControl setting={setting} category={null} onChange={undefined} />;
}

let created: ReturnType<typeof build> | undefined;

function build() {
    class ErrorBoundary extends React.Component<{ id?: string; name?: string; hideError?: boolean; fallback?: ReactNode; onError?(error: Error): void; children?: ReactNode; }, { hasError: boolean; }> {
        state = { hasError: false };
        static getDerivedStateFromError() { return { hasError: true }; }
        componentDidCatch(error: Error) {
            console.error(`[BetterDiscord] React error in ${this.props.name ?? "Unknown"} (${this.props.id ?? "Unknown"})`, error);
            this.props.onError?.(error);
        }
        render() {
            if (!this.state.hasError) return this.props.children;
            if (this.props.fallback) return this.props.fallback;
            return this.props.hideError ? null : <div className="react-error">There was an unexpected error. Check the console for details.</div>;
        }
    }
    return {
        Tooltip, Text, Flex, Spinner, Button, ErrorBoundary, SettingItem, SettingGroup,
        TextInput: TextInputItem, NumberInput, SwitchInput, DropdownInput, SliderInput, RadioInput, ColorInput, SearchInput, KeybindInput, Checkbox: CheckboxInput
    };
}

export function betterDiscordComponents() {
    return created ??= build();
}
