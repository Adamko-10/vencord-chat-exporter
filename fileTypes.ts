/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "/exportchat file_types: png, mp4" or "images, videos": which files an export keeps

const KINDS: Record<string, { exts: string[]; mime?: string; }> = {
    images: { exts: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif", "svg", "tif", "tiff", "ico"], mime: "image/" },
    videos: { exts: ["mp4", "mov", "webm", "mkv", "avi", "m4v", "wmv", "flv", "3gp"], mime: "video/" },
    audio: { exts: ["mp3", "ogg", "wav", "m4a", "flac", "opus", "aac", "wma", "mid", "midi"], mime: "audio/" },
    documents: { exts: ["pdf", "doc", "docx", "txt", "md", "rtf", "odt", "xls", "xlsx", "csv", "ods", "ppt", "pptx", "odp", "json", "log"] },
    archives: { exts: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "jar", "mrpack"] }
};

/** other words people use for the same kinds */
const SAME_AS: Record<string, string> = {
    image: "images", img: "images", picture: "images", pictures: "images", pics: "images", pic: "images", photo: "images", photos: "images",
    video: "videos", vid: "videos", vids: "videos", clip: "videos", clips: "videos",
    sound: "audio", sounds: "audio", music: "audio", voice: "audio", audios: "audio",
    document: "documents", doc: "documents", docs: "documents", text: "documents",
    archive: "archives", zips: "archives", compressed: "archives"
};

export interface FileTypes {
    /** as shown in notes and headers: "png, mp4" or "images" */
    label: string;
    exts: Set<string>;
    /** "image/" etc.: files Discord says are that kind count too */
    mimes: string[];
}

/** "png, .MP4 images" -> file types; null when empty; an explanation when something isn't understood */
export function parseFileTypes(text: string): FileTypes | null | { error: string; } {
    const words = text.toLowerCase().split(/[\s,;|/]+/).map(w => w.replace(/^\*?\./, "")).filter(Boolean);
    if (!words.length) return null;
    const exts = new Set<string>();
    const mimes: string[] = [];
    const bad: string[] = [];
    for (const w of words) {
        const kind = KINDS[w] ?? KINDS[SAME_AS[w]];
        if (kind) {
            kind.exts.forEach(e => exts.add(e));
            if (kind.mime) mimes.push(kind.mime);
        } else if (/^[a-z0-9]{1,10}$/.test(w)) exts.add(w);
        else bad.push(w);
    }
    if (bad.length)
        return { error: `Didn't understand file type${bad.length === 1 ? "" : "s"} ${bad.map(b => `\`${b}\``).join(", ")}. Use extensions like \`png, mp4, pdf\` or kinds: \`images, videos, audio, documents, archives\`.` };
    return { label: words.join(", "), exts, mimes };
}

/** is this file one of those types? (no types = every file) */
export function fileMatches(a: { filename?: string; content_type?: string; }, types?: FileTypes | null): boolean {
    if (!types) return true;
    const name = String(a?.filename ?? "");
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (ext && types.exts.has(ext)) return true;
    const mime = String(a?.content_type ?? "").toLowerCase();
    return !!mime && types.mimes.some(m => mime.startsWith(m));
}
