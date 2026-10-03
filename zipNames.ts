/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Names for the files inside the .zip. Used by both the plugin (to write "saved as" lines
// into the export) and the desktop part (which double-checks every name it is given).
// Plain functions, no Discord or Node stuff, so both sides get exactly the same result.

/** Letters that don't split into "letter + accent", mapped by hand (Polish ł, German ß, ...) */
const SPECIAL: Record<string, string> = {
    "ł": "l", "Ł": "L", "ß": "ss", "æ": "ae", "Æ": "AE", "ø": "o", "Ø": "O", "đ": "d", "Đ": "D",
    "ð": "d", "Ð": "D", "þ": "th", "Þ": "Th", "œ": "oe", "Œ": "OE", "ı": "i"
};

const MAX_NAME = 150;

/**
 * A file name that every unzip tool shows the same way, Windows' built-in one included:
 * plain English letters only (ą -> a, ł -> l, emoji dropped), no characters Windows refuses,
 * no folders, not too long, never empty.
 */
export function safeZipName(raw: string) {
    let s = String(raw ?? "")
        .replace(/[łŁßæÆøØđĐðÐþÞœŒı]/g, c => SPECIAL[c])
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "") // accents split off by NFKD
        .replace(/[^\x20-\x7e]/g, "_") // anything else non-English
        .replace(/[<>:"/\\|?*]/g, "_") // not allowed in Windows file names (and no folders)
        .replace(/_{2,}/g, "_")
        .replace(/\s{2,}/g, " ")
        .replace(/^[\s.]+/, "") // no leading dots/spaces ("..", hidden files)
        .replace(/[\s.]+$/, ""); // Windows drops trailing dots/spaces

    if (!s || /^[_\s.-]*$/.test(s)) s = "file";
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = "_" + s;

    if (s.length > MAX_NAME) {
        const dot = s.lastIndexOf(".");
        const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : "";
        s = s.slice(0, MAX_NAME - ext.length).replace(/[\s.]+$/, "") + ext;
    }
    return s;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-09-15 16.11.23" in the PC's local time, so the zip sorts by date */
export function stampForName(when: Date) {
    return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}.${pad(when.getMinutes())}.${pad(when.getSeconds())}`;
}

/** "2026-09-15 16.11.23 someuser - image0.jpg" */
export function zipNameFor(when: Date, username: string, originalName: string) {
    return safeZipName(`${stampForName(when)} ${username || "unknown"} - ${originalName || "file"}`);
}

/** "name.jpg", then "name (2).jpg", "name (3).jpg"... Checks names case-insensitively, like Windows. */
export function uniqueZipName(name: string, taken: Set<string>) {
    const dot = name.lastIndexOf(".");
    const hasExt = dot > 0 && name.length - dot <= 12;
    const stem = hasExt ? name.slice(0, dot) : name;
    const ext = hasExt ? name.slice(dot) : "";
    let candidate = name;
    for (let i = 2; taken.has(candidate.toLowerCase()); i++)
        candidate = `${stem} (${i})${ext}`;
    taken.add(candidate.toLowerCase());
    return candidate;
}
