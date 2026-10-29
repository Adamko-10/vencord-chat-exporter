/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A small progress card in the bottom right corner of Discord while an export runs.
// Plain DOM on purpose: it doesn't depend on any of Discord's components, so a Discord or
// Vencord update can't break it. Several exports at once get a card each.

export interface ProgressBar {
    /** fraction 0..1, or null when it can't be told yet (the bar then just pulses) */
    set(fraction: number | null, text: string): void;
    /** the end: shows the result for a few seconds, then goes away (or click it away) */
    finish(text: string, ok: boolean): void;
}

const STACK_ID = "vc-chatexporter-progress";

const NOOP: ProgressBar = { set() { }, finish() { } };

function stack(): HTMLElement | null {
    if (typeof document === "undefined" || !document.body) return null;
    let el = document.getElementById(STACK_ID);
    if (!el) {
        el = document.createElement("div");
        el.id = STACK_ID;
        el.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:10000;display:flex;flex-direction:column;gap:8px;width:320px;pointer-events:none";
        document.body.appendChild(el);
    }
    return el;
}

/** a new progress card; does nothing where there's no page (tests) or if building it fails */
export function openProgressBar(title: string, onCancel: () => void): ProgressBar {
    try {
        const parent = stack();
        if (!parent) return NOOP;
        const card = document.createElement("div");
        card.style.cssText = "pointer-events:auto;background:var(--background-floating,#111214);color:var(--text-normal,#dbdee1);"
            + "border-radius:8px;padding:10px 12px;box-shadow:0 8px 16px rgba(0,0,0,.24);font-size:13px;font-family:inherit;line-height:1.3";
        const head = document.createElement("div");
        head.style.cssText = "display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:6px";
        const name = document.createElement("div");
        name.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        name.textContent = title;
        const cancel = document.createElement("button");
        cancel.textContent = "Cancel";
        cancel.style.cssText = "background:none;border:1px solid var(--status-danger,#da373c);color:var(--status-danger,#f23f42);border-radius:4px;padding:1px 8px;cursor:pointer;font-size:12px";
        cancel.onclick = () => {
            cancel.disabled = true;
            cancel.textContent = "Cancelling…";
            onCancel();
        };
        head.append(name, cancel);
        const track = document.createElement("div");
        track.style.cssText = "height:6px;border-radius:3px;background:var(--background-modifier-accent,#3f4147);overflow:hidden";
        const fill = document.createElement("div");
        fill.style.cssText = "height:100%;width:0%;border-radius:3px;background:var(--brand-500,#5865f2);transition:width .3s";
        track.append(fill);
        const line = document.createElement("div");
        line.style.cssText = "margin-top:6px;font-size:12px;color:var(--text-muted,#949ba4)";
        card.append(head, track, line);
        parent.append(card);

        let pulse: ReturnType<typeof setInterval> | undefined;
        const stopPulse = () => {
            if (pulse) clearInterval(pulse);
            pulse = undefined;
            fill.style.opacity = "1";
        };
        let done = false;
        return {
            set(fraction, text) {
                if (done) return;
                line.textContent = text;
                if (fraction === null) {
                    fill.style.width = "100%";
                    if (!pulse) {
                        let on = false;
                        pulse = setInterval(() => {
                            on = !on;
                            fill.style.opacity = on ? "0.35" : "1";
                        }, 600);
                    }
                    return;
                }
                stopPulse();
                fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
            },
            finish(text, ok) {
                if (done) return;
                done = true;
                stopPulse();
                line.textContent = text;
                fill.style.width = "100%";
                fill.style.background = ok ? "var(--status-positive,#23a55a)" : "var(--status-danger,#f23f42)";
                cancel.remove();
                card.style.cursor = "pointer";
                card.title = "Click to close";
                const close = () => {
                    card.remove();
                    if (parent.childElementCount === 0) parent.remove();
                };
                card.onclick = close;
                setTimeout(close, ok ? 8000 : 15000);
            }
        };
    } catch (e) {
        console.warn("[ChatExporter] couldn't show the progress bar", e);
        return NOOP;
    }
}
