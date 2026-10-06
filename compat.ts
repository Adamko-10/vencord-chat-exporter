/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Everything ChatExporter uses from Vencord and Discord goes through this file, so their updates
 * don't break it:
 * - Namespace imports (import * as X). When Vencord renames or removes something, it just becomes
 *   undefined here and the build only warns. A named import of a missing name stops the whole build.
 * - Every use is wrapped, with a fallback where there is one, so a change costs something nice to
 *   have (pop-ups, role names...) instead of the export itself. checkParts() says what's missing.
 * definePlugin, definePluginSettings and OptionType stay normal imports in index.tsx: every plugin
 * needs them, and if they ever change, a failed build is better than a half-loaded plugin.
 */

import * as Commands from "@api/Commands";
import * as Storage from "@api/DataStore";
import * as Web from "@utils/web";
import * as Common from "@webpack/common";

/** fn(), or the fallback when it throws or gives nothing (Vencord's lazy lookups throw once Discord changed) */
export function attempt<T>(fn: () => T | null | undefined, fallback: T): T {
    try {
        return fn() ?? fallback;
    } catch {
        return fallback;
    }
}

const warned = new Set<string>();
/** a console note, once per kind of problem */
function warnOnce(what: string, e?: unknown) {
    if (warned.has(what)) return;
    warned.add(what);
    console.warn(`[ChatExporter] ${what} isn't working (probably a Vencord or Discord update), carrying on without it.`, e ?? "");
}

// ---------- Discord's data ----------
export const getChannel = (id?: string | null): any => id ? attempt(() => Common.ChannelStore.getChannel(id), undefined) : undefined;
export const getUser = (id?: string | null): any => id ? attempt(() => Common.UserStore.getUser(id), undefined) : undefined;
export const getGuild = (id?: string | null): any => id ? attempt(() => Common.GuildStore.getGuild(id), undefined) : undefined;

/** a server role, from wherever Discord keeps it (it moved out of GuildStore in 2025) */
export function getRole(guildId: string, roleId: string): any {
    return attempt(() => Common.GuildRoleStore.getRole(guildId, roleId), undefined)
        ?? attempt(() => getGuild(guildId)?.roles?.[roleId], undefined);
}

/** the DM channel with someone, if you have one */
export const dmChannelId = (userId: string): string | undefined => attempt(() => Common.ChannelStore.getDMFromUserId(userId), undefined);

/** a server's channels, or null when Discord's list can't be read */
export function guildChannels(guildId: string): any[] | null {
    return attempt(() => {
        const all = Common.ChannelStore.getMutableGuildChannelsForGuild(guildId);
        return all && typeof all === "object" ? Object.values(all) as any[] : null;
    }, null);
}

/** the threads of a channel that Discord's app has loaded */
export function loadedThreads(parentId: string): any[] {
    return attempt(() => {
        const list = Common.ChannelStore.getAllThreadsForParent(parentId) as any;
        return Array.isArray(list) ? list : Object.values(list ?? {});
    }, []);
}

/** Discord's language, e.g. "en-GB" (decides whether 3/9 means 3 Sep or 9 Mar) */
export const discordLocale = (): string | undefined => attempt(() => Common.LocaleStore.locale || undefined, undefined);

// Discord's permission bits: part of Discord's public API, they don't change
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;

/** can you open the channel and read its history? null = can't tell, so it's just tried */
export function canRead(channel: any): boolean | null {
    const bits = attempt(() => Common.PermissionsBits, undefined);
    const view = attempt(() => bits?.VIEW_CHANNEL, VIEW_CHANNEL);
    const history = attempt(() => bits?.READ_MESSAGE_HISTORY, READ_MESSAGE_HISTORY);
    try {
        const can = (bit: bigint) => Common.PermissionStore.can(bit, channel);
        const yes = can(view) && can(history);
        return typeof yes === "boolean" ? yes : null;
    } catch (e) {
        warnOnce("Discord's permission check", e);
        return null;
    }
}

// ---------- Discord's API ----------
/** something an export can't do without is gone */
export class MissingPartError extends Error { }

const API_GONE = "ChatExporter can't reach Discord's API on this Vencord/Discord version (RestAPI changed). The plugin needs an update.";

/** a GET request through Discord's own API client (essential: there's no way around it) */
export function restGet(url: string, query?: Record<string, any>): Promise<any> {
    const api = attempt(() => Common.RestAPI, undefined);
    if (typeof api?.get !== "function") throw new MissingPartError(API_GONE);
    return api.get({ url, query, retries: 2 });
}

/** "/channels/<id>/messages": Discord's constant, or the same path written out */
export function messagesPath(channelId: string): string {
    const path = attempt(() => Common.Constants.Endpoints.MESSAGES(channelId), undefined);
    return typeof path === "string" ? path : `/channels/${channelId}/messages`;
}

// ---------- pop-ups and chat notes ----------
export type ToastKind = "message" | "success" | "failure";

let lastToast = { text: "", at: 0 };

/** a Discord pop-up; left out (with a console note) if Vencord or Discord changed them */
export function showToast(msg: string, kind: ToastKind = "message", options?: { duration?: number; }) {
    lastToast = { text: msg, at: Date.now() };
    try {
        Common.showToast(msg, kind, options);
    } catch (e) {
        warnOnce("Pop-ups", e);
    }
}

/** a note in the chat that only you can see; a pop-up instead if that changed */
export function botMessage(channelId: string, content: string) {
    try {
        Commands.sendBotMessage(channelId, { content });
    } catch (e) {
        warnOnce("Notes in the chat", e);
        const text = content.replace(/`/g, "");
        // many notes were just shown as a pop-up too, no need to show them twice
        if (text !== lastToast.text || Date.now() - lastToast.at > 5000) showToast(text);
    }
}

/** a /exportchat option's value (Vencord hands them over as { name, value } pairs) */
export function option<T>(args: any[], name: string, fallback?: T): T {
    return (attempt(() => args.find((a: any) => a?.name === name)?.value, undefined) ?? fallback) as T;
}

// Discord's slash command numbers: part of Discord's public API, they don't change
export const OptionKind = { STRING: 3, BOOLEAN: 5, USER: 6 } as const;
export const BUILT_IN_COMMAND = 0;

// ---------- remembered data ----------
/** saved data (survives restarts); undefined if it can't be read */
export async function storeGet<T>(key: string): Promise<T | undefined> {
    try {
        return await Storage.get<T>(key);
    } catch (e) {
        warnOnce("Saved data", e);
        return undefined;
    }
}

/** false if it couldn't be saved */
export async function storeSet(key: string, value: unknown): Promise<boolean> {
    try {
        await Storage.set(key, value);
        return true;
    } catch (e) {
        warnOnce("Saved data", e);
        return false;
    }
}

// ---------- right-click menus ----------
/** Discord's menu parts, or undefined if they changed (then the right-click items are left out) */
export function menuParts(): { MenuItem: any; MenuSeparator: any; } | undefined {
    return attempt(() => {
        const { MenuItem, MenuSeparator } = Common.Menu;
        return MenuItem && MenuSeparator ? { MenuItem, MenuSeparator } : undefined;
    }, undefined);
}

// ---------- saving ----------
export const isDesktopApp = () => typeof IS_DISCORD_DESKTOP !== "undefined" && IS_DISCORD_DESKTOP;

/** a normal browser download (web Discord, or when the desktop part is missing) */
export function browserDownload(file: File) {
    try {
        Web.saveFile(file);
        return;
    } catch (e) {
        warnOnce("Vencord's download helper", e);
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// ---------- self-check ----------
export interface Part {
    what: string;
    ok: boolean;
    /** what doesn't work without it */
    without: string;
    /** nothing can be exported without it */
    essential?: boolean;
}

/** what ChatExporter needs from Vencord and Discord, and whether it's there. hasNative = the desktop part (native.ts) loaded. */
export function checkParts(hasNative: boolean): Part[] {
    const isFn = (get: () => unknown) => attempt(() => typeof get() === "function", false);
    return [
        { what: "Discord's API (RestAPI)", ok: isFn(() => Common.RestAPI.get), without: "nothing can be exported", essential: true },
        { what: "pop-ups", ok: isFn(() => Common.showToast) && isFn(() => Common.Toasts.show), without: "no pop-ups (/exportchat's notes in the chat still work)" },
        { what: "notes in the chat", ok: isFn(() => Commands.sendBotMessage), without: "/exportchat's notes come as pop-ups" },
        { what: "saved data", ok: isFn(() => Storage.get) && isFn(() => Storage.set), without: "since_last forgets your exports when Discord restarts" },
        { what: "the server's channel list", ok: isFn(() => Common.ChannelStore.getMutableGuildChannelsForGuild), without: "\"all channels\" exports don't work (one channel at a time still does)" },
        { what: "the permission check", ok: isFn(() => Common.PermissionStore.can), without: "\"all channels\" also tries channels you can't open, and lists them as failed" },
        { what: "right-click menus", ok: attempt(() => !!menuParts(), false), without: "no right-click items (/exportchat still works)" },
        { what: "the desktop part (native.ts)", ok: hasNative || !isDesktopApp(), without: "no zip of the files, and saving goes through a Save window" }
    ];
}
