/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ContributorModal.css";

import { useSettings } from "@api/Settings";
import { Heading } from "@components/Heading";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { EquicordDevsById, NoyucordDevsById, VencordDevsById } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { fetchUserProfile } from "@utils/discord";
import { isTruthy } from "@utils/guards";
import { pluralize } from "@utils/misc";
import { RenderModalProps, User } from "@vencord/discord-types";
import { Modal, openModal, showToast, useEffect, useMemo, UserProfileStore, useStateFromStores } from "@webpack/common";

import gitRemote from "~git-remote";
import Plugins from "~plugins";

import { PluginCard } from "./PluginCard";
import { GithubButton, WebsiteButton } from "./PluginModalButtons";

const cl = classNameFactory("vc-author-modal-");

export function openContributorModal(user: User) {
    openModal(modalProps => <ContributorModal user={user} modalProps={modalProps} />);
}

function ContributorModal({ user, modalProps }: { user: User; modalProps: RenderModalProps; }) {
    useSettings();

    const profile = useStateFromStores([UserProfileStore], () => UserProfileStore.getUserProfile(user.id));

    useEffect(() => {
        if (!profile && !user.bot && user.id)
            fetchUserProfile(user.id);
    }, [user.id, user.bot, profile]);

    const githubName = profile?.connectedAccounts?.find(a => a.type === "github")?.name;
    const website = profile?.connectedAccounts?.find(a => a.type === "domain")?.name;

    const plugins = useMemo(() => {
        const allPlugins = Object.values(Plugins);
        const pluginsByAuthor = allPlugins.filter(p => p.authors.some(author =>
            author.id.toString() === user.id
        ));

        return pluginsByAuthor
            .filter(p => !p.name.endsWith("API"))
            .sort((a, b) => Number(a.required ?? false) - Number(b.required ?? false));
    }, [user.id]);

    const contributorSources = [
        VencordDevsById[user.id] && { name: "Vencord", url: "https://github.com/Vendicated/Vencord" },
        EquicordDevsById[user.id] && { name: "Equicord", url: "https://github.com/Equicord/Equicord" },
        NoyucordDevsById[user.id] && { name: "Noyucord", url: `https://github.com/${gitRemote}` }
    ].filter(isTruthy);

    const hasLinks = website || githubName;

    return (
        <Modal
            {...modalProps}
            title={
                <div className={cl("header")}>
                    <img
                        className={cl("avatar")}
                        src={user.getAvatarURL(void 0, 512, true)}
                        alt=""
                    />
                    <Heading tag="h2" className={cl("name")}>{user.username}</Heading>
                </div>
            }
            subtitle={
                plugins.length
                    ? (
                        <Paragraph>
                            {user.username} contributed to {pluralize(plugins.length, "plugin")}.
                        </Paragraph>
                    )
                    : (
                        <Paragraph>
                            No plugins are listed for {user.username}.
                        </Paragraph>
                    )
            }
            actionBarInput={
                hasLinks && (
                    <div
                        className={cl("links")}
                        style={{ width: "100%", justifyContent: "flex-end" }}
                    >
                        {website && (
                            <WebsiteButton
                                text={website}
                                href={`https://${website}`}
                            />
                        )}
                        {githubName && (
                            <GithubButton
                                text={githubName}
                                href={`https://github.com/${githubName}`}
                            />
                        )}
                    </div>
                )
            }
        >
            <div className={cl("root")}>
                {!!contributorSources.length && (
                    <Paragraph>
                        Contributor to {contributorSources.map((source, index) => (
                            <span key={source.name}>
                                {index > 0 && ", "}<Link href={source.url}>{source.name}</Link>
                            </span>
                        ))}.
                    </Paragraph>
                )}
                {!!plugins.length && (
                    <div className={cl("plugins")}>
                        {plugins.map(p =>
                            <PluginCard
                                key={p.name}
                                plugin={p}
                                disabled={p.required ?? false}
                                onRestartNeeded={() => showToast({ text: "Restart to apply changes!" })}
                            />
                        )}
                    </div>
                )}
            </div>
        </Modal>
    );
}
