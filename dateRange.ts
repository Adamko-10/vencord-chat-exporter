/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Reads what you type into /exportchat's "from" and "to" options.
// Plain functions with no Discord stuff in them, so they are easy to test.

export interface DateRange {
    /** first moment that is included */
    after?: Date;
    /** first moment that is NOT included (like DiscordKit's "Before:") */
    before?: Date;
}

type Unit = "ms" | "exact" | "minute" | "day" | "month" | "year";
interface When { at: Date; unit: Unit; }

const DISCORD_EPOCH = 1420070400000;

/** Discord message ids start with the time they were sent */
export function snowflakeToDate(id: string) {
    return new Date(Number(BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** the smallest message id that could have been sent at this time */
export function dateToSnowflake(d: Date) {
    const ms = Math.max(0, d.getTime() - DISCORD_EPOCH);
    return (BigInt(ms) << 22n).toString();
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthIndex(word: string) {
    const w = word.toLowerCase().replace(/\.$/, "");
    if (w.length < 3) return -1;
    return MONTHS.findIndex(m => m.startsWith(w));
}

function fullYear(y: string | undefined, fallback: number) {
    if (y === undefined) return fallback;
    const n = Number(y);
    return y.length <= 2 ? 2000 + n : n;
}

/** builds a local date and rejects things like 31.02. or 25:00 */
function makeDate(y: number, month: number, d: number, hh?: string, mm?: string, ampm?: string): Date | null {
    let h = hh === undefined ? 0 : Number(hh);
    const min = mm === undefined ? 0 : Number(mm);
    if (ampm) {
        if (h < 1 || h > 12) return null;
        h = (h % 12) + (ampm.startsWith("p") ? 12 : 0);
    }
    if (month < 0 || month > 11 || d < 1 || d > 31 || h > 23 || min > 59) return null;
    const date = new Date(y, month, d, h, min, 0, 0);
    if (date.getFullYear() !== y || date.getMonth() !== month || date.getDate() !== d) return null;
    return date;
}

/** no year typed: this year, unless that would be in the future, then last year */
function withGuessedYear(build: (year: number) => Date | null, now: Date) {
    const thisYear = build(now.getFullYear());
    if (thisYear && thisYear.getTime() > now.getTime() + 86_400_000) return build(now.getFullYear() - 1);
    return thisYear;
}

// optional time after a date: "14:30", ", 2:30 pm", "T14:30:00" (input is lowercased first, so "t")
const TIME = String.raw`(?:[\st,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?)?`;
const ISO = new RegExp(String.raw`^(\d{4})-(\d{1,2})-(\d{1,2})${TIME}$`);
const DOTTED = new RegExp(String.raw`^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2})?)?${TIME}$`);
const SLASHED = new RegExp(String.raw`^(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?${TIME}$`);
const DAY_MONTH = new RegExp(String.raw`^(\d{1,2})(?:st|nd|rd|th)?\.?\s*([a-z]{3,9}\.?),?(?:\s+(\d{4}))?${TIME}$`);
const MONTH_DAY = new RegExp(String.raw`^([a-z]{3,9}\.?)\s*(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?${TIME}$`);
const MONTH_YEAR = /^([a-z]{3,9}\.?)\s+(\d{4})$/;
const YEAR = /^(\d{4})$/;
const RELATIVE = /^(\d+)\s*(h|hrs?|hours?|d|days?|w|wks?|weeks?|m|mos?|months?|y|yrs?|years?)(?:\s+ago)?$/;
const MESSAGE_LINK = /discord(?:app)?\.com\/channels\/(?:@me|\d+)\/\d+\/(\d{17,20})/;
const MESSAGE_ID = /^(\d{17,20})$/;

/** Understands dates, times, "yesterday", "7d", month names and message links. null = no idea */
export function parseWhen(input: string, now: Date, dayFirst: boolean): When | null {
    const raw = input.trim();
    const link = MESSAGE_LINK.exec(raw) ?? MESSAGE_ID.exec(raw);
    if (link) return { at: snowflakeToDate(link[1]), unit: "ms" };

    const s = raw.toLowerCase().replace(/\s+/g, " ");
    let m: RegExpExecArray | null;

    if (s === "now") return { at: new Date(now), unit: "exact" };
    if (s === "today" || s === "yesterday") {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (s === "yesterday") d.setDate(d.getDate() - 1);
        return { at: d, unit: "day" };
    }

    if ((m = RELATIVE.exec(s))) {
        const n = Number(m[1]);
        const d = new Date(now);
        const u = m[2][0];
        if (u === "h") d.setHours(d.getHours() - n);
        else if (u === "d") d.setDate(d.getDate() - n);
        else if (u === "w") d.setDate(d.getDate() - 7 * n);
        else if (u === "m") d.setMonth(d.getMonth() - n);
        else d.setFullYear(d.getFullYear() - n);
        return { at: d, unit: "exact" };
    }

    const unitFor = (hh?: string): Unit => hh === undefined ? "day" : "minute";

    if ((m = ISO.exec(s))) {
        const d = makeDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4], m[5], m[6]);
        return d && { at: d, unit: unitFor(m[4]) };
    }
    if ((m = DOTTED.exec(s))) { // 15.09.2026 = day.month.year
        const [, dd, mo, y, hh, mm, ap] = m;
        const d = y !== undefined
            ? makeDate(fullYear(y, 0), Number(mo) - 1, Number(dd), hh, mm, ap)
            : withGuessedYear(year => makeDate(year, Number(mo) - 1, Number(dd), hh, mm, ap), now);
        return d && { at: d, unit: unitFor(hh) };
    }
    if ((m = SLASHED.exec(s))) { // 15/09 or 9/15: the number above 12 is the day, otherwise follow Discord's language
        const [, a, b, y, hh, mm, ap] = m;
        const [na, nb] = [Number(a), Number(b)];
        const dayIsFirst = na > 12 ? true : nb > 12 ? false : dayFirst;
        const [dd, mo] = dayIsFirst ? [na, nb] : [nb, na];
        const d = y !== undefined
            ? makeDate(fullYear(y, 0), mo - 1, dd, hh, mm, ap)
            : withGuessedYear(year => makeDate(year, mo - 1, dd, hh, mm, ap), now);
        return d && { at: d, unit: unitFor(hh) };
    }
    if ((m = DAY_MONTH.exec(s)) || (m = MONTH_DAY.exec(s))) {
        const dayFirstMatch = /^\d/.test(m[1]);
        const dd = Number(dayFirstMatch ? m[1] : m[2]);
        const mo = monthIndex(dayFirstMatch ? m[2] : m[1]);
        const [, , , y, hh, mm, ap] = m;
        if (mo < 0) return null;
        const d = y !== undefined
            ? makeDate(Number(y), mo, dd, hh, mm, ap)
            : withGuessedYear(year => makeDate(year, mo, dd, hh, mm, ap), now);
        return d && { at: d, unit: unitFor(hh) };
    }
    if ((m = MONTH_YEAR.exec(s))) {
        const mo = monthIndex(m[1]);
        return mo < 0 ? null : { at: new Date(Number(m[2]), mo, 1), unit: "month" };
    }
    if ((m = YEAR.exec(s))) return { at: new Date(Number(m[1]), 0, 1), unit: "year" };

    return null;
}

/** "to" includes the whole day / minute / month you typed, so the cut-off is the start of the next one */
function endOf(w: When) {
    const d = new Date(w.at);
    if (w.unit === "ms") d.setMilliseconds(d.getMilliseconds() + 1);
    else if (w.unit === "minute") d.setMinutes(d.getMinutes() + 1);
    else if (w.unit === "day") d.setDate(d.getDate() + 1);
    else if (w.unit === "month") d.setMonth(d.getMonth() + 1);
    else if (w.unit === "year") d.setFullYear(d.getFullYear() + 1);
    return d;
}

/** "Mon, 15 Sept 2026, 00:00" in Discord's language, month written out so it can't be misread */
export function niceDate(d: Date, locale?: string) {
    const opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" };
    try {
        return d.toLocaleString(locale, opts);
    } catch {
        return d.toLocaleString(undefined, opts);
    }
}

/** " from … to …" for messages, "" if there is no range */
export function describeRange(range: DateRange, locale?: string) {
    const last = range.before && new Date(range.before.getTime() - 1);
    if (range.after && last) return ` from ${niceDate(range.after, locale)} to ${niceDate(last, locale)}`;
    if (range.after) return ` from ${niceDate(range.after, locale)} until now`;
    if (last) return ` from the very first message to ${niceDate(last, locale)}`;
    return "";
}

export const DATE_EXAMPLES = "2026-09-15, 15.09.2026, 15 sep, yesterday, 7d (= 7 days ago) or a message link";

/** Turns the typed "from"/"to" into a range, or explains what's wrong. */
export function buildRange(fromText: string, toText: string, now: Date, locale?: string): { range: DateRange; } | { error: string; } {
    // Discord in US English writes month/day; every other language writes day/month
    const dayFirst = !/^en-us$/i.test(locale ?? "");
    const range: DateRange = {};

    if (fromText.trim()) {
        const w = parseWhen(fromText, now, dayFirst);
        if (!w) return { error: `I couldn't read the "from" date \`${fromText.trim()}\`. Try something like ${DATE_EXAMPLES}.` };
        range.after = w.at;
    }
    if (toText.trim()) {
        const w = parseWhen(toText, now, dayFirst);
        if (!w) return { error: `I couldn't read the "to" date \`${toText.trim()}\`. Try something like ${DATE_EXAMPLES}.` };
        range.before = endOf(w);
    }
    if (range.after && range.before && range.after.getTime() >= range.before.getTime())
        return { error: `"from" (${niceDate(range.after, locale)}) has to be before "to" (${niceDate(new Date(range.before.getTime() - 1), locale)}).` };
    if (range.after && range.after.getTime() > now.getTime())
        return { error: `"from" (${niceDate(range.after, locale)}) is in the future, so there's nothing to export yet.` };

    return { range };
}
