/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A small .zip writer for Discord's desktop side (Node). Files are streamed straight to disk,
// so big chats don't need lots of memory. Files are stored as-is (pictures and videos are
// already compressed). It only uses the classic zip format that every unzip tool (Windows'
// built-in one included) understands, so it starts a new part before a zip gets near
// that format's 4 GB / 65,535-file limits.

import { type FileHandle, open, unlink } from "fs/promises";

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

/** Standard zip CRC-32. Start with 0 and feed chunks in order. */
export function crc32(crc: number, data: Uint8Array) {
    let c = (crc ^ 0xFFFFFFFF) >>> 0;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** The time in the zip, which Explorer shows as "Date modified" (local time, 2-second steps) */
function dosDateTime(ms: number) {
    let d = new Date(Number.isFinite(ms) ? ms : Date.now());
    if (d.getFullYear() < 1980) d = new Date(1980, 0, 1);
    if (d.getFullYear() > 2107) d = new Date(2107, 11, 31, 23, 59, 58);
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
        date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
}

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const U32_MAX = 0xFFFFFFFF;
/** keep this much of the 4 GB address space free for the list of files at the end */
const RESERVE = 64 * 1024 * 1024;

export interface ZipLimits {
    /** start a new part when a zip would grow past this (2 GB by default, far below the 4 GB limit) */
    partBytes: number;
    /** start a new part at this many files (the classic format stops at 65,535) */
    partEntries: number;
}

export const DEFAULT_LIMITS: ZipLimits = { partBytes: 2_000_000_000, partEntries: 65_000 };

export class ZipTooBigError extends Error { }

interface Entry { name: Buffer; crc: number; size: number; offset: number; time: number; date: number; }

class Part {
    offset = 0;
    entries: Entry[] = [];
    centralSize = END_RECORD;
    constructor(readonly path: string, readonly fh: FileHandle) { }
}

export interface EntryWriter {
    write(chunk: Uint8Array): Promise<void>;
    /** finish this file: fills in its size and checksum */
    commit(): Promise<void>;
    /** throw away this file (failed download), as if it was never started */
    discard(): Promise<void>;
}

export class ZipWriter {
    private part: Part | null = null;
    private readonly done: string[] = [];
    private open = false;
    private finished = false;

    /** pathForPart(1) is the first zip, pathForPart(2) the next part, ... must not exist yet */
    constructor(private readonly pathForPart: (n: number) => Promise<string>, private readonly limits: ZipLimits = DEFAULT_LIMITS) { }

    get partPaths() {
        return this.part ? [...this.done, this.part.path] : [...this.done];
    }

    private async newPart() {
        const path = await this.pathForPart(this.done.length + 1);
        const fh = await open(path, "wx"); // "x": never overwrite an existing file
        this.part = new Part(path, fh);
        return this.part;
    }

    private async closePart(part: Part) {
        const chunks: Buffer[] = [];
        let cdSize = 0;
        for (const e of part.entries) {
            const h = Buffer.alloc(CENTRAL_HEADER);
            h.writeUInt32LE(0x02014b50, 0);
            h.writeUInt16LE(20, 4); // made by: zip 2.0, MS-DOS
            h.writeUInt16LE(10, 6); // needed to extract: 1.0 (stored files)
            h.writeUInt16LE(0, 8); // flags
            h.writeUInt16LE(0, 10); // stored, no compression
            h.writeUInt16LE(e.time, 12);
            h.writeUInt16LE(e.date, 14);
            h.writeUInt32LE(e.crc, 16);
            h.writeUInt32LE(e.size, 20);
            h.writeUInt32LE(e.size, 24);
            h.writeUInt16LE(e.name.length, 28);
            h.writeUInt32LE(e.offset, 42);
            chunks.push(h, e.name);
            cdSize += CENTRAL_HEADER + e.name.length;
        }
        const end = Buffer.alloc(END_RECORD);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(part.entries.length, 8);
        end.writeUInt16LE(part.entries.length, 10);
        end.writeUInt32LE(cdSize, 12);
        end.writeUInt32LE(part.offset, 16);
        chunks.push(end);

        const all = Buffer.concat(chunks);
        await part.fh.write(all, 0, all.length, part.offset);
        await part.fh.close();
        if (part.entries.length) this.done.push(part.path);
        else await unlink(part.path).catch(() => { });
    }

    /** Starts a file in the zip. expectedSize is only used to decide when to begin a new part. */
    async beginEntry(name: string, whenMs: number, expectedSize = 0): Promise<EntryWriter> {
        if (this.finished) throw new Error("zip already finished");
        if (this.open) throw new Error("finish the previous file first");
        const nameBuf = Buffer.from(name, "utf8");
        if (!nameBuf.length || nameBuf.length > 0xFFFF) throw new Error("bad file name");

        let part = this.part ?? await this.newPart();
        const wouldBe = part.offset + LOCAL_HEADER + nameBuf.length + Math.max(0, expectedSize)
            + part.centralSize + CENTRAL_HEADER + nameBuf.length;
        if (part.entries.length && (wouldBe > this.limits.partBytes || part.entries.length + 1 > this.limits.partEntries)) {
            this.part = null;
            await this.closePart(part);
            part = await this.newPart();
        }

        const { time, date } = dosDateTime(whenMs);
        const headerAt = part.offset;
        const header = Buffer.alloc(LOCAL_HEADER);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(10, 4);
        header.writeUInt16LE(0, 6);
        header.writeUInt16LE(0, 8);
        header.writeUInt16LE(time, 10);
        header.writeUInt16LE(date, 12);
        // 14..25: checksum and sizes, filled in by commit()
        header.writeUInt16LE(nameBuf.length, 26);
        header.writeUInt16LE(0, 28);
        const head = Buffer.concat([header, nameBuf]);
        await part.fh.write(head, 0, head.length, headerAt);
        part.offset += head.length;
        this.open = true;

        let crc = 0;
        let size = 0;
        let closed = false;
        const p = part;
        const close = () => {
            closed = true;
            this.open = false;
        };

        return {
            write: async (chunk: Uint8Array) => {
                if (closed) throw new Error("file already closed");
                if (size + chunk.length > U32_MAX || p.offset + chunk.length > U32_MAX - RESERVE)
                    throw new ZipTooBigError("too big to fit in a zip file (over 4 GB)");
                let at = 0;
                while (at < chunk.length) {
                    const { bytesWritten } = await p.fh.write(chunk, at, chunk.length - at, p.offset);
                    at += bytesWritten;
                    p.offset += bytesWritten;
                }
                crc = crc32(crc, chunk);
                size += chunk.length;
            },
            commit: async () => {
                if (closed) throw new Error("file already closed");
                const sizes = Buffer.alloc(12);
                sizes.writeUInt32LE(crc, 0);
                sizes.writeUInt32LE(size, 4);
                sizes.writeUInt32LE(size, 8);
                await p.fh.write(sizes, 0, 12, headerAt + 14);
                p.entries.push({ name: nameBuf, crc, size, offset: headerAt, time, date });
                p.centralSize += CENTRAL_HEADER + nameBuf.length;
                close();
            },
            discard: async () => {
                if (closed) return;
                await p.fh.truncate(headerAt);
                p.offset = headerAt;
                close();
            }
        };
    }

    /** Adds a small file from memory (the list of files that failed, for example). */
    async addBuffer(name: string, whenMs: number, data: Uint8Array) {
        const entry = await this.beginEntry(name, whenMs, data.length);
        try {
            await entry.write(data);
            await entry.commit();
        } catch (e) {
            await entry.discard().catch(() => { });
            throw e;
        }
    }

    /** Writes the list of files at the end of each part. Returns the zips that have files in them. */
    async finish() {
        if (this.finished) return [...this.done];
        this.finished = true;
        if (this.part) {
            const p = this.part;
            this.part = null;
            await this.closePart(p);
        }
        return [...this.done];
    }
}
