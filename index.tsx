/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { Channel, User } from "@vencord/discord-types";

// everything else from Vencord and Discord goes through compat.ts, so their updates don't break the plugin
import { botMessage, browserDownload, BUILT_IN_COMMAND, canRead, checkParts, discordLocale, dmChannelId, getChannel, getGuild, getRole, getUser, guildChannels, isDesktopApp, loadedThreads, menuParts, messagesPath, MissingPartError, option, OptionKind, restGet, showToast, storeGet, storeSet, ToastKind } from "./compat";
import { buildRange, DateRange, dateToSnowflake, describeRange, niceDate, snowflakeToDate } from "./dateRange";
import { linksIn } from "./links";
import { uniqueZipName, zipNameFor } from "./zipNames";

const settings = definePluginSettings({
    format: {
        type: OptionType.SELECT,
        description: "Export format",
        options: [
            { label: "Plain text (.txt), same layout as DiscordKit", value: "txt", default: true },
            { label: "HTML (looks like Discord)", value: "html" },
            { label: "JSON (raw API data)", value: "json" }
        ]
    },
    saveFiles: {
        type: OptionType.BOOLEAN,
        description: "Also download the files people sent (pictures, videos, documents, voice messages) into a .zip next to the export",
        default: true
    },
    saveLocation: {
        type: OptionType.SELECT,
        description: "Where exported files go",
        options: [
            { label: "Straight into your Downloads folder (like DiscordKit)", value: "downloads", default: true },
            { label: "Ask where to save every time", value: "ask" }
        ]
    },
    openFolder: {
        type: OptionType.BOOLEAN,
        description: "When an export finishes, open its folder with the file highlighted",
        default: true
    },
    maxMessages: {
        type: OptionType.NUMBER,
        description: "Maximum messages to export (in total, also when exporting all channels: the newest ones are kept). 0 = no limit (the whole chat).",
        default: 0
    },
    delayMs: {
        type: OptionType.NUMBER,
        description: "Delay between API requests in ms (higher = safer against rate limits). 100 messages are fetched per request.",
        default: 300
    },
    embedImages: {
        type: OptionType.BOOLEAN,
        description: "HTML: show image attachments inline (they load from Discord's CDN; links can expire after ~24h).",
        default: true
    },
    progressEvery: {
        type: OptionType.NUMBER,
        description: "Show a progress pop-up every N messages (never more than one every 5 seconds)",
        default: 2000
    }
});

// ---------- state ----------
interface ExportState {
    cancelled: boolean;
    /** messages kept so far */
    count: number;
    /** messages looked at so far (more than count when only one person's messages are kept) */
    scanned: number;
    phase: "messages" | "files";
    filesDone: number;
    filesTotal: number;
    /** the zip being filled right now, so cancelling can stop the current download */
    zipId?: string;
    /** all-channels exports: channels and threads finished / to go through */
    channelsDone?: number;
    channelsTotal?: number;
    /** stopped because the "Max messages" setting was reached */
    hitCap?: boolean;
    /** newest message looked at (single chat), for "since last export" */
    newestId?: string;
    /** the same per channel/thread, for all-channels exports */
    newestByTarget?: Map<string, string>;
}

/** running exports, keyed by channel id, or "guild:<server id>" for an all-channels export */
const running = new Map<string, ExportState>();
const guildKey = (guildId: string) => `guild:${guildId}`;

// ---------- remembering where exports ended ("since last export") ----------
/** where an earlier export ended, so the next one can carry on from there */
interface ExportMark {
    /** everything up to and including this message id was covered */
    upToId: string;
    /** all-channels exports: channels/threads that were covered further than upToId */
    channels?: Record<string, string>;
    /** when that export ran (ms) */
    at: number;
    /** where it was saved, e.g. "Downloads\[ChatExporter] general_My Server_20260924_223837.html" */
    file?: string;
    /** messages it saved */
    count: number;
    /** exports of one person's messages: their username */
    name?: string;
}

const MARKS_KEY = "ChatExporter_lastExports";
/**
 * "<channel id or guild:id>|<everyone or user id>" -> where the last export of that ended.
 * Links-only exports keep their own: "<channel id or guild:id>|links|<everyone or user id>"
 * (they don't save the messages, so a normal since_last must not carry on from them).
 */
let marks: Record<string, ExportMark> = {};
let marksLoading: Promise<void> | null = null;

const markKey = (scope: string, author?: { id: string; }, links = false) => `${scope}|${links ? "links|" : ""}${author?.id ?? "everyone"}`;

function loadMarks() {
    marksLoading ??= storeGet<Record<string, ExportMark>>(MARKS_KEY).then(v => { marks = { ...(v ?? {}), ...marks }; });
    return marksLoading;
}

/** snowflake + 1 / - 1 */
const nextId = (id: string) => (BigInt(id) + 1n).toString();
const prevId = (id: string) => (BigInt(id) - 1n).toString();

/** Remembers where an export ended. Only ever moves forward, so exporting an old date range doesn't rewind it. */
async function rememberExport(key: string, mark: ExportMark) {
    await loadMarks();
    const old = marks[key];
    if (old && cmpId(mark.upToId, old.upToId) <= 0) return;
    if (old?.channels && mark.channels) {
        for (const [id, upTo] of Object.entries(old.channels))
            if (cmpId(upTo, mark.upToId) > 0 && (!mark.channels[id] || cmpId(upTo, mark.channels[id]) > 0)) mark.channels[id] = upTo;
    }
    marks[key] = mark;
    await storeSet(MARKS_KEY, marks);
}

/** "24 Sept, 22:38" */
function shortWhen(ms: number) {
    const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
    try {
        return new Date(ms).toLocaleString(discordLocale(), opts);
    } catch {
        return new Date(ms).toLocaleString(undefined, opts);
    }
}

/** the earlier export that "since last export" carries on from */
interface SinceFrom {
    mark: ExportMark;
    /** set when that export only had this one person's messages, and the new one is for everyone or someone else */
    onlyFrom?: string;
}

/**
 * Where "since last export" carries on from: the latest export here that had these messages
 * (everyone's; for one person, theirs or everyone's, whichever went further). Without one,
 * the latest export of anyone's messages here, so a one-person export still counts as "your last export".
 * scope = channel id, or guildKey() for all-channels exports. links = look at links-only exports instead.
 */
function findMark(scope: string, author?: { id: string; }, links = false): SinceFrom | undefined {
    const everyone = marks[markKey(scope, undefined, links)];
    const own = author ? marks[markKey(scope, author, links)] : undefined;
    if (everyone || own) {
        const further = !own ? everyone! : !everyone ? own : cmpId(own.upToId, everyone.upToId) > 0 ? own : everyone;
        return { mark: further };
    }
    const prefix = `${scope}|${links ? "links|" : ""}`;
    let latest: [string, ExportMark] | undefined;
    for (const [key, mark] of Object.entries(marks)) {
        if (!key.startsWith(prefix) || (!links && key.startsWith(`${scope}|links|`))) continue;
        const c = latest ? cmpId(mark.upToId, latest[1].upToId) : 1;
        if (c > 0 || (c === 0 && mark.at > latest![1].at)) latest = [key, mark];
    }
    if (!latest) return undefined;
    const whoId = latest[0].slice(prefix.length);
    return { mark: latest[1], onlyFrom: getUser(whoId)?.username ?? latest[1].name ?? whoId };
}

/** "your last export (3 Oct, 17:17)", saying so when that one only had one other person's messages */
function lastExport(opts: ExportOptions, kind = "") {
    const only = opts.sinceOnlyFrom ? `, which only had ${opts.sinceOnlyFrom}'s messages` : "";
    return `your last ${kind}${opts.links ? "links " : ""}export (${shortWhen(opts.since!.at)}${only})`;
}

/** options for "Export New Messages": everything after where that export ended */
const newSince = (found: SinceFrom): ExportOptions => ({ since: found.mark, sinceOnlyFrom: found.onlyFrom, range: { after: snowflakeToDate(found.mark.upToId) } });

/** since_last where nothing was exported yet */
function noMarkMessage(server: boolean, links = false) {
    const what = `${server ? "all-channels " : ""}${links ? "links " : ""}export of this ${server ? "server" : "chat"}`;
    const first = links ? `one export with links: True${server ? " and channels: all" : ""}` : `one normal export${server ? " with channels: all" : ""}`;
    return `There's no remembered ${what} to carry on from. Do ${first} first, `
        + "or use from: with the date of your last one, e.g. `from: 24.09.2026 22:38`.";
}

function cancelExport(state: ExportState) {
    state.cancelled = true;
    if (state.zipId) getNative()?.zipCancel?.(state.zipId);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function toast(msg: string, type: ToastKind = "message") {
    showToast(msg, type);
}

// Discord shows one pop-up at a time and queues the rest. Progress pop-ups must therefore never come
// faster than they disappear, or hundreds pile up and keep playing long after the export is done.
const PROGRESS_GAP_MS = 5000;
const PROGRESS_SHOWN_MS = 3000;
let lastProgressToast = 0;

/** a progress pop-up, unless one was shown less than 5 seconds ago. true if it was shown. */
function progressToast(msg: string) {
    const now = Date.now();
    if (now - lastProgressToast < PROGRESS_GAP_MS) return false;
    lastProgressToast = now;
    showToast(msg, "message", { duration: PROGRESS_SHOWN_MS });
    return true;
}

/** a normal pop-up that also counts as progress, so the next progress one doesn't queue right behind it */
function noteToast(msg: string) {
    lastProgressToast = Date.now();
    toast(msg);
}

// ---------- fetching ----------
class ApiError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
    }
}

/** a part of Vencord or Discord that changed, not a network hiccup: trying again won't help */
const isBroken = (e: any) => e instanceof MissingPartError || e instanceof ReferenceError
    || (e instanceof TypeError && /is not a function|Cannot read properties|is (undefined|null|not an object)/.test(e.message));

/** GET from Discord's API, waiting out rate limits and retrying hiccups */
async function apiGet(url: string, query?: Record<string, any>): Promise<any> {
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            const res = await restGet(url, query);
            return res.body;
        } catch (e: any) {
            if (isBroken(e)) throw e;
            const status = e?.status;
            if (status === 429) {
                const wait = Math.ceil((e?.body?.retry_after ?? 5) * 1000) + 250;
                await sleep(wait);
                continue;
            }
            if (status === 403) throw new ApiError("no permission", 403);
            if (status >= 500 || status == null) {
                await sleep(2000 * (attempt + 1));
                continue;
            }
            throw new ApiError(`Request failed (${status}): ${e?.body?.message ?? e}`, status);
        }
    }
    throw new Error("Too many failed attempts, giving up.");
}

async function fetchPage(channelId: string, before?: string): Promise<any[]> {
    try {
        const body = await apiGet(messagesPath(channelId), before ? { limit: 100, before } : { limit: 100 });
        return Array.isArray(body) ? body : [];
    } catch (e: any) {
        if (e?.status === 403) throw new ApiError("No permission to read message history in this channel.", 403);
        throw e;
    }
}

const delay = () => sleep(Math.max(0, settings.store.delayMs));

/** how far back to read: the oldest message id allowed (since last export), whether "Max messages" applies, and which messages to keep */
interface FetchLimits {
    minId?: string;
    noLimit?: boolean;
    /** keep only messages with links (links-only exports) */
    onlyLinks?: boolean;
}

/** what an export keeps of the messages it reads: one person's, and/or only the ones with links */
function keeper(author: { id: string; } | undefined, onlyLinks?: boolean) {
    return (m: any) => (!author || m.author?.id === author.id) && (!onlyLinks || messageLinks(m).length > 0);
}

/** "12 from bob", "12 with links", "12 with links from bob", "12" */
function keptText(n: number, author?: { name: string; }, onlyLinks?: boolean) {
    return `${n.toLocaleString()}${onlyLinks ? " with links" : ""}${author ? ` from ${author.name}` : ""}`;
}

async function fetchAll(channelId: string, state: ExportState, range: DateRange = {}, author?: { id: string; name: string; }, limits: FetchLimits = {}) {
    const all: any[] = [];
    // Pages go newest -> oldest. With a "to" date we start right at it instead of at the newest
    // message (a future "to" just means "start at the newest"), and we stop at the "from" date
    // (or right after the newest message the last export had).
    let before = range.before && range.before.getTime() < Date.now() ? dateToSnowflake(range.before) : undefined;
    const minId = limits.minId ?? (range.after ? dateToSnowflake(range.after) : null);
    const afterId = minId ? BigInt(minId) : null;
    const max = limits.noLimit ? Infinity : settings.store.maxMessages || Infinity;
    const every = Math.max(100, settings.store.progressEvery || 2000);
    let nextReport = every;
    /** false once the start of the chat (or the "from" date) was reached */
    let more = true;
    const keep = keeper(author, limits.onlyLinks);
    const filtered = !!author || !!limits.onlyLinks;

    while (!state.cancelled && all.length < max) {
        const page = await fetchPage(channelId, before);
        if (!page.length) {
            more = false;
            break;
        }
        let reachedStart = false;
        for (const m of page) {
            if (afterId !== null && BigInt(m.id) < afterId) {
                reachedStart = true; // everything after this is older than "from"
                break;
            }
            state.scanned++;
            state.newestId ??= m.id; // pages are newest first
            // Discord can't filter by person (or links), so every message is read and only the wanted ones are kept
            if (keep(m)) all.push(m);
        }
        state.count = all.length;
        before = page[page.length - 1].id;

        if (state.scanned >= nextReport && progressToast(filtered
            ? `Exporting... checked ${state.scanned.toLocaleString()} messages, ${keptText(all.length, author, limits.onlyLinks)} so far`
            : `Exporting... ${all.length.toLocaleString()} messages so far`))
            nextReport = state.scanned + every;
        if (reachedStart || page.length < 100) {
            more = false;
            break;
        }
        await delay();
    }
    // the limit cut it short (not just "the chat happens to be exactly that long")
    if (all.length > max || (all.length === max && more)) state.hitCap = true;
    if (all.length > max) all.length = max;
    return all.reverse(); // oldest first
}

// ---------- all channels of a server ----------
/** channels with their own messages: text, announcement, and the chat inside voice / stage channels */
const MESSAGE_TYPES = new Set([0, 5, 2, 13]);
/** channels that can have threads: text, announcement, forum, media (forum/media only have posts = threads) */
const THREAD_PARENT_TYPES = new Set([0, 5, 15, 16]);
const VOICE_TYPES = new Set([2, 13]);
const THREAD_TYPES = new Set([10, 11, 12]);
const PRIVATE_THREAD = 12;

/** one channel or thread an all-channels export reads */
interface Target {
    id: string;
    /** "general", or "general / thread name" for threads and forum posts */
    name: string;
    type: number;
    parentId?: string;
    /** newest message in it, when Discord says (lets old or empty channels be skipped) */
    lastMessageId?: string | null;
    isThread: boolean;
}

/** what an all-channels export went through, for the notes and the file header */
interface SearchSummary {
    guildId: string;
    guildName: string;
    /** channels + threads that were read */
    searched: Target[];
    /** channels you can't open (no permission), skipped */
    noAccess: number;
    /** channels that failed while reading, with why */
    failed: { target: Target; why: string; }[];
    /** problems listing threads ("#general: ...") */
    threadNotes: string[];
    /** set when "Max messages" cut the export short (only the newest this many were kept) */
    capped?: number;
}

interface MessageGroup {
    target: Target;
    /** oldest first */
    messages: any[];
}

/** channels and threads that were searched but gave nothing */
function emptyTargets(summary: SearchSummary, groups: MessageGroup[]) {
    const skip = new Set([...groups.map(g => g.target.id), ...summary.failed.map(f => f.target.id)]);
    return summary.searched.filter(t => !skip.has(t.id));
}

/** what was left out and why, one line each */
function skippedLines(summary: SearchSummary) {
    const lines: string[] = [];
    if (summary.capped) lines.push(`Stopped at ${summary.capped.toLocaleString()} messages (your "Max messages" setting), so only the newest ones are in here.`);
    if (summary.noAccess) lines.push(`Skipped ${summary.noAccess} channel${summary.noAccess === 1 ? "" : "s"} you can't open.`);
    for (const f of summary.failed) lines.push(`Couldn't read #${f.target.name}: ${f.why}.`);
    for (const n of summary.threadNotes) lines.push(`Threads: ${n}.`);
    return lines;
}

/** snowflakes compared as numbers (longer = bigger) */
function cmpId(a: string, b: string) {
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** newest message id Discord has for a channel; null = it never had messages, undefined = unknown */
function lastIdOf(c: any): string | null | undefined {
    if (c?.lastMessageId !== undefined) return c.lastMessageId;
    return c?.last_message_id;
}

/**
 * Every channel and thread of a server you can read, in the order of the channel list:
 * text, announcement and voice/stage chats, plus the threads and forum posts in them
 * (active ones, and older archived public ones). Private threads are included while
 * active and joined; old private threads are not.
 */
async function findServerTargets(guildId: string, state: ExportState, range: DateRange): Promise<{ targets: Target[]; summary: SearchSummary; }> {
    const guildName = getGuild(guildId)?.name ?? "Unknown server";
    const summary: SearchSummary = { guildId, guildName, searched: [], noAccess: 0, failed: [], threadNotes: [] };
    const channels = guildChannels(guildId);
    if (!channels)
        throw new MissingPartError("ChatExporter can't read the server's channel list on this Vencord/Discord version, so \"all channels\" doesn't work until the plugin is updated. Exporting one channel at a time still works.");

    const readable: any[] = [];
    for (const c of channels) {
        if (!MESSAGE_TYPES.has(c.type) && !THREAD_PARENT_TYPES.has(c.type)) continue; // categories, directories...
        // can't tell (Discord's permission check changed): try it, a "no permission" answer is reported per channel
        if (canRead(c) !== false) readable.push(c);
        else summary.noAccess++;
    }
    // like the channel list: no category first, then by category; text above voice; then by position
    const categoryPos = (c: any) => c.parent_id ? (getChannel(c.parent_id)?.position ?? 0) + 1 : 0;
    readable.sort((a, b) => categoryPos(a) - categoryPos(b)
        || Number(VOICE_TYPES.has(a.type)) - Number(VOICE_TYPES.has(b.type))
        || (a.position ?? 0) - (b.position ?? 0)
        || cmpId(a.id, b.id));
    const readableIds = new Set(readable.map(c => c.id));

    // threads by parent, from everywhere Discord tells us about them
    const threads = new Map<string, Map<string, any>>();
    const joined = new Set<string>();
    const addThread = (t: any) => {
        const parentId = t?.parent_id ?? t?.parentId;
        if (!t?.id || !THREAD_TYPES.has(t.type) || !readableIds.has(parentId)) return;
        if (!threads.has(parentId)) threads.set(parentId, new Map());
        threads.get(parentId)!.set(t.id, t);
    };

    // 1. threads Discord's app already knows (active ones, and private ones you're in)
    for (const c of readable)
        for (const t of loadedThreads(c.id)) {
            addThread(t);
            joined.add(t.id);
        }

    const afterMs = range.after?.getTime();
    const beforeId = range.before ? dateToSnowflake(range.before) : null;
    const parents = readable.filter(c => THREAD_PARENT_TYPES.has(c.type));
    if (parents.length) {
        // 2. the server's active threads
        try {
            const body = await apiGet(`/guilds/${guildId}/threads/active`);
            for (const m of body?.members ?? []) if (m?.id) joined.add(m.id);
            for (const t of body?.threads ?? []) addThread(t);
        } catch (e: any) {
            summary.threadNotes.push(`couldn't get the list of active threads (${e?.message ?? e}), only the ones Discord had loaded were read`);
        }
        await delay();

        // 3. older (archived) public threads and forum posts, channel by channel
        state.channelsTotal = parents.length;
        state.channelsDone = 0;
        for (const c of parents) {
            if (state.cancelled) break;
            let before: string | undefined;
            for (let page = 0; page < 200 && !state.cancelled; page++) {
                let body: any;
                try {
                    body = await apiGet(`/channels/${c.id}/threads/archived/public`, before ? { limit: 100, before } : { limit: 100 });
                } catch (e: any) {
                    summary.threadNotes.push(`#${c.name}: couldn't list old threads (${e?.message ?? e})`);
                    break;
                } finally {
                    await delay();
                }
                const list: any[] = body?.threads ?? [];
                for (const t of list) addThread(t);
                const last = list[list.length - 1];
                const archivedAt = last?.thread_metadata?.archive_timestamp;
                if (!body?.has_more || !archivedAt) break;
                // threads archived before "from" can't have anything newer than that
                if (afterMs !== undefined && Date.parse(archivedAt) < afterMs) break;
                before = archivedAt;
            }
            state.channelsDone++;
            progressToast(`Finding threads... ${state.channelsDone} of ${parents.length} channels`);
        }
    }

    const targets: Target[] = [];
    const afterId = range.after ? dateToSnowflake(range.after) : null;
    for (const c of readable) {
        if (MESSAGE_TYPES.has(c.type))
            targets.push({ id: c.id, name: c.name ?? c.id, type: c.type, lastMessageId: lastIdOf(c), isThread: false });
        const list = [...(threads.get(c.id)?.values() ?? [])].sort((a, b) => cmpId(a.id, b.id));
        for (const t of list) {
            // old private threads you're not in can't be read
            if (t.type === PRIVATE_THREAD && !joined.has(t.id)) continue;
            // started after "to": nothing in range
            if (beforeId && cmpId(t.id, beforeId) >= 0) continue;
            const last = lastIdOf(t);
            if (afterId && last && cmpId(last, afterId) < 0) continue;
            targets.push({ id: t.id, name: `${c.name} / ${t.name ?? t.id}`, type: t.type, parentId: c.id, lastMessageId: last, isThread: true });
        }
    }
    return { targets, summary };
}

interface Cursor {
    target: Target;
    /** the oldest message id this channel may give (null = from the very start) */
    minId: string | null;
    /** fetched but not yet looked at, newest first */
    buf: any[];
    /** the next page starts below this message id */
    before?: string;
    /** at least one page was fetched */
    fetched: boolean;
    /** no more pages */
    done: boolean;
}

/**
 * Reads many channels at once, newest messages first across all of them, so "Max messages" keeps
 * the newest ones of the whole server. A channel is only read once its newest message could still
 * make the cut, so quiet or old channels cost nothing when the limit is reached early.
 */
async function fetchMany(targets: Target[], state: ExportState, summary: SearchSummary, range: DateRange = {}, author?: { id: string; name: string; },
    limits: FetchLimits & { perTarget?: Record<string, string>; } = {}) {
    const max = limits.noLimit ? Infinity : settings.store.maxMessages || Infinity;
    const every = Math.max(100, settings.store.progressEvery || 2000);
    let nextReport = every;
    const kept = new Map<string, any[]>();
    const startBefore = range.before && range.before.getTime() < Date.now() ? dateToSnowflake(range.before) : undefined;
    const baseMin = limits.minId ?? (range.after ? dateToSnowflake(range.after) : null);
    // the oldest message id each channel may give: "from", or right after where the last export ended there
    const minFor = (t: Target) => {
        const own = limits.perTarget?.[t.id];
        if (!own) return baseMin;
        const after = nextId(own);
        return baseMin && cmpId(baseMin, after) > 0 ? baseMin : after;
    };
    state.newestByTarget = new Map();
    const keep = keeper(author, limits.onlyLinks);
    const TOP = "99999999999999999999";
    const min = (a: string, b: string) => cmpId(a, b) <= 0 ? a : b;
    summary.searched = targets;

    // the newest message a channel can still give (an upper bound until its first page is in)
    const bound = (c: Cursor): string => {
        if (c.buf.length) return c.buf[0].id;
        if (c.fetched) return c.before ?? "0";
        return min(c.target.lastMessageId ?? TOP, startBefore ?? TOP);
    };
    const heap: Cursor[] = [];
    const higher = (a: Cursor, b: Cursor) => cmpId(bound(a), bound(b)) > 0;
    const push = (c: Cursor) => {
        heap.push(c);
        for (let i = heap.length - 1; i > 0;) {
            const p = (i - 1) >> 1;
            if (!higher(heap[i], heap[p])) break;
            [heap[i], heap[p]] = [heap[p], heap[i]];
            i = p;
        }
    };
    const pop = () => {
        const top = heap[0];
        const last = heap.pop()!;
        if (heap.length) {
            heap[0] = last;
            for (let i = 0; ;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < heap.length && higher(heap[l], heap[m])) m = l;
                if (r < heap.length && higher(heap[r], heap[m])) m = r;
                if (m === i) break;
                [heap[i], heap[m]] = [heap[m], heap[i]];
                i = m;
            }
        }
        return top;
    };

    state.channelsTotal = targets.length;
    state.channelsDone = 0;
    for (const t of targets) {
        const last = t.lastMessageId;
        const minId = minFor(t);
        // no messages at all, or none after "from" / the last export: nothing to read
        if (last === null || (minId && last && cmpId(last, minId) < 0)) {
            state.channelsDone++;
            continue;
        }
        push({ target: t, minId, buf: [], before: startBefore, fetched: false, done: false });
    }

    while (heap.length && !state.cancelled && state.count < max) {
        const c = pop();
        if (!c.buf.length) {
            if (c.done) {
                state.channelsDone++;
                continue;
            }
            try {
                const page = await fetchPage(c.target.id, c.before);
                if (page.length < 100) c.done = true;
                for (const m of page) {
                    if (c.minId && cmpId(m.id, c.minId) < 0) {
                        c.done = true; // older than "from" / the last export
                        break;
                    }
                    c.buf.push(m);
                }
                if (page.length) c.before = page[page.length - 1].id;
            } catch (e: any) {
                summary.failed.push({ target: c.target, why: e?.status === 403 ? "no permission" : String(e?.message ?? e) });
                c.buf = [];
                c.done = true;
            }
            c.fetched = true;
            await delay();
            if (!c.buf.length && c.done) state.channelsDone++;
            else push(c);
            continue;
        }

        // this channel's newest message is the newest one left anywhere: take it, and the ones
        // after it that are still newer than anything the other channels can give
        const next = heap.length ? bound(heap[0]) : null;
        while (c.buf.length && (next === null || cmpId(c.buf[0].id, next) >= 0) && state.count < max) {
            const m = c.buf.shift();
            state.scanned++;
            // the first one taken from a channel is its newest
            if (!state.newestByTarget.has(c.target.id)) state.newestByTarget.set(c.target.id, m.id);
            // Discord can't filter by person (or links), so every message is read and only the wanted ones are kept
            if (keep(m)) {
                if (!kept.has(c.target.id)) kept.set(c.target.id, []);
                kept.get(c.target.id)!.push(m);
                state.count++;
            }
        }
        if (c.buf.length || !c.done) push(c);
        else state.channelsDone++;

        if (state.scanned >= nextReport && progressToast(`Exporting all channels... checked ${state.scanned.toLocaleString()} messages, ${author || limits.onlyLinks ? keptText(state.count, author, limits.onlyLinks) : `kept ${state.count.toLocaleString()}`} so far (${state.channelsDone} of ${state.channelsTotal} channels done)`))
            nextReport = state.scanned + every;
    }
    // the limit cut it short while channels still had older messages
    if (state.count >= max && heap.length) state.hitCap = true;

    // oldest first within each channel, channels in list order
    const groups: MessageGroup[] = [];
    for (const t of targets) {
        const msgs = kept.get(t.id);
        if (msgs?.length) groups.push({ target: t, messages: msgs.reverse() });
    }
    return groups;
}

// ---------- helpers ----------
function channelTitle(channel: Channel) {
    if (channel.guild_id) {
        const g = getGuild(channel.guild_id);
        return `${g?.name ?? "Server"} - ${channel.name}`;
    }
    if (channel.name) return channel.name;
    const recips = (channel.recipients ?? []).map(id => {
        const u = getUser(id);
        return u?.globalName ?? u?.username ?? id;
    });
    return recips.length ? `DM - ${recips.join(", ")}` : "DM";
}

function safeFileName(s: string) {
    return s.replace(/[\\/:*?"<>|\n\r]+/g, "_").slice(0, 120);
}

const esc = (s: string) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function displayName(author: any) {
    return author?.global_name || author?.username || "Unknown";
}

function avatarUrl(author: any) {
    if (author?.avatar) {
        const ext = author.avatar.startsWith("a_") ? "gif" : "png";
        return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${ext}?size=64`;
    }
    const idx = author?.id ? Number((BigInt(author.id) >> 22n) % 6n) : 0;
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

// same as toLocaleString(), made once
const LOCAL_DATE = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });

function fmtDate(iso: string) {
    return LOCAL_DATE.format(new Date(iso));
}

function fmtSize(n: number) {
    if (n < 1024) return n + " B";
    if (n < 1024 ** 2) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + " MB";
    return (n / 1024 ** 3).toFixed(2) + " GB";
}

/** The files in a message (or, for a forwarded message, the files in what was forwarded) */
function messageFiles(m: any): any[] {
    const own = m.attachments ?? [];
    return own.length ? own : m.message_snapshots?.[0]?.message?.attachments ?? [];
}

/** What an export covers, shown in its header */
interface ExportInfo {
    range: DateRange;
    /** only this person's messages */
    author?: { id: string; name: string; };
    /** attachment id -> its name inside the files zip */
    savedAs?: Map<string, string>;
}

// Basic Discord markdown -> HTML
function renderMarkdown(text: string, msg: any, guildId?: string) {
    if (!text) return "";
    const codeBlocks: string[] = [];
    let s = text.replace(/```(?:([\w+-]+)\n)?([\s\S]*?)```/g, (_, _lang, code) => {
        codeBlocks.push(`<pre class="cb">${esc(code.replace(/^\n/, ""))}</pre>`);
        return `\u0000CB${codeBlocks.length - 1}\u0000`;
    });
    const inline: string[] = [];
    s = s.replace(/`([^`\n]+)`/g, (_, code) => {
        inline.push(`<code>${esc(code)}</code>`);
        return `\u0000IC${inline.length - 1}\u0000`;
    });

    s = esc(s);

    // custom emoji
    s = s.replace(/&lt;(a?):(\w+):(\d+)&gt;/g, (_, a, name, id) =>
        `<img class="emoji" title=":${name}:" alt=":${name}:" src="https://cdn.discordapp.com/emojis/${id}.${a ? "gif" : "png"}?size=48">`);
    // user mentions
    s = s.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => {
        const m = msg.mentions?.find((u: any) => u.id === id);
        const u = m ?? getUser(id);
        return `<span class="mention">@${esc(u ? displayName(u) : id)}</span>`;
    });
    // role mentions
    s = s.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => {
        const r = guildId ? getRole(guildId, id) : null;
        return `<span class="mention">@${esc(r?.name ?? "role")}</span>`;
    });
    // channel mentions
    s = s.replace(/&lt;#(\d+)&gt;/g, (_, id) => {
        const c = getChannel(id);
        return `<span class="mention">#${esc(c?.name ?? id)}</span>`;
    });
    // timestamps
    s = s.replace(/&lt;t:(\d+)(?::\w)?&gt;/g, (_, t) => `<span class="ts">${new Date(+t * 1000).toLocaleString()}</span>`);
    // formatting
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>")
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/__(.+?)__/g, "<u>$1</u>")
        .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1<i>$2</i>")
        .replace(/(^|\W)_(?!\s)(.+?)_(?!\w)/g, "$1<i>$2</i>")
        .replace(/~~(.+?)~~/g, "<s>$1</s>")
        .replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" onclick="this.classList.add(\'shown\')">$1</span>');
    // masked links, then bare links
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    s = s.replace(/(^|[^"'>=])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank">$2</a>');
    // headings / quotes (line based)
    s = s.split("\n").map(line => {
        let m;
        if ((m = line.match(/^(#{1,3}) (.*)$/))) return `<span class="h${m[1].length}">${m[2]}</span>`;
        if ((m = line.match(/^&gt; ?(.*)$/))) return `<span class="quote">${m[1]}</span>`;
        if ((m = line.match(/^-# (.*)$/))) return `<span class="sub">${m[1]}</span>`;
        return line;
    }).join("<br>");

    s = s.replace(/\u0000IC(\d+)\u0000/g, (_, i) => inline[+i]);
    s = s.replace(/\u0000CB(\d+)\u0000/g, (_, i) => codeBlocks[+i]);
    return s;
}

const SYSTEM_TYPES: Record<number, string> = {
    1: "added someone to the group",
    2: "removed someone from the group",
    3: "started a call",
    4: "changed the channel name",
    5: "changed the channel icon",
    6: "pinned a message",
    7: "joined the server",
    8: "boosted the server",
    18: "started a thread",
    46: "poll result"
};

// ---------- HTML ----------
function buildHtml(channel: Channel, messages: any[], info: ExportInfo = { range: {} }) {
    const title = channelTitle(channel);
    const rangeText = (info.author ? ` from ${info.author.name}` : "") + describeRange(info.range, discordLocale());
    return [
        htmlStart(title, `${messages.length.toLocaleString()} messages${rangeText} · exported ${new Date().toLocaleString()} · channel id ${channel.id}`),
        ...htmlMessages(messages, channel.guild_id, info.savedAs),
        HTML_END
    ];
}

/** one file for a whole server: a list of the channels at the top, then one section per channel */
function buildHtmlAll(summary: SearchSummary, groups: MessageGroup[], info: ExportInfo) {
    const total = groups.reduce((n, g) => n + g.messages.length, 0);
    const who = info.author ? ` from ${info.author.name}` : "";
    const sub = `${total.toLocaleString()} messages${who} in ${groups.length} of ${summary.searched.length} channels and threads${describeRange(info.range, discordLocale())} · exported ${new Date().toLocaleString()} · server id ${summary.guildId}`;
    const parts = [htmlStart(`${summary.guildName} - all channels`, sub)];

    let toc = "<section class=\"toc\"><b>Channels in this export</b><br>";
    toc += groups.map(g => `<a href="#c${g.target.id}">#${esc(g.target.name)}</a> <span class="time">(${g.messages.length.toLocaleString()})</span>`).join(" · ");
    const empty = emptyTargets(summary, groups);
    if (empty.length)
        toc += `<details><summary>Also searched, ${summary.capped ? "nothing among the newest messages" : `nothing${esc(who)} found`}: ${empty.length} channels and threads</summary>${empty.map(t => `#${esc(t.name)}`).join(", ")}</details>`;
    for (const line of skippedLines(summary)) toc += `<div class="time">${esc(line)}</div>`;
    parts.push(toc + "</section>");

    for (const g of groups) {
        parts.push(`<h2 class="chan" id="c${g.target.id}">#${esc(g.target.name)} <span>${g.messages.length.toLocaleString()} message${g.messages.length === 1 ? "" : "s"}</span></h2>`);
        parts.push(...htmlMessages(g.messages, summary.guildId, info.savedAs));
    }
    parts.push(HTML_END);
    return parts;
}

const HTML_END = `</main><script>
const q=document.getElementById("search"),msgs=[...document.querySelectorAll(".msg,.sys")];
let t;q.addEventListener("input",()=>{clearTimeout(t);t=setTimeout(()=>{const v=q.value.toLowerCase();
for(const m of msgs)m.classList.toggle("hidden",!!v&&!m.textContent.toLowerCase().includes(v));},200);});
</script></body></html>`;

function htmlStart(title: string, subtitle: string) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;background:#313338;color:#dbdee1;font-family:"gg sans","Noto Sans",Whitney,"Helvetica Neue",Helvetica,Arial,sans-serif;font-size:15px}
header{position:sticky;top:0;background:#2b2d31;padding:12px 20px;border-bottom:1px solid #1f2023;z-index:2}
header h1{margin:0;font-size:18px;color:#f2f3f5}header div{font-size:12px;color:#949ba4}
#search{margin-top:6px;width:100%;max-width:360px;padding:6px 8px;border-radius:4px;border:0;background:#1e1f22;color:#dbdee1}
main{padding:10px 0 40px}
.msg{display:flex;padding:2px 20px 2px 16px;gap:14px}.msg:hover{background:#2e3035}
.msg.first{margin-top:14px}
.av{width:40px;height:40px;border-radius:50%;flex:0 0 40px}
.gut{width:40px;flex:0 0 40px;font-size:11px;color:#949ba4;text-align:right;padding-top:3px;visibility:hidden}
.msg:hover .gut{visibility:visible}
.body{min-width:0;flex:1}
.name{font-weight:600;color:#f2f3f5;margin-right:6px}.time{font-size:12px;color:#949ba4}
.bot{background:#5865f2;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;margin-right:6px;vertical-align:1px}
.content{white-space:normal;word-wrap:break-word;line-height:1.375}
.edited{font-size:10px;color:#949ba4;margin-left:4px}
.mention{background:rgba(88,101,242,.3);color:#c9cdfb;border-radius:3px;padding:0 2px}
code{background:#2b2d31;padding:1px 3px;border-radius:3px;font-size:85%}
pre.cb{background:#2b2d31;border:1px solid #1e1f22;padding:8px;border-radius:4px;white-space:pre-wrap;font-size:13px;margin:4px 0}
.quote{display:block;border-left:4px solid #4e5058;padding-left:10px}
.h1{font-size:1.5em;font-weight:700}.h2{font-size:1.25em;font-weight:700}.h3{font-size:1.1em;font-weight:700}.sub{font-size:12px;color:#949ba4}
.spoiler{background:#1e1f22;color:transparent;border-radius:3px;cursor:pointer}.spoiler.shown{color:inherit}
a{color:#00a8fc;text-decoration:none}a:hover{text-decoration:underline}
.emoji{width:22px;height:22px;vertical-align:bottom}
.att img,.att video{max-width:420px;max-height:350px;border-radius:6px;margin-top:4px;display:block}
.file{display:inline-block;background:#2b2d31;border:1px solid #1e1f22;border-radius:6px;padding:10px;margin-top:4px}
.embed{border-left:4px solid #1e1f22;background:#2b2d31;border-radius:4px;padding:8px 12px;margin-top:4px;max-width:520px}
.embed .et{font-weight:600;color:#f2f3f5}.embed .ed{font-size:14px}.embed img{max-width:100%;border-radius:4px;margin-top:6px}
.embed .ef{font-size:14px;margin-top:4px}.embed .ef b{display:block}
.reply{font-size:13px;color:#b5bac1;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.reply::before{content:"\\21B1  "}
.reacts{margin-top:4px;display:flex;gap:4px;flex-wrap:wrap}.react{background:#2b2d31;border-radius:8px;padding:1px 6px;font-size:13px}
.react img{width:16px;height:16px;vertical-align:-3px}
.sys{color:#949ba4;font-style:italic;padding:4px 20px 4px 70px}
.sticker{width:160px;height:160px}
.saved{font-size:11px;color:#949ba4;margin-top:2px}
.hidden{display:none}
.chan{margin:26px 0 4px;padding:10px 20px 0;border-top:1px solid #3f4147;font-size:17px;color:#f2f3f5}
.chan span{font-size:12px;color:#949ba4;font-weight:400;margin-left:6px}
.toc{padding:8px 20px 4px;font-size:14px;line-height:1.7}.toc details{margin-top:4px;color:#949ba4}.toc summary{cursor:pointer}
</style></head><body>
<header><h1>${esc(title)}</h1><div>${esc(subtitle)}</div>
<input id="search" placeholder="Filter messages..."></header><main id="log">`;
}

/** one channel's messages as HTML, oldest first */
function htmlMessages(messages: any[], guildId: string | undefined, savedAs?: Map<string, string>) {
    const { embedImages } = settings.store;
    const parts: string[] = [];
    let prev: any = null;
    for (const m of messages) {
        if (SYSTEM_TYPES[m.type]) {
            parts.push(`<div class="sys" id="m${m.id}"><b>${esc(displayName(m.author))}</b> ${SYSTEM_TYPES[m.type]} · ${esc(fmtDate(m.timestamp))}</div>`);
            prev = null;
            continue;
        }

        const grouped = prev && prev.author?.id === m.author?.id && !m.referenced_message && m.type !== 19
            && (Date.parse(m.timestamp) - Date.parse(prev.timestamp)) < 7 * 60 * 1000;
        prev = m;

        const d = new Date(m.timestamp);
        let html = `<div class="msg${grouped ? "" : " first"}" id="m${m.id}">`;
        html += grouped
            ? `<div class="gut">${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>`
            : `<img class="av" loading="lazy" src="${avatarUrl(m.author)}">`;
        html += "<div class=\"body\">";

        if (m.referenced_message) {
            const r = m.referenced_message;
            const snippet = (r.content || (r.attachments?.length ? "[attachment]" : "")).slice(0, 120);
            html += `<div class="reply"><a href="#m${r.id}"><b>@${esc(displayName(r.author))}</b></a> ${esc(snippet)}</div>`;
        } else if (m.type === 19) {
            html += "<div class=\"reply\">(original message was deleted)</div>";
        }

        if (!grouped)
            html += `<div><span class="name">${esc(displayName(m.author))}</span>${m.author?.bot ? '<span class="bot">BOT</span>' : ""}<span class="time" title="${esc(m.timestamp)}">${esc(fmtDate(m.timestamp))}</span></div>`;

        let content = renderMarkdown(m.content, m, guildId);
        if (m.message_snapshots?.length) {
            const snap = m.message_snapshots[0].message;
            content += `<div class="quote"><i>Forwarded:</i><br>${renderMarkdown(snap?.content ?? "", snap ?? {}, guildId)}</div>`;
        }
        html += `<div class="content">${content}${m.edited_timestamp ? `<span class="edited" title="${esc(fmtDate(m.edited_timestamp))}">(edited)</span>` : ""}</div>`;

        for (const a of messageFiles(m)) {
            const ct: string = a.content_type ?? "";
            if (embedImages && ct.startsWith("image/"))
                html += `<div class="att"><a href="${esc(a.url)}" target="_blank"><img loading="lazy" src="${esc(a.proxy_url ?? a.url)}" alt="${esc(a.filename)}"></a></div>`;
            else if (embedImages && ct.startsWith("video/"))
                html += `<div class="att"><video controls preload="none" src="${esc(a.url)}"></video></div>`;
            else
                html += `<div class="file">📎 <a href="${esc(a.url)}" target="_blank">${esc(a.filename)}</a> <span class="time">${fmtSize(a.size ?? 0)}</span></div>`;
            const saved = savedAs?.get(a.id);
            if (saved) html += `<div class="saved">saved as ${esc(saved)}</div>`;
        }

        for (const s of m.sticker_items ?? [])
            html += `<div><img class="sticker" loading="lazy" title="${esc(s.name)}" src="https://media.discordapp.net/stickers/${s.id}.png?size=160"></div>`;

        for (const e of m.embeds ?? []) {
            if (e.type === "image" && e.thumbnail) {
                html += `<div class="att"><img loading="lazy" src="${esc(e.thumbnail.proxy_url ?? e.thumbnail.url)}"></div>`;
                continue;
            }
            if (e.type === "gifv" && e.video) {
                html += `<div class="att"><video autoplay loop muted src="${esc(e.video.proxy_url ?? e.video.url)}"></video></div>`;
                continue;
            }
            const color = e.color != null ? `#${e.color.toString(16).padStart(6, "0")}` : "#1e1f22";
            html += `<div class="embed" style="border-left-color:${color}">`;
            if (e.author?.name) html += `<div class="ed"><b>${esc(e.author.name)}</b></div>`;
            if (e.title) html += `<div class="et">${e.url ? `<a href="${esc(e.url)}" target="_blank">${esc(e.title)}</a>` : esc(e.title)}</div>`;
            if (e.description) html += `<div class="ed">${renderMarkdown(e.description, m, guildId)}</div>`;
            for (const f of e.fields ?? []) html += `<div class="ef"><b>${esc(f.name)}</b>${renderMarkdown(f.value, m, guildId)}</div>`;
            const img = e.image ?? e.thumbnail;
            if (img && embedImages) html += `<img loading="lazy" src="${esc(img.proxy_url ?? img.url)}">`;
            if (e.footer?.text) html += `<div class="sub">${esc(e.footer.text)}</div>`;
            html += "</div>";
        }

        if (m.poll) {
            html += `<div class="embed"><div class="et">📊 ${esc(m.poll.question?.text ?? "Poll")}</div>`;
            for (const ans of m.poll.answers ?? []) {
                const count = m.poll.results?.answer_counts?.find((c: any) => c.id === ans.answer_id)?.count ?? 0;
                html += `<div class="ed">• ${esc(ans.poll_media?.text ?? "")} — ${count}</div>`;
            }
            html += "</div>";
        }

        if (m.reactions?.length) {
            html += "<div class=\"reacts\">";
            for (const r of m.reactions) {
                const em = r.emoji.id
                    ? `<img src="https://cdn.discordapp.com/emojis/${r.emoji.id}.${r.emoji.animated ? "gif" : "png"}?size=32" title=":${esc(r.emoji.name)}:">`
                    : esc(r.emoji.name);
                html += `<span class="react">${em} ${r.count}</span>`;
            }
            html += "</div>";
        }

        html += "</div></div>";
        parts.push(html);
    }
    return parts;
}

// ---------- TXT (same layout as the DiscordKit / DiscordChatExporter plain-text export) ----------
const RULE = "==============================================================";

/** "9/15/26, 10:28 AM", the date style DiscordKit uses */
// one formatter for every message (making a new one per date is what made big TXT exports slow)
const DK_DATE = new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit" });

function dkDate(iso: string | number | Date) {
    return DK_DATE.format(new Date(iso)).replace(/[\u202f\u00a0]/g, " ");
}

/** username, or username#1234 for old-style/bot accounts */
function fullName(u: any) {
    if (!u) return "Unknown";
    return u.discriminator && u.discriminator !== "0" ? `${u.username}#${u.discriminator}` : u.username;
}

function recipientNames(channel: Channel) {
    return (channel.recipients ?? []).map(id => {
        const u = getUser(id);
        return u ? (u.globalName || u.username) : id;
    }).join(", ");
}

/** "My Server", or "Direct Messages" for DMs / group DMs */
function guildLabel(channel: Channel) {
    if (!channel.guild_id) return "Direct Messages";
    return getGuild(channel.guild_id)?.name ?? "Unknown server";
}

/** just the channel's own name: "general", "SomeFriend", thread name, ... */
function plainChannelName(channel: Channel) {
    if (channel.guild_id) return channel.name;
    return channel.name || recipientNames(channel) || "DM";
}

/** "📢・announcements / some thread" (parent / name) */
function hierarchicalChannelName(channel: Channel) {
    const own = plainChannelName(channel);
    const parent = getChannel(channel.parent_id);
    return parent?.name ? `${parent.name} / ${own}` : own;
}

const SYSTEM_TEXT: Record<number, (m: any) => string> = {
    1: m => `Added ${m.mentions?.map(fullName).join(", ") || "someone"} to the group.`,
    2: m => m.mentions?.[0]?.id === m.author?.id ? "Left the group." : `Removed ${m.mentions?.map(fullName).join(", ") || "someone"} from the group.`,
    3: () => "Started a call.",
    4: m => `Changed the channel name: ${m.content}`,
    5: () => "Changed the channel icon.",
    6: () => "Pinned a message.",
    7: () => "Joined the server.",
    8: () => "Boosted the server.",
    18: m => `Started a thread: ${m.content}`
};

function stickerUrl(s: any) {
    // format_type 4 = GIF, 3 = Lottie (json); everything else is png/apng
    const ext = s.format_type === 4 ? "gif" : s.format_type === 3 ? "json" : "png";
    return `https://media.discordapp.net/stickers/${s.id}.${ext}`;
}

function buildTxt(channel: Channel, messages: any[], info: ExportInfo = { range: {} }) {
    const { range, author, savedAs } = info;
    const out: string[] = [];
    out.push(`${RULE}\n`);
    out.push(`Guild: ${guildLabel(channel)}\n`);
    out.push(`Channel: ${hierarchicalChannelName(channel)}\n`);
    if ((channel as any).topic) out.push(`Topic: ${(channel as any).topic}\n`);
    // same lines DiscordKit writes for a date range
    if (range.after) out.push(`After: ${dkDate(range.after)}\n`);
    if (range.before) out.push(`Before: ${dkDate(range.before)}\n`);
    if (author) out.push(`Only messages from: ${author.name}\n`);
    out.push(`${RULE}\n\n`);

    for (const m of messages) out.push(txtMessage(m, savedAs));

    out.push(`${RULE}\nExported ${messages.length} message(s)\n${RULE}\n`);
    return out;
}

/** one file for a whole server: the same layout, with a heading before each channel */
function buildTxtAll(summary: SearchSummary, groups: MessageGroup[], info: ExportInfo) {
    const { range, author, savedAs } = info;
    const total = groups.reduce((n, g) => n + g.messages.length, 0);
    const out: string[] = [];
    out.push(`${RULE}\n`);
    out.push(`Guild: ${summary.guildName}\n`);
    out.push(`Channels: all channels and threads you can read (${summary.searched.length} searched, ${groups.length} in this export)\n`);
    if (range.after) out.push(`After: ${dkDate(range.after)}\n`);
    if (range.before) out.push(`Before: ${dkDate(range.before)}\n`);
    if (author) out.push(`Only messages from: ${author.name}\n`);
    out.push(`${RULE}\n\n`);

    for (const g of groups) {
        out.push(`${RULE}\nChannel: ${g.target.name} (${g.messages.length} message(s))\n${RULE}\n\n`);
        for (const m of g.messages) out.push(txtMessage(m, savedAs));
    }

    out.push(`${RULE}\n`);
    const empty = emptyTargets(summary, groups);
    if (empty.length) out.push(`Also searched, ${summary.capped ? "nothing among the newest messages" : "nothing found"}: ${empty.map(t => `#${t.name}`).join(", ")}\n`);
    for (const line of skippedLines(summary)) out.push(`${line}\n`);
    out.push(`Exported ${total} message(s) from ${groups.length} channel(s)\n${RULE}\n`);
    return out;
}

/** one message in the DiscordKit text layout */
function txtMessage(m: any, savedAs?: Map<string, string>) {
    let b = `[${dkDate(m.timestamp)}] ${fullName(m.author)}${m.pinned ? " (pinned)" : ""}\n`;

    let { content } = m;
    const snap = m.message_snapshots?.[0]?.message;
    if (SYSTEM_TEXT[m.type]) content = SYSTEM_TEXT[m.type](m);
    else if (!content && snap?.content) content = snap.content; // forwarded message
    b += `${content ?? ""}\n\n`;

    const attachments = messageFiles(m);
    if (attachments.length) {
        b += "{Attachments}\n";
        for (const a of attachments) {
            b += `${a.url}\n`;
            // the link above stops working after about a day; this is the copy in the files zip
            const saved = savedAs?.get(a.id);
            if (saved) b += `  saved as: ${saved}\n`;
        }
        b += "\n";
    }

    for (const e of m.embeds ?? []) {
        b += "{Embed}\n";
        if (e.author?.name) b += `${e.author.name}\n`;
        if (e.url) b += `${e.url}\n`;
        if (e.title) b += `${e.title}\n`;
        if (e.description) b += `${e.description}\n`;
        for (const f of e.fields ?? []) {
            if (f.name) b += `${f.name}\n`;
            if (f.value) b += `${f.value}\n`;
        }
        if (e.thumbnail) b += `${e.thumbnail.proxy_url ?? e.thumbnail.url}\n`;
        if (e.image) b += `${e.image.proxy_url ?? e.image.url}\n`;
        if (e.footer?.text) b += `${e.footer.text}\n`;
        b += "\n";
    }

    if (m.sticker_items?.length) {
        b += "{Stickers}\n";
        for (const st of m.sticker_items) b += `${stickerUrl(st)}\n`;
        b += "\n";
    }

    if (m.poll) {
        b += "{Poll}\n";
        b += `${m.poll.question?.text ?? ""}\n`;
        for (const ans of m.poll.answers ?? []) {
            const count = m.poll.results?.answer_counts?.find((c: any) => c.id === ans.answer_id)?.count ?? 0;
            b += `- ${ans.poll_media?.text ?? ""} (${count})\n`;
        }
        b += "\n";
    }

    if (m.reactions?.length) {
        b += "{Reactions}\n";
        b += m.reactions.map((r: any) => r.emoji.name + (r.count > 1 ? ` (${r.count})` : "")).join(" ") + "\n";
    }

    return b + "\n";
}

// ---------- links only ----------
const linkCache = new WeakMap<object, string[]>();

/** a message's links (worked out once per message) */
function messageLinks(m: any): string[] {
    let links = linkCache.get(m);
    if (!links) linkCache.set(m, links = linksIn(m));
    return links;
}

/** opens the message in Discord */
const jumpUrl = (guildId: string | null | undefined, channelId: string, messageId: string) =>
    `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;

/** how many links, and the different ones in the order they were first posted */
function linkStats(messages: any[]) {
    const unique = new Set<string>();
    let total = 0;
    for (const m of messages)
        for (const url of messageLinks(m)) {
            total++;
            unique.add(url);
        }
    return { total, unique: [...unique] };
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** all channels' messages in the order they were posted (for "the different links, in the order they were first posted") */
const inPostedOrder = (groups: MessageGroup[]) => groups.flatMap(g => g.messages).sort((a, b) => cmpId(a.id, b.id));

/** "57 links (41 different) in 39 messages" */
function linksSummary(messages: any[]) {
    const { total, unique } = linkStats(messages);
    return `${plural(total, "link")} (${unique.length.toLocaleString()} different) in ${plural(messages.length, "message")}`;
}

/** one message's links in the text layout: who and when, then one link per line */
function txtLinks(m: any) {
    return `[${dkDate(m.timestamp)}] ${fullName(m.author)}\n${messageLinks(m).join("\n")}\n\n`;
}

/** the end of a links TXT: the totals, then every different link once (easy to copy) */
function txtLinksEnd(messages: any[], extra: string[] = []) {
    const { unique } = linkStats(messages);
    return `${RULE}\n${extra.map(l => l + "\n").join("")}${linksSummary(messages)}. All the different ones:\n${unique.join("\n")}\n${RULE}\n`;
}

function txtLinksHeader(info: ExportInfo, lines: string[]) {
    const { range, author } = info;
    const out = [`${RULE}\n`, ...lines.map(l => l + "\n")];
    if (range.after) out.push(`After: ${dkDate(range.after)}\n`);
    if (range.before) out.push(`Before: ${dkDate(range.before)}\n`);
    if (author) out.push(`Only messages from: ${author.name}\n`);
    out.push("Only links: the links people posted (uploaded files aren't included)\n", `${RULE}\n\n`);
    return out;
}

function buildLinksTxt(channel: Channel, messages: any[], info: ExportInfo) {
    const out = txtLinksHeader(info, [`Guild: ${guildLabel(channel)}`, `Channel: ${hierarchicalChannelName(channel)}`]);
    for (const m of messages) out.push(txtLinks(m));
    out.push(txtLinksEnd(messages));
    return out;
}

function buildLinksTxtAll(summary: SearchSummary, groups: MessageGroup[], info: ExportInfo) {
    const out = txtLinksHeader(info, [`Guild: ${summary.guildName}`, `Channels: all channels and threads you can read (${summary.searched.length} searched, ${groups.length} with links)`]);
    for (const g of groups) {
        out.push(`${RULE}\nChannel: ${g.target.name} (${linksSummary(g.messages)})\n${RULE}\n\n`);
        for (const m of g.messages) out.push(txtLinks(m));
    }
    const empty = emptyTargets(summary, groups);
    const extra = empty.length ? [`Also searched, no links found: ${empty.map(t => `#${t.name}`).join(", ")}`] : [];
    out.push(txtLinksEnd(inPostedOrder(groups), [...extra, ...skippedLines(summary)]));
    return out;
}

/** one message's links as a Discord-looking message: who, when, a jump link, then the links */
function htmlLinks(messages: any[], guildId: string | null | undefined, channelId: string) {
    return messages.map(m => `<div class="msg first" id="m${m.id}"><img class="av" src="${esc(avatarUrl(m.author))}" loading="lazy" alt=""><div class="body">`
        + `<span class="name">${esc(displayName(m.author))}</span><span class="time">${esc(fmtDate(m.timestamp))} · <a href="${esc(jumpUrl(guildId, channelId, m.id))}">jump to message</a></span>`
        + `<div class="content">${messageLinks(m).map(u => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`).join("<br>")}</div></div></div>`);
}

/** every different link once, folded away at the top */
function htmlUniqueLinks(messages: any[]) {
    const { unique } = linkStats(messages);
    return `<section class="toc"><details><summary>All ${unique.length.toLocaleString()} different links, in the order they were first posted</summary>`
        + unique.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`).join("<br>") + "</details></section>";
}

function buildLinksHtml(channel: Channel, messages: any[], info: ExportInfo) {
    const who = info.author ? ` from ${info.author.name}` : "";
    const sub = `${linksSummary(messages)}${who}${describeRange(info.range, discordLocale())} · exported ${new Date().toLocaleString()} · channel id ${channel.id}`;
    return [htmlStart(`${channelTitle(channel)} - links`, sub), htmlUniqueLinks(messages), ...htmlLinks(messages, channel.guild_id, channel.id), HTML_END];
}

function buildLinksHtmlAll(summary: SearchSummary, groups: MessageGroup[], info: ExportInfo) {
    const all = inPostedOrder(groups);
    const who = info.author ? ` from ${info.author.name}` : "";
    const sub = `${linksSummary(all)}${who} in ${groups.length} of ${summary.searched.length} channels and threads${describeRange(info.range, discordLocale())} · exported ${new Date().toLocaleString()} · server id ${summary.guildId}`;
    const parts = [htmlStart(`${summary.guildName} - links, all channels`, sub), htmlUniqueLinks(all)];
    let toc = "<section class=\"toc\"><b>Channels with links</b><br>";
    toc += groups.map(g => `<a href="#c${g.target.id}">#${esc(g.target.name)}</a> <span class="time">(${linkStats(g.messages).total.toLocaleString()})</span>`).join(" · ");
    for (const line of skippedLines(summary)) toc += `<div class="time">${esc(line)}</div>`;
    parts.push(toc + "</section>");
    for (const g of groups) {
        parts.push(`<h2 class="chan" id="c${g.target.id}">#${esc(g.target.name)} <span>${esc(linksSummary(g.messages))}</span></h2>`);
        parts.push(...htmlLinks(g.messages, summary.guildId, g.target.id));
    }
    parts.push(HTML_END);
    return parts;
}

/** links as JSON: one entry per link, with who posted it, when, and where */
function jsonLinks(messages: any[], guildId: string | null | undefined, channelId: string, channelName?: string) {
    return messages.flatMap(m => messageLinks(m).map(url => ({
        url,
        ...(channelName !== undefined ? { channelId, channel: channelName } : {}),
        author: { id: m.author?.id ?? null, username: m.author?.username ?? null },
        timestamp: m.timestamp,
        messageId: m.id,
        jumpUrl: jumpUrl(guildId, channelId, m.id)
    })));
}

/** "[ChatExporter] SomeFriend_DirectMessages_20260923_155500" (same pattern as DiscordKit), "..._from someuser_..." when filtered, "..._links_..." for links only */
function exportFileBase(channel: Channel, author?: { name: string; }, links = false) {
    const guild = channel.guild_id ? guildLabel(channel) : "DirectMessages";
    const who = author ? `_from ${author.name}` : "";
    return safeFileName(`[ChatExporter] ${plainChannelName(channel)}_${guild}${who}${links ? "_links" : ""}_${fileStamp()}`);
}

/** "[ChatExporter] All channels_My Server_from someuser_20260924_224500" */
function serverFileBase(guildName: string, author?: { name: string; }, links = false) {
    const who = author ? `_from ${author.name}` : "";
    return safeFileName(`[ChatExporter] All channels_${guildName}${who}${links ? "_links" : ""}_${fileStamp()}`);
}

/** "20260923_155500" */
function fileStamp() {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------- files ----------
interface PlannedFile {
    id: string;
    url: string;
    /** its name inside the zip */
    name: string;
    original: string;
    size: number;
    when: number;
    author: string;
}

/** Every file in the exported messages, oldest first, with the name it gets in the zip. */
function planFiles(messages: any[]) {
    const list: PlannedFile[] = [];
    const savedAs = new Map<string, string>();
    const taken = new Set<string>();
    for (const m of messages) {
        for (const a of messageFiles(m)) {
            if (!a?.url || !a.id || savedAs.has(a.id)) continue; // a forwarded file can show up twice
            const when = Date.parse(m.timestamp) || Date.now();
            const author = m.author?.username ?? "unknown";
            const name = uniqueZipName(zipNameFor(new Date(when), author, a.filename ?? "file"), taken);
            savedAs.set(a.id, name);
            list.push({ id: a.id, url: a.url, name, original: a.filename ?? "file", size: Number(a.size) || 0, when, author });
        }
    }
    return { list, savedAs, totalBytes: list.reduce((s, f) => s + f.size, 0) };
}

/** stop downloading when the drive would have less than this left after the next file */
const FILE_SPACE_MARGIN = 200 * 1024 * 1024;
const PHOTO_EXT = /\.(jpe?g|png|webp|heic|heif|avif)$/i;

/** Downloads the planned files into a zip next to the saved export, and says how it went. */
async function downloadFiles(plan: ReturnType<typeof planFiles>, exportPath: string, state: ExportState, report: (s: string) => void): Promise<void> {
    const native = getNative()!;
    const { list, totalBytes } = plan;
    const start = await native.zipStart(exportPath, totalBytes);
    if (!start.id) {
        const msg = `Couldn't download the files: ${start.error ?? "unknown problem"}. The messages were saved without them.`;
        toast(msg, "failure");
        report(msg);
        if (settings.store.openFolder) native.showInFolder(exportPath);
        return;
    }

    state.phase = "files";
    state.filesTotal = list.length;
    state.filesDone = 0;
    state.zipId = start.id;
    // Discord's sizes are only a guide: the photo files it serves can be several times bigger
    const hasPhotos = list.some(f => PHOTO_EXT.test(f.original));
    const intro = `Downloading ${list.length.toLocaleString()} file${list.length === 1 ? "" : "s"} (about ${fmtSize(totalBytes)}${hasPhotos ? ", photos can end up bigger" : ""}) into a zip next to it...`;
    noteToast(intro);
    report(intro);

    const failed: { file: PlannedFile; why: string; }[] = [];
    let savedCount = 0;
    let savedBytes = 0;
    /** set when something stops all further downloads; goes into the list of missing files */
    let stopReason = "";
    /** the same, for the message at the end */
    let stopNote = "";
    // the zip sits next to the export, so in Downloads unless you picked a folder yourself
    const watchSpace = settings.store.saveLocation !== "ask";

    for (const file of list) {
        if (state.cancelled || stopReason) {
            failed.push({ file, why: stopReason || "not downloaded: you cancelled the export" });
            continue;
        }
        if (watchSpace) {
            // stop while there is still room left, instead of filling the drive to the brim
            const free = await native.freeSpace();
            if (free !== null && free < file.size + FILE_SPACE_MARGIN) {
                stopReason = `not downloaded: the drive is almost full, only ${fmtSize(free)} left`;
                stopNote = ` because the drive is almost full (only ${fmtSize(free)} left)`;
                failed.push({ file, why: stopReason });
                continue;
            }
        }
        const r = await native.zipAddUrl(start.id, file.url, file.name, file.when, file.size);
        if (r.ok) {
            savedCount++;
            savedBytes += r.bytes ?? 0;
        } else if (r.cancelled) {
            failed.push({ file, why: "not downloaded: you cancelled the export" });
        } else {
            failed.push({ file, why: r.error ?? "unknown problem" });
            if (r.fatal) {
                stopReason = `not downloaded: ${r.error ?? "the zip stopped working"}`;
                stopNote = ` (downloading stopped: ${r.error ?? "the zip stopped working"})`;
            }
        }
        state.filesDone++;
        progressToast(`Downloading files... ${state.filesDone.toLocaleString()} of ${list.length.toLocaleString()} (${fmtSize(savedBytes)})`);
    }

    // a list of what's missing and why, inside the zip (skipped if you cancelled before anything was saved)
    let listSaved = false;
    if (failed.length && savedCount > 0) {
        const lines = failed.map(({ file, why }) =>
            `${file.name}\n  original name: ${file.original}\n  sent by ${file.author} on ${new Date(file.when).toLocaleString()}\n  why: ${why}\n  link: ${file.url}\n`);
        const added = await native.zipAddText(start.id, "_files that could not be downloaded.txt",
            `${failed.length} file(s) from this export could not be saved into the zip:\n\n${lines.join("\n")}`, Date.now());
        listSaved = !!added.ok;
    }

    const fin = await native.zipFinish(start.id, settings.store.openFolder);
    state.zipId = undefined;
    const zips = fin.files ?? [];

    let msg: string;
    if (!zips.length || savedCount === 0) {
        const why = fin.error ?? failed[0]?.why.replace(/^not downloaded: /, "");
        msg = state.cancelled
            ? "File downloads cancelled, no files were saved (the messages are saved)."
            : `None of the ${list.length.toLocaleString()} files could be downloaded${why ? ` (${why})` : ""}. The messages are saved.`;
        if (settings.store.openFolder) native.showInFolder(exportPath);
    } else {
        const where = zips.length === 1 ? `\`${zips[0].shownAs}\`` : `\`${zips[0].shownAs}\` and ${zips.length - 1} more part${zips.length > 2 ? "s" : ""} next to it`;
        msg = `Saved ${savedCount.toLocaleString()} of ${list.length.toLocaleString()} files (${fmtSize(savedBytes)}) to ${where}.`;
        const missing = failed.length;
        if (missing) {
            msg += ` ${missing.toLocaleString()} ${missing === 1 ? "wasn't" : "weren't"} saved${state.cancelled ? " because you cancelled" : stopNote}`;
            msg += listSaved ? ", the list is inside the zip." : ".";
        }
    }
    toast(msg.replace(/`/g, ""), savedCount ? "success" : "failure");
    report(msg);
}

// ---------- save ----------
type Native = PluginNative<typeof import("./native")>;

/** the desktop-side saver from native.ts; missing on web builds */
function getNative(): Native | undefined {
    try {
        return (VencordNative as any)?.pluginHelpers?.ChatExporter as Native | undefined;
    } catch {
        return undefined;
    }
}

/**
 * Saves the export. shownAs says where it went, e.g. "Downloads\[ChatExporter] x.txt";
 * path is the full path when the desktop part saved it. null if the "Save as" window was cancelled.
 */
async function save(parts: string[], filename: string, mime: string, openFolder: boolean): Promise<{ shownAs: string; path?: string; } | null> {
    const blob = new Blob(parts, { type: mime });

    // Discord desktop: write it ourselves (no Save window unless the setting asks for one)
    const native = getNative();
    if (native?.saveExport) {
        const data = new Uint8Array(await blob.arrayBuffer());
        const result = await native.saveExport(filename, data, settings.store.saveLocation === "ask", openFolder);
        if (result.error) throw new Error(result.error);
        if (result.cancelled) return null;
        return { shownAs: result.shownAs ?? result.path ?? filename, path: result.path };
    }

    // fallbacks for builds without the desktop part
    const discordNative = (window as any).DiscordNative;
    if (isDesktopApp() && discordNative?.fileManager?.saveWithDialog) {
        // Discord's own Save window only accepts plain names: letters, numbers, - _ .
        await discordNative.fileManager.saveWithDialog(new Uint8Array(await blob.arrayBuffer()), filename.replace(/[^A-Za-z0-9._-]+/g, "_"));
        return { shownAs: "the folder you picked in the Save window" };
    }
    browserDownload(new File([blob], filename, { type: mime }));
    return { shownAs: "your browser's downloads" };
}

// ---------- main ----------
interface ExportOptions {
    format?: string;
    /** started with /exportchat: progress notes also go into the chat */
    fromCommand?: boolean;
    /** the channel /exportchat was typed in (where its notes go) */
    reportTo?: string;
    range?: DateRange;
    /** only this person's messages */
    author?: { id: string; name: string; };
    /** download the files into a zip (default: the plugin setting) */
    files?: boolean;
    /** only what's newer than where this earlier export ended (all of it: "Max messages" doesn't apply) */
    since?: ExportMark;
    /** that earlier export only had this person's messages (this one is for everyone or someone else) */
    sinceOnlyFrom?: string;
    /** just the links people posted: reads everything ("Max messages" doesn't apply), no files zip */
    links?: boolean;
}

/** keeps free space for the zip on top of the files themselves */
const SPACE_MARGIN = 300 * 1024 * 1024;

const newState = (): ExportState => ({ cancelled: false, count: 0, scanned: 0, phase: "messages", filesDone: 0, filesTotal: 0 });

/** toasts vanish quickly, so /exportchat also gets notes in the chat (only you can see them) */
function reporter(opts: ExportOptions, fallbackChannelId?: string) {
    const to = opts.reportTo ?? fallbackChannelId;
    return (content: string) => {
        if (opts.fromCommand && to) botMessage(to, content);
    };
}

function capNote(n: number) {
    return `Stopped at ${n.toLocaleString()} messages (your "Max messages" setting), so these are the newest ${n.toLocaleString()}. Set it to 0 in the plugin settings for everything.`;
}

/** the export file in the chosen format */
type BuildFile = (fmt: string, info: ExportInfo) => { parts: string[]; ext: string; mime: string; };

/**
 * Everything after the messages are in: plan the files, save the export, download the files.
 * messages = every exported message in file order (the zip names follow it). what = "12 messages".
 */
async function saveEverything(state: ExportState, opts: ExportOptions, report: (s: string) => void, messages: any[], base: string, what: string, build: BuildFile): Promise<{ shownAs: string; } | null> {
    const fmt = opts.format || settings.store.format;
    noteToast(`${state.cancelled ? "Cancelled — saving" : "Fetched"} ${what}, building file...`);

    // files: only when wanted, not cancelled, and the desktop part is there to download them
    const native = getNative();
    const wantFiles = (opts.files ?? settings.store.saveFiles) && !state.cancelled;
    let plan = wantFiles ? planFiles(messages) : null;
    if (plan && !plan.list.length) plan = null;
    if (plan && !native?.zipStart) {
        report("Downloading files only works in the Discord desktop app, so only the messages are saved.");
        plan = null;
    }
    if (plan && native && settings.store.saveLocation !== "ask") {
        const free = await native.freeSpace();
        if (free !== null && free < plan.totalBytes + SPACE_MARGIN) {
            const msg = `Not enough free space for the files: they need about ${fmtSize(plan.totalBytes)}, but only ${fmtSize(free)} is free. Saving only the messages.`;
            toast(msg, "failure");
            report(msg);
            plan = null;
        }
    }
    const info: ExportInfo = { range: opts.range ?? {}, author: opts.author, savedAs: plan?.savedAs };
    if (fmt === "json" && plan) for (const m of messages) for (const a of messageFiles(m)) a.saved_as = plan.savedAs.get(a.id) ?? null;
    const file = build(fmt, info);
    // when a zip follows, the folder is opened once at the very end instead
    const saved = await save(file.parts, base + file.ext, file.mime, settings.store.openFolder && !plan);

    if (saved === null) {
        toast("Export cancelled, nothing was saved.");
        report("Export cancelled, nothing was saved.");
        return null;
    }
    toast(`Saved ${what} to ${saved.shownAs}`, "success");
    report(`Saved ${what} to \`${saved.shownAs}\``);

    if (plan && saved.path) await downloadFiles(plan, saved.path, state, report);
    return saved;
}

const UPDATE_HINT = "This usually means a Vencord or Discord update changed something ChatExporter uses, so the plugin needs an update (github.com/Adamko-10/vencord-chat-exporter).";

async function exportFailed(e: any, state: ExportState, report: (s: string) => void) {
    console.error("[ChatExporter]", e);
    const why = e instanceof MissingPartError ? e.message
        : isBroken(e) ? `${e.message}. ${UPDATE_HINT}`
            : e?.message ?? String(e);
    toast(`Export failed: ${why}`, "failure");
    report(`Export failed: ${why}`);
    const native = getNative();
    if (state.zipId && native) {
        // don't leave a half-written zip open
        await native.zipFinish(state.zipId, false).catch(() => { });
        state.zipId = undefined;
    }
}

async function exportChannel(channel: Channel, opts: ExportOptions = {}) {
    if (running.has(channel.id)) return;
    const range = opts.range ?? {};
    const { author, since, links = false } = opts;
    const state = newState();
    running.set(channel.id, state);
    const startedAt = Date.now();
    const who = author ? ` (only messages from ${author.name})` : "";
    const what = since ? ` since ${lastExport(opts)}` : describeRange(range, discordLocale());
    noteToast(`Starting export of ${links ? "the links in " : ""}${channelTitle(channel)}${who}${what}... (${opts.fromCommand ? "run /exportchat again" : "right-click the chat again"} to cancel)`);
    const report = reporter(opts, channel.id);

    try {
        // links only: every message is read ("Max messages" doesn't apply), the ones with links are kept
        const messages = await fetchAll(channel.id, state, range, author, { minId: since && nextId(since.upToId), noLimit: !!since || links, onlyLinks: links });
        // someone Discord hadn't loaded yet (left the server...) only had their id so far
        if (author && author.name === author.id && messages[0]?.author?.username) author.name = messages[0].author.username;
        if (!messages.length) {
            const where = range.after || range.before ? " in that date range" : "";
            const from = author ? ` from ${author.name}` : "";
            const why = state.cancelled ? "Export cancelled before any messages were found, nothing was saved."
                : links ? (since ? `No new links${from} since ${lastExport(opts)}.` : `No links${from}${where || " in this chat"} (looked through ${plural(state.scanned, "message")}).`)
                    : since ? `Nothing new${from} since ${lastExport(opts)}.`
                        : author ? `No messages from ${author.name}${where} (looked through ${state.scanned.toLocaleString()}).`
                            : where ? "No messages in that date range." : "No messages found to export.";
            // "nothing new" / "no links" is an answer, not an error
            toast(why, (since || links) && !state.cancelled ? "message" : "failure");
            report(why);
            return;
        }
        if (state.hitCap) {
            noteToast(capNote(messages.length));
            report(capNote(messages.length));
        }
        const { total, unique } = links ? linkStats(messages) : { total: 0, unique: [] };
        const savedWhat = links
            ? `${plural(total, since ? "new link" : "link")} from ${plural(messages.length, "message")}`
            : `${messages.length.toLocaleString()}${since ? " new" : ""} message${messages.length === 1 ? "" : "s"}`;
        // a links export is just the list: no files zip
        const saved = await saveEverything(state, links ? { ...opts, files: false } : opts, report, messages, exportFileBase(channel, author, links), savedWhat, (fmt, info) => {
            if (links) {
                if (fmt === "json") {
                    const json = JSON.stringify({
                        channel: { id: channel.id, name: channelTitle(channel), guild_id: channel.guild_id ?? null, type: channel.type },
                        exportedAt: new Date().toISOString(),
                        range: { after: range.after?.toISOString() ?? null, before: range.before?.toISOString() ?? null },
                        onlyFrom: author ? { id: author.id, username: author.name } : null,
                        onlyLinks: true,
                        messagesWithLinks: messages.length,
                        linkCount: total,
                        differentLinks: unique,
                        links: jsonLinks(messages, channel.guild_id, channel.id)
                    }, null, 2);
                    return { parts: [json], ext: ".json", mime: "application/json" };
                }
                if (fmt === "txt") return { parts: buildLinksTxt(channel, messages, info), ext: ".txt", mime: "text/plain" };
                return { parts: buildLinksHtml(channel, messages, info), ext: ".html", mime: "text/html" };
            }
            if (fmt === "json") {
                const json = JSON.stringify({
                    channel: { id: channel.id, name: channelTitle(channel), guild_id: channel.guild_id ?? null, type: channel.type },
                    exportedAt: new Date().toISOString(),
                    range: { after: range.after?.toISOString() ?? null, before: range.before?.toISOString() ?? null },
                    onlyFrom: author ? { id: author.id, username: author.name } : null,
                    messageCount: messages.length,
                    messages
                }, null, 2);
                return { parts: [json], ext: ".json", mime: "application/json" };
            }
            if (fmt === "txt") return { parts: buildTxt(channel, messages, info), ext: ".txt", mime: "text/plain" };
            return { parts: buildHtml(channel, messages, info), ext: ".html", mime: "text/html" };
        });
        // the next "since last export" carries on right after the newest message looked at
        if (saved && state.newestId)
            await rememberExport(markKey(channel.id, author, links), { upToId: state.newestId, at: startedAt, file: saved.shownAs, count: messages.length, name: author?.name });
    } catch (e: any) {
        await exportFailed(e, state, report);
    } finally {
        running.delete(channel.id);
    }
}

/** every channel and thread of a server you can read, into one file (and one zip) */
async function exportServer(guildId: string, opts: ExportOptions = {}) {
    const key = guildKey(guildId);
    if (running.has(key)) return;
    const range = opts.range ?? {};
    const { author, since, links = false } = opts;
    const state = newState();
    running.set(key, state);
    const startedAt = Date.now();
    const guildName = getGuild(guildId)?.name ?? "this server";
    const who = author ? ` (only messages from ${author.name})` : "";
    const what = since ? ` since ${lastExport(opts, "all-channels ")}` : describeRange(range, discordLocale());
    noteToast(`Starting export of ${links ? "the links in " : ""}all channels in ${guildName}${who}${what}... (${opts.fromCommand ? "run /exportchat again" : "right-click the server again"} to cancel)`);
    const report = reporter(opts);

    try {
        const { targets, summary } = await findServerTargets(guildId, state, range);
        if (!state.cancelled)
            report(`Going through ${targets.length.toLocaleString()} channels and threads${summary.noAccess ? ` (skipping ${summary.noAccess} you can't open)` : ""}...`);
        const groups = await fetchMany(targets, state, summary, range, author,
            { minId: since && nextId(since.upToId), perTarget: since?.channels, noLimit: !!since || links, onlyLinks: links });
        const messages = groups.flatMap(g => g.messages);
        if (author && author.name === author.id && messages[0]?.author?.username) author.name = messages[0].author.username;
        if (state.hitCap) summary.capped = messages.length;
        const notes = skippedLines(summary);
        const inRange = range.after || range.before ? " in that date range" : "";
        const searched = `${summary.searched.length.toLocaleString()} channels and threads`;
        const from = author ? ` from ${author.name}` : "";

        if (!messages.length) {
            const why = state.cancelled ? "Export cancelled before any messages were found, nothing was saved."
                : links ? `No ${since ? "new " : ""}links${from} in any of the ${searched}${since ? ` since ${lastExport(opts, "all-channels ")}` : inRange}${since ? "" : ` (looked through ${plural(state.scanned, "message")})`}.`
                    : since ? `Nothing new${from} in any of the ${searched} since ${lastExport(opts, "all-channels ")}.`
                        : author ? `No messages from ${author.name}${inRange} in any of the ${searched} (looked through ${state.scanned.toLocaleString()}).`
                            : `No messages${inRange} in any of the ${searched}.`;
            toast(why, (since || links) && !state.cancelled ? "message" : "failure");
            report(state.cancelled ? why : [why, ...notes].join(" "));
            return;
        }
        // say what was searched, so it's clear what "all channels" covered
        const newWhen = since ? ` since your last ${links ? "links " : ""}export` : inRange;
        const had = links ? `links${from}` : author ? `messages from ${author.name}` : "messages";
        report([`Searched ${searched}, ${groups.length} had ${since ? "new " : ""}${had}${newWhen}.`, ...notes].join(" "));
        if (state.hitCap) noteToast(capNote(messages.length));

        const n = messages.length;
        const { total, unique } = links ? linkStats(inPostedOrder(groups)) : { total: 0, unique: [] };
        const inChannels = `from ${plural(groups.length, "channel")}`;
        const savedWhat = links
            ? `${plural(total, since ? "new link" : "link")} ${inChannels}`
            : `${n.toLocaleString()}${since ? " new" : ""} message${n === 1 ? "" : "s"} ${inChannels}`;
        // a links export is just the list: no files zip
        const saved = await saveEverything(state, links ? { ...opts, files: false } : opts, report, messages, serverFileBase(summary.guildName, author, links), savedWhat, (fmt, info) => {
            if (links) {
                if (fmt === "json") {
                    const json = JSON.stringify({
                        guild: { id: guildId, name: summary.guildName },
                        scope: "all channels and threads you can read",
                        exportedAt: new Date().toISOString(),
                        range: { after: range.after?.toISOString() ?? null, before: range.before?.toISOString() ?? null },
                        onlyFrom: author ? { id: author.id, username: author.name } : null,
                        onlyLinks: true,
                        channelsSearched: summary.searched.length,
                        messagesWithLinks: n,
                        linkCount: total,
                        differentLinks: unique,
                        notes,
                        links: groups.flatMap(g => jsonLinks(g.messages, guildId, g.target.id, g.target.name))
                    }, null, 2);
                    return { parts: [json], ext: ".json", mime: "application/json" };
                }
                if (fmt === "txt") return { parts: buildLinksTxtAll(summary, groups, info), ext: ".txt", mime: "text/plain" };
                return { parts: buildLinksHtmlAll(summary, groups, info), ext: ".html", mime: "text/html" };
            }
            if (fmt === "json") {
                const json = JSON.stringify({
                    guild: { id: guildId, name: summary.guildName },
                    scope: "all channels and threads you can read",
                    exportedAt: new Date().toISOString(),
                    range: { after: range.after?.toISOString() ?? null, before: range.before?.toISOString() ?? null },
                    onlyFrom: author ? { id: author.id, username: author.name } : null,
                    channelsSearched: summary.searched.length,
                    messageCount: n,
                    notes,
                    channels: groups.map(g => ({
                        id: g.target.id,
                        name: g.target.name,
                        type: g.target.type,
                        parent_id: g.target.parentId ?? null,
                        messageCount: g.messages.length,
                        messages: g.messages
                    }))
                }, null, 2);
                return { parts: [json], ext: ".json", mime: "application/json" };
            }
            if (fmt === "txt") return { parts: buildTxtAll(summary, groups, info), ext: ".txt", mime: "text/plain" };
            return { parts: buildHtmlAll(summary, groups, info), ext: ".html", mime: "text/html" };
        });
        if (saved) {
            // Everything that existed when this started was looked at (channels are read one after another,
            // so a single "newest message" could skip a quiet channel's later ones). Channels read later
            // than that, with newer messages already in this export, remember their own point.
            const until = Math.min(startedAt, range.before?.getTime() ?? Infinity);
            const upToId = prevId(dateToSnowflake(new Date(until)));
            const channels: Record<string, string> = {};
            for (const [id, newest] of state.newestByTarget ?? []) if (cmpId(newest, upToId) > 0) channels[id] = newest;
            await rememberExport(markKey(key, author, links), { upToId, channels, at: startedAt, file: saved.shownAs, count: n, name: author?.name });
        }
    } catch (e: any) {
        await exportFailed(e, state, report);
    } finally {
        running.delete(key);
    }
}

function cancelLabel(state: ExportState) {
    if (state.phase === "files") return `Cancel export (files ${state.filesDone.toLocaleString()} of ${state.filesTotal.toLocaleString()})`;
    const channels = state.channelsTotal ? `, ${state.channelsDone ?? 0} of ${state.channelsTotal} channels` : "";
    if (state.scanned > state.count) return `Cancel export (${state.count.toLocaleString()} found, ${state.scanned.toLocaleString()} checked${channels})`;
    return `Cancel export (${state.count.toLocaleString()} fetched${channels})`;
}

type MenuParts = NonNullable<ReturnType<typeof menuParts>>;

/** "Export Chat", plus "Export New Messages" once this chat was exported before (or "Cancel export" while one runs) */
function makeItems(M: MenuParts, channel?: Channel) {
    if (!channel) return [];
    const state = running.get(channel.id);
    if (state)
        return [
            <M.MenuItem
                key="vc-chat-export"
                id="vc-chat-export"
                label={cancelLabel(state)}
                color="danger"
                action={() => cancelExport(state)}
            />
        ];
    const items = [
        <M.MenuItem
            key="vc-chat-export"
            id="vc-chat-export"
            label="Export Chat"
            action={() => exportChannel(channel, {})}
        />
    ];
    const found = findMark(channel.id);
    if (found)
        items.push(
            <M.MenuItem
                key="vc-chat-export-new"
                id="vc-chat-export-new"
                label={`Export New Messages (since ${shortWhen(found.mark.at)})`}
                action={() => exportChannel(channel, newSince(found))}
            />
        );
    return items;
}

// if Discord's menu parts changed, the items are just left out (/exportchat still works)
const channelPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    const M = menuParts();
    if (!M) return;
    const items = makeItems(M, channel);
    if (items.length) children.push(<M.MenuSeparator />, ...items);
};

const userPatch: NavContextMenuPatchCallback = (children, { user, channel }: { user?: User; channel?: Channel; }) => {
    const M = menuParts();
    if (!M) return;
    // Only for DMs: use the DM channel with that user
    let dm = channel && !channel.guild_id && channel.type === 1 ? channel : undefined;
    if (!dm && user) dm = getChannel(dmChannelId(user.id));
    if (!dm) return;
    const items = makeItems(M, dm);
    if (items.length) children.push(<M.MenuSeparator />, ...items);
};

const guildPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: { id: string; }; }) => {
    const M = menuParts();
    if (!M || !guild?.id) return;
    const key = guildKey(guild.id);
    const state = running.get(key);
    if (state) {
        children.push(<M.MenuSeparator />, <M.MenuItem id="vc-chat-export-server" label={cancelLabel(state)} color="danger" action={() => cancelExport(state)} />);
        return;
    }
    children.push(<M.MenuSeparator />, <M.MenuItem id="vc-chat-export-server" label="Export All Channels" action={() => exportServer(guild.id, {})} />);
    const found = findMark(key);
    if (found)
        children.push(
            <M.MenuItem
                id="vc-chat-export-server-new"
                label={`Export New Messages, All Channels (since ${shortWhen(found.mark.at)})`}
                action={() => exportServer(guild.id, newSince(found))}
            />
        );
};

export default definePlugin({
    name: "ChatExporter",
    description: "Export the full history of any channel, DM, group DM or thread, or every channel of a server, to TXT/HTML/JSON, no message limit, plus a .zip of the files people sent. Right-click a chat → Export Chat, right-click a server → Export All Channels, or type /exportchat (dates, one person, all channels, just the links, or just what's new since your last export). Saved to your Downloads folder.",
    authors: [{ name: "Adamko-10", id: 0n }, { name: "Claude", id: 0n }],
    // on automatically after a (re)build, so it never silently sits disabled
    enabledByDefault: true,
    settings,

    commands: [
        {
            name: "exportchat",
            description: "Export this chat, or every channel of this server. Run again to cancel a running export.",
            inputType: BUILT_IN_COMMAND,
            options: [
                {
                    name: "from",
                    description: "Start, e.g. 2026-09-15, 15.09.2026, 15 sep, yesterday, 7d (7 days ago). Empty = first message",
                    type: OptionKind.STRING,
                    required: false
                },
                {
                    name: "to",
                    description: "End, that whole day included, e.g. 2026-09-22, 22.09, today. Empty = now",
                    type: OptionKind.STRING,
                    required: false
                },
                {
                    name: "since_last",
                    description: "True = everything new since your last export of this (all of it, Max messages doesn't apply)",
                    type: OptionKind.BOOLEAN,
                    required: false
                },
                {
                    name: "user",
                    description: "Only this person's messages (empty = everyone)",
                    type: OptionKind.USER,
                    required: false
                },
                {
                    name: "channels",
                    description: "This channel (default) or every channel and thread in this server you can read",
                    type: OptionKind.STRING,
                    required: false,
                    choices: [
                        { name: "this channel", value: "this", label: "this channel" },
                        { name: "all channels in this server", value: "all", label: "all channels in this server" }
                    ]
                },
                {
                    name: "links",
                    description: "True = only a list of the links people posted (whole chat, Max messages doesn't apply)",
                    type: OptionKind.BOOLEAN,
                    required: false
                },
                {
                    name: "files",
                    description: "Download the files people sent into a .zip (default: your plugin setting, normally yes)",
                    type: OptionKind.BOOLEAN,
                    required: false
                },
                {
                    name: "format",
                    description: "txt, html or json (default: your plugin setting, normally txt)",
                    type: OptionKind.STRING,
                    required: false,
                    choices: [
                        { name: "html", value: "html", label: "html" },
                        { name: "txt", value: "txt", label: "txt" },
                        { name: "json", value: "json", label: "json" }
                    ]
                }
            ],
            async execute(args, ctx) {
                const { channel } = ctx;
                // running /exportchat again cancels this chat's export, or this server's all-channels export
                const serverState = channel.guild_id ? running.get(guildKey(channel.guild_id)) : undefined;
                const state = running.get(channel.id) ?? serverState;
                if (state) {
                    cancelExport(state);
                    const which = state === serverState ? "the all-channels export" : "export";
                    botMessage(channel.id, state.phase === "files"
                        ? `Cancelling: stopping the file downloads (${state.filesDone.toLocaleString()} of ${state.filesTotal.toLocaleString()} done, keeping those)...`
                        : `Cancelling ${which} (${state.count.toLocaleString()} messages so far, saving those)...`);
                    return;
                }
                // what a Vencord or Discord update may have changed: stop if it's essential, otherwise say what's affected
                const missing = checkParts(!!getNative()).filter(p => !p.ok);
                const gone = missing.find(p => p.essential);
                if (gone) {
                    botMessage(channel.id, `ChatExporter can't export right now: ${gone.what} changed in a Vencord or Discord update, so ${gone.without}. The plugin needs an update (github.com/Adamko-10/vencord-chat-exporter).`);
                    return;
                }
                const headsUp = missing.length ? ` Heads-up, a Vencord or Discord update changed some things ChatExporter uses: ${missing.map(p => p.without).join("; ")}.` : "";
                const allChannels = option<string>(args, "channels", "this") === "all";
                if (allChannels && !channel.guild_id) {
                    botMessage(channel.id, "\"All channels\" only works in a server. A DM or group DM is just this one chat, so leave `channels` empty.");
                    return;
                }
                const fmt = option(args, "format", "") as string;
                const locale = discordLocale();
                const fromText = String(option(args, "from", "") ?? "");
                const sinceLast = option<boolean>(args, "since_last", false) === true;
                if (sinceLast && fromText.trim()) {
                    botMessage(channel.id, "Use either `from` or `since_last`, not both: since_last already starts right after your last export.");
                    return;
                }
                const parsed = buildRange(fromText, String(option(args, "to", "") ?? ""), new Date(), locale);
                if ("error" in parsed) {
                    botMessage(channel.id, parsed.error);
                    return;
                }
                const userId = String(option(args, "user", "") ?? "").replace(/\D/g, "");
                const author = userId ? { id: userId, name: getUser(userId)?.username ?? userId } : undefined;
                const files = option<boolean>(args, "files");
                const links = option<boolean>(args, "links", false) === true;
                if (links && files === true) {
                    botMessage(channel.id, "`links: True` only saves the list of links, so it doesn't download any files. Leave `files` empty, or do a normal export for the files.");
                    return;
                }

                // since_last: carry on right after where the latest export here ended (see findMark); links exports have their own
                let since: ExportMark | undefined;
                let sinceOnlyFrom: string | undefined;
                if (sinceLast) {
                    await loadMarks();
                    const found = findMark(allChannels ? guildKey(channel.guild_id) : channel.id, author, links);
                    if (!found) {
                        botMessage(channel.id, noMarkMessage(allChannels, links));
                        return;
                    }
                    since = found.mark;
                    sinceOnlyFrom = found.onlyFrom;
                    // shown in the notes and the file header ("After: ..."); the exact cut is the message id
                    parsed.range.after = snowflakeToDate(since.upToId);
                }

                // say how everything was understood, so a misread 3/9 is easy to spot and cancel
                const who = author ? links ? ` posted by ${author.name}` : ` (only messages from ${author.name})` : "";
                const opts: ExportOptions = { format: fmt, fromCommand: true, reportTo: channel.id, range: parsed.range, author, files: typeof files === "boolean" ? files : undefined, since, sinceOnlyFrom, links };
                const max = settings.store.maxMessages;
                const limit = !max || since ? ""
                    : links ? " Every message is read to find the links, so your \"Max messages\" setting doesn't apply."
                        : ` Stops at ${max.toLocaleString()} messages (your "Max messages" setting), keeping the newest.`;
                const what = describeRange(parsed.range, locale);
                // "since your last export (Thu, 24 Sept 2026, 22:38, `Downloads\...html`)", plus whose messages it had if only one other person's
                const lastOne = since && `since your last ${allChannels ? "all-channels " : ""}${links ? "links " : ""}export (${niceDate(new Date(since.at), locale)}${since.file ? `, \`${since.file}\`` : ""}`
                    + `${sinceOnlyFrom ? `, which only had ${sinceOnlyFrom}'s messages` : ""})`
                    + (parsed.range.before ? ` up to ${niceDate(new Date(parsed.range.before.getTime() - 1), locale)}` : "");
                if (allChannels) {
                    const server = getGuild(channel.guild_id)?.name ?? "this server";
                    const where = `every channel and thread you can read in ${server}${who}`;
                    const scopeText = links
                        ? since ? `the new links in ${where} ${lastOne}` : `the links in ${where}${what}`
                        : since ? `everything new in ${where} ${lastOne}` : `${where}${what}`;
                    botMessage(channel.id, `Export started: ${scopeText}. Big servers take a while, it has to read each channel.${limit} Run /exportchat again to cancel.${headsUp}`);
                    exportServer(channel.guild_id, opts);
                    return;
                }
                const scopeText = links
                    ? `: the ${since ? `new links${who} ${lastOne}` : `links${who}${what || " in the whole chat"}`}`
                    : since ? `${who}: everything new ${lastOne}` : `${who}${what || (author ? "" : " (the whole chat)")}`;
                botMessage(channel.id, `Export started${scopeText}.${limit} Run /exportchat again to cancel.${headsUp}`);
                exportChannel(channel, opts);
            }
        }
    ],

    contextMenus: {
        "channel-context": channelPatch,
        "thread-context": channelPatch,
        "gdm-context": channelPatch,
        "user-context": userPatch,
        "guild-context": guildPatch
    },

    start() {
        loadMarks();
    },

    stop() {
        for (const s of running.values()) cancelExport(s);
    }
});
