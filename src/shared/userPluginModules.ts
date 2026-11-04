/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const USER_PLUGIN_HOST_MODULES = [
    "@api/AudioPlayer", "@api/Badges", "@api/ChatButtons", "@api/Commands", "@api/ContextMenu",
    "@api/DataStore", "@api/HeaderBar", "@api/MemberListDecorators", "@api/MessageAccessories",
    "@api/MessageDecorations", "@api/MessageEvents", "@api/MessagePopover", "@api/MessageUpdater",
    "@api/NicknameIcons", "@api/Notices", "@api/Notifications", "@api/PluginManager",
    "@api/ProfileCollections", "@api/ProfileSections", "@api/ServerList", "@api/Settings",
    "@api/Styles", "@api/SurfaceClasses", "@api/Themes", "@api/UserArea", "@api/UserSettings",
    "@api/UserSettingDefinitions", "@utils/clipboard", "@utils/constants", "@utils/css",
    "@utils/discord", "@utils/guards", "@utils/lazy", "@utils/lazyReact", "@utils/Logger",
    "@utils/margins", "@utils/misc", "@utils/modal", "@utils/native", "@utils/onlyOnce",
    "@utils/react", "@utils/text", "@utils/types", "@utils/web", "@webpack", "@webpack/common",
    "@components/Badge", "@components/BaseText", "@components/Button", "@components/Card",
    "@components/CheckedTextInput", "@components/CodeBlock", "@components/Divider",
    "@components/ErrorBoundary", "@components/ErrorCard", "@components/ExpandableCard",
    "@components/Flex", "@components/FormSwitch", "@components/Grid", "@components/Heading",
    "@components/Heart", "@components/Icons", "@components/Link", "@components/margins",
    "@components/Notice", "@components/Paragraph", "@components/Span", "@components/Switch",
    "@components/TooltipContainer", "@components/TooltipFallback"
] as const;
