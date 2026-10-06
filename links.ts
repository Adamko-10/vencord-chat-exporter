/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Finding the links in a message, for "/exportchat links: True"

/** a web link as Discord makes them clickable; ends at spaces, <>, quotes, ` and | (spoiler marks) */
const URL_RE = /https?:\/\/[^\s<>"'`|\\]+/gi;

const count = (s: string, ch: string) => s.split(ch).length - 1;

/** drops what ends a sentence or a bit of formatting, not the link: "see https://x.com/a." -> "https://x.com/a" */
function tidy(url: string) {
    for (; ;) {
        const last = url[url.length - 1];
        if (".,;:!?*~".includes(last)) url = url.slice(0, -1);
        // a closing bracket belongs to the link only when the link opened it: wiki/Foo_(bar) yes, (see https://x.com) no
        else if (last === ")" && count(url, "(") < count(url, ")")) url = url.slice(0, -1);
        else if (last === "]" && count(url, "[") < count(url, "]")) url = url.slice(0, -1);
        else return url;
    }
}

/** the links in a piece of text, in order */
export function linksInText(text: unknown): string[] {
    if (typeof text !== "string" || !text) return [];
    const found: string[] = [];
    for (const m of text.matchAll(URL_RE)) {
        const url = tidy(m[0]);
        // just "https://" with nothing after it isn't a link
        if (/^https?:\/\/[^/]/i.test(url)) found.push(url);
    }
    return found;
}

/** links in a bot's embed (title link, text, fields, author). Link previews Discord makes itself are skipped: they repeat the message's own link. */
function embedLinks(e: any): string[] {
    if (!e || e.type !== "rich") return [];
    const out = [e.url, e.author?.url].filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
    out.push(...linksInText(e.title), ...linksInText(e.description), ...linksInText(e.footer?.text));
    for (const f of e.fields ?? []) out.push(...linksInText(f?.name), ...linksInText(f?.value));
    return out;
}

/** link buttons under a bot's message */
function buttonLinks(components: any): string[] {
    const out: string[] = [];
    const walk = (list: any) => {
        for (const c of Array.isArray(list) ? list : []) {
            if (typeof c?.url === "string" && /^https?:\/\//i.test(c.url)) out.push(c.url);
            walk(c?.components);
        }
    };
    walk(components);
    return out;
}

/**
 * Every link in a message, once each, in order: what was written (also in a forwarded message),
 * in a bot's embeds and on its link buttons. Uploaded files aren't included: their links stop
 * working after about a day (a normal export saves the files themselves).
 */
export function linksIn(m: any): string[] {
    if (!m) return [];
    const all = [...linksInText(m.content), ...(m.embeds ?? []).flatMap(embedLinks), ...buttonLinks(m.components)];
    for (const s of m.message_snapshots ?? []) {
        const fwd = s?.message;
        if (fwd) all.push(...linksInText(fwd.content), ...(fwd.embeds ?? []).flatMap(embedLinks));
    }
    return [...new Set(all)];
}
