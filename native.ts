/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Runs in Discord's main (desktop) process, so it can write files without any
// "Save as" window. Called from index.tsx through VencordNative.pluginHelpers.ChatExporter.
// Every exported function here can be called from Discord's window, so each one checks
// what it's given: exports only go into Downloads (or where you picked), downloads only
// come from Discord's own file servers, and zip names can't point outside the zip.

import { randomUUID } from "crypto";
import { app, BrowserWindow, dialog, IpcMainInvokeEvent, net, SaveDialogOptions, shell } from "electron";
import * as fsp from "fs/promises";
import { basename, dirname, extname, join } from "path";

import { safeZipName, uniqueZipName } from "./zipNames";
import { EntryWriter, ZipTooBigError, ZipWriter } from "./zipWriter";

const ALLOWED_EXTENSIONS = [".txt", ".html", ".json"];
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Turns whatever the renderer sent into a plain, safe file name (never a path). */
function cleanFileName(raw: string) {
    let name = String(raw ?? "")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") // characters Windows refuses + path separators
        .replace(/[. ]+$/, "") // Windows drops trailing dots/spaces
        .trim();
    name = basename(name);
    if (!name || /^\.+$/.test(name)) name = "chat-export";
    if (WINDOWS_RESERVED.test(name)) name = "_" + name;
    if (!ALLOWED_EXTENSIONS.includes(extname(name).toLowerCase())) name += ".txt";
    if (name.length > 150) {
        const ext = extname(name);
        name = name.slice(0, 150 - ext.length).trimEnd() + ext;
    }
    return name;
}

async function exists(path: string) {
    try {
        await fsp.access(path);
        return true;
    } catch {
        return false;
    }
}

/** "name.txt", or "name (1).txt", "name (2).txt"... if it already exists */
async function firstFreePath(folder: string, name: string) {
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let candidate = join(folder, name);
    for (let i = 1; i < 1000 && await exists(candidate); i++)
        candidate = join(folder, `${stem} (${i})${ext}`);
    return candidate;
}

/** "Downloads\name.txt" for files in Downloads, the full path otherwise */
function shortPath(path: string) {
    return dirname(path) === app.getPath("downloads") ? join("Downloads", basename(path)) : path;
}

/** exports written this session: zips may only be created next to these */
const writtenExports = new Set<string>();

export interface SaveResult {
    /** full path of the written file */
    path?: string;
    /** short version for messages, e.g. "Downloads\[ChatExporter] x.txt" */
    shownAs?: string;
    cancelled?: boolean;
    error?: string;
}

/**
 * Writes an export to disk.
 * askWhere = false: straight into the Downloads folder (like the DiscordKit extension).
 * askWhere = true: shows a "Save as" window that starts in Downloads.
 */
export async function saveExport(e: IpcMainInvokeEvent, fileName: string, data: Uint8Array, askWhere: boolean, openFolder: boolean): Promise<SaveResult> {
    try {
        const name = cleanFileName(fileName);
        const downloads = app.getPath("downloads");
        let target: string;

        if (askWhere) {
            const ext = extname(name).slice(1);
            const options: SaveDialogOptions = {
                title: "Save chat export",
                defaultPath: join(downloads, name),
                filters: [{ name: ext.toUpperCase() + " file", extensions: [ext] }, { name: "All files", extensions: ["*"] }]
            };
            const win = BrowserWindow.fromWebContents(e.sender);
            const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
            if (result.canceled || !result.filePath) return { cancelled: true };
            target = result.filePath;
        } else {
            await fsp.mkdir(downloads, { recursive: true });
            target = await firstFreePath(downloads, name);
        }

        await fsp.writeFile(target, data);
        writtenExports.add(target);
        if (openFolder) shell.showItemInFolder(target);
        return { path: target, shownAs: shortPath(target) };
    } catch (err: any) {
        return { error: String(err?.message ?? err) };
    }
}

/** Opens Explorer with an export highlighted (only files ChatExporter wrote this session). */
export function showInFolder(_e: IpcMainInvokeEvent, path: string) {
    if (!writtenExports.has(path)) return false;
    shell.showItemInFolder(path);
    return true;
}

// ---------------------------------------------------------------------------
// Downloading the files people sent into a zip
// ---------------------------------------------------------------------------

/** leave at least this much free space on the drive */
const FREE_MARGIN = 200 * 1024 * 1024;
const MAX_ATTEMPTS = 4;
/** give up on a download that sends nothing for this long */
const STALL_MS = 60_000;
/** a zip nobody touched for this long gets finished automatically (Discord window reloaded, ...) */
const ABANDONED_MS = 10 * 60_000;
const MAX_JOBS = 4;

interface ZipJob {
    writer: ZipWriter;
    names: Set<string>;
    busy: boolean;
    cancelled: boolean;
    controller: AbortController | null;
    lastUsed: number;
}

const jobs = new Map<string, ZipJob>();
let reaper: ReturnType<typeof setInterval> | null = null;

function watchForAbandonedJobs() {
    if (reaper) return;
    reaper = setInterval(() => {
        for (const [id, job] of jobs) {
            if (!job.busy && Date.now() - job.lastUsed > ABANDONED_MS) {
                jobs.delete(id);
                job.writer.finish().catch(() => { });
            }
        }
        if (!jobs.size && reaper) {
            clearInterval(reaper);
            reaper = null;
        }
    }, 60_000);
    reaper.unref?.();
}

async function freeBytes(folder: string): Promise<number | null> {
    try {
        const statfs = (fsp as any).statfs as undefined | ((p: string) => Promise<{ bavail: number | bigint; bsize: number | bigint; }>);
        if (typeof statfs !== "function") return null;
        const s = await statfs(folder);
        return Number(s.bavail) * Number(s.bsize);
    } catch {
        return null;
    }
}

function fmtBytes(n: number) {
    if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Free space in Downloads, or null if Windows won't say. */
export async function freeSpace(_e: IpcMainInvokeEvent) {
    return freeBytes(app.getPath("downloads"));
}

/** only Discord's own file servers, only https */
function allowedUrl(raw: string): string | null {
    try {
        const u = new URL(String(raw));
        const host = u.hostname.toLowerCase();
        const ok = u.protocol === "https:" && (host === "cdn.discordapp.com" || host === "cdn.discord.com" || host.endsWith(".discordapp.net"));
        return ok ? u.href : null;
    } catch {
        return null;
    }
}

class HttpError extends Error {
    constructor(readonly status: number, readonly retryAfterMs?: number) {
        super(`HTTP ${status}`);
    }
}
class StallError extends Error { }
class IncompleteError extends Error { }

function isDiskError(err: any) {
    return typeof err?.code === "string" && ["ENOSPC", "EDQUOT", "EIO", "EROFS", "EACCES", "EPERM", "EBUSY", "EMFILE"].includes(err.code);
}

function isRetryable(err: any) {
    if (err instanceof HttpError) return err.status === 408 || err.status === 425 || err.status === 429 || err.status >= 500;
    if (err instanceof ZipTooBigError || isDiskError(err)) return false;
    return true; // connection problems, stalls, cut-off downloads
}

function describe(err: any, attempts: number) {
    const tries = attempts > 1 ? ` (tried ${attempts} times)` : "";
    if (err instanceof HttpError) {
        if (err.status === 404 || err.status === 410) return `Discord says the file doesn't exist anymore (HTTP ${err.status})`;
        if (err.status === 403) return "Discord refused the download (HTTP 403)";
        return `Discord's file server answered HTTP ${err.status}${tries}`;
    }
    if (err instanceof ZipTooBigError) return err.message;
    if (err instanceof StallError) return `the download stopped moving for ${STALL_MS / 1000} seconds${tries}`;
    if (err instanceof IncompleteError) return `the download kept breaking off${tries}`;
    if (err?.code === "ENOSPC" || err?.code === "EDQUOT") return "the drive is full";
    if (isDiskError(err)) return `couldn't write to the zip (${err.code})`;
    return `network problem: ${err?.message ?? err}${tries}`;
}

function doFetch(url: string, init: RequestInit): Promise<Response> {
    // Chromium's network stack (same proxy settings as Discord) when available, Node's fetch otherwise
    const electronFetch = (net as any)?.fetch;
    if (typeof electronFetch === "function") return electronFetch.call(net, url, init);
    return fetch(url, init);
}

async function waitUnlessCancelled(job: ZipJob, ms: number) {
    for (let waited = 0; waited < ms && !job.cancelled; waited += 250)
        await new Promise(r => setTimeout(r, Math.min(250, ms - waited)));
}

/** Streams one download into the open zip entry. Returns the number of bytes. */
async function downloadInto(job: ZipJob, url: string, entry: EntryWriter) {
    const controller = new AbortController();
    job.controller = controller;
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { stalled = true; controller.abort(); }, STALL_MS);
    };
    arm();
    try {
        let res: Response;
        try {
            res = await doFetch(url, { signal: controller.signal, redirect: "follow", credentials: "omit" });
        } catch (err) {
            throw stalled ? new StallError() : err;
        }
        if (!res.ok) {
            const ra = Number(res.headers.get("retry-after"));
            throw new HttpError(res.status, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : undefined);
        }
        if (!res.body) throw new IncompleteError();

        // with gzip/br the length header counts compressed bytes, so only check it for plain downloads
        const encoding = (res.headers.get("content-encoding") ?? "").toLowerCase();
        const lengthHeader = res.headers.get("content-length");
        const expected = !encoding || encoding === "identity" ? Number(lengthHeader ?? NaN) : NaN;

        const reader = res.body.getReader();
        let bytes = 0;
        for (; ;) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await reader.read();
            } catch (err) {
                throw stalled ? new StallError() : err;
            }
            if (chunk.done) break;
            arm();
            await entry.write(chunk.value);
            bytes += chunk.value.length;
        }
        if (Number.isFinite(expected) && lengthHeader !== null && bytes !== expected) throw new IncompleteError();
        return bytes;
    } finally {
        clearTimeout(timer);
        controller.abort(); // make sure the connection is released
        job.controller = null;
    }
}

/**
 * Starts a zip next to an export ChatExporter just saved:
 * "[ChatExporter] x.txt" -> "[ChatExporter] x files.zip" (+ " files (part 2).zip" if it gets huge).
 */
export async function zipStart(_e: IpcMainInvokeEvent, exportPath: string, expectedBytes: number): Promise<{ id?: string; error?: string; }> {
    try {
        if (!writtenExports.has(exportPath)) return { error: "that export wasn't saved by ChatExporter" };
        if (jobs.size >= MAX_JOBS) return { error: "too many exports are downloading files at once" };
        const folder = dirname(exportPath);
        const stem = basename(exportPath, extname(exportPath));
        const need = Math.max(0, Number(expectedBytes) || 0);
        const free = await freeBytes(folder);
        if (free !== null && free < need + FREE_MARGIN)
            return { error: `not enough free space: the files need about ${fmtBytes(need)}, but only ${fmtBytes(free)} is free on that drive` };

        const writer = new ZipWriter(n => firstFreePath(folder, n === 1 ? `${stem} files.zip` : `${stem} files (part ${n}).zip`));
        const id = randomUUID();
        jobs.set(id, { writer, names: new Set(), busy: false, cancelled: false, controller: null, lastUsed: Date.now() });
        watchForAbandonedJobs();
        return { id };
    } catch (err: any) {
        return { error: describe(err, 1) };
    }
}

export interface AddResult {
    ok?: boolean;
    bytes?: number;
    /** the name it got in the zip */
    name?: string;
    cancelled?: boolean;
    error?: string;
    /** true when nothing else can work either (drive full...), so stop trying */
    fatal?: boolean;
}

/** Downloads one file from Discord into the zip. Retries hiccups, never keeps half a file. */
export async function zipAddUrl(_e: IpcMainInvokeEvent, id: string, url: string, name: string, whenMs: number, expectedSize: number): Promise<AddResult> {
    const job = jobs.get(id);
    if (!job) return { error: "the zip was already closed", fatal: true };
    if (job.cancelled) return { cancelled: true };
    if (job.busy) return { error: "still busy with the previous file" };
    const safeUrl = allowedUrl(url);
    if (!safeUrl) return { error: "skipped for safety: not a link to Discord's own file servers" };

    job.busy = true;
    job.lastUsed = Date.now();
    const finalName = uniqueZipName(safeZipName(name), job.names);
    try {
        for (let attempt = 1; ; attempt++) {
            const entry = await job.writer.beginEntry(finalName, Number(whenMs), Number(expectedSize) || 0);
            try {
                const bytes = await downloadInto(job, safeUrl, entry);
                await entry.commit();
                return { ok: true, bytes, name: finalName };
            } catch (err: any) {
                await entry.discard().catch(() => { });
                if (job.cancelled) return { cancelled: true };
                if (isDiskError(err)) return { error: describe(err, attempt), fatal: true };
                if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) return { error: describe(err, attempt) };
                const wait = err instanceof HttpError && err.retryAfterMs ? err.retryAfterMs : [1000, 3000, 7000][attempt - 1] ?? 7000;
                await waitUnlessCancelled(job, wait);
                if (job.cancelled) return { cancelled: true };
            }
        }
    } catch (err: any) {
        // couldn't even start the file in the zip (drive full, zip file deleted, ...)
        return { error: describe(err, 1), fatal: isDiskError(err) };
    } finally {
        job.busy = false;
        job.lastUsed = Date.now();
    }
}

/** Adds a small text file to the zip (the list of files that couldn't be downloaded). */
export async function zipAddText(_e: IpcMainInvokeEvent, id: string, name: string, text: string, whenMs: number): Promise<{ ok?: boolean; error?: string; }> {
    const job = jobs.get(id);
    if (!job) return { error: "the zip was already closed" };
    if (job.busy) return { error: "still busy with the previous file" };
    job.busy = true;
    try {
        await job.writer.addBuffer(uniqueZipName(safeZipName(name), job.names), Number(whenMs), Buffer.from(String(text ?? ""), "utf8"));
        return { ok: true };
    } catch (err: any) {
        return { error: describe(err, 1) };
    } finally {
        job.busy = false;
        job.lastUsed = Date.now();
    }
}

/** Stops the download that's running right now (the zip keeps everything finished so far). */
export function zipCancel(_e: IpcMainInvokeEvent, id: string) {
    const job = jobs.get(id);
    if (!job) return false;
    job.cancelled = true;
    job.controller?.abort();
    return true;
}

/** Closes the zip. Returns the zip file(s); a zip with nothing in it is removed. */
export async function zipFinish(_e: IpcMainInvokeEvent, id: string, openFolder: boolean): Promise<{ files?: { path: string; shownAs: string; }[]; error?: string; }> {
    const job = jobs.get(id);
    if (!job) return { error: "the zip was already closed" };
    jobs.delete(id);
    try {
        const paths = await job.writer.finish();
        if (openFolder && paths.length) shell.showItemInFolder(paths[0]);
        return { files: paths.map(path => ({ path, shownAs: shortPath(path) })) };
    } catch (err: any) {
        return { error: describe(err, 1) };
    }
}
