# ChatExporter (Vencord plugin)

Export a whole Discord chat, or every channel of a server, to a file with no message limit, plus a `.zip` of the pictures, videos and files people sent.

Works in channels, threads, forum posts, DMs and group DMs. Saves as **TXT** (same layout as the DiscordKit / DiscordChatExporter text export), **HTML** (looks like Discord, with a filter box and a channel picker) or **JSON** (raw API data). A progress bar in the corner shows how far it is, with a Cancel button.

## Using it

**Right-click**
- a chat → **Export Chat**, and **Export New Messages (since …)** once you've exported it before
- a server icon → **Export All Channels** (and **Export New Messages, All Channels**)
- right-click again while an export runs to cancel it

**`/exportchat`** in any chat. The notes it posts are only visible to you; run it again to cancel.

| option | what it does |
|---|---|
| `from` / `to` | date range: `2026-09-15`, `15.09.2026`, `15 sep`, `yesterday`, `7d` (7 days ago) or a message link. `to` includes that whole day. |
| `since_last` | `True` = only what's new since your last export of this chat or server (with `user`: since the last export that had their messages). Gets all of it; *Max messages* doesn't apply. |
| `user` | only this person's messages |
| `user2` … `user5` | more people: you get all of their messages together (and `since_last` remembers that group) |
| `channels` | `all channels in this server` = every channel and thread you can read (text, announcements, voice-channel chats, forum posts, archived threads), in one file with a section per channel |
| `links` | `True` = only the links people posted: who posted each one and when, then every different link once. Works with every other option: `user`, dates, `channels`, `since_last` (links exports remember their own "last export"), *Max messages* (the newest that many messages with links) and `files: True` (adds a zip of every file people sent). |
| `only_files` | `True` = only the files people sent: a list (who sent what, when, and its name in the zip) plus the zip, no chat. Works with every other option; `only_files` exports remember their own "last export" too. With `links: True` you get the links plus every file. |
| `files` | `False` = don't download the files (default: the *Save files* setting; off for `links` unless you say `True`) |
| `file_types` | only these files, e.g. `png, mp4, pdf`, or kinds: `images`, `videos`, `audio`, `documents`, `archives` (mix them as you like). Works for the zip of a normal export, `only_files` and `links` |
| `message_links` | `True` = a link to every message, so you can jump to it in Discord (default: the *Message links* setting) |
| `format` | `txt`, `html` or `json` |

Every option works with every other one. The few that can't go together say so instead of guessing (`only_files: True` with `files: False`, `file_types` with `files: False`, `from` with `since_last`).

Defaults when you leave an option empty: the whole chat, everyone, this channel, all messages (not just links or files), files from the *Save files* setting (on), every file type, message links from the setting (off), and the format from the setting (txt). `links: False` is exactly the same as leaving `links` empty.

Examples:
```
/exportchat from: 15.09.2026 to: 22.09.2026
/exportchat user: @someone channels: all channels in this server
/exportchat since_last: True
/exportchat links: True
/exportchat only_files: True file_types: images, videos
/exportchat user: @someone user2: @someone_else message_links: True
```

**Whole-server exports** get a channel picker at the top of the HTML (pick one channel to read or search through it, or go back to all), and big `### #channel` headings in the TXT so you can jump between channels with Ctrl+F.

## Where things go

Exports land in your **Downloads** folder as `[ChatExporter] <chat>_<server>_<date>_<time>.txt` (or a Save window, if you change the setting), and the folder opens with the file selected.

Attachments go into `<same name> files.zip` next to it, and the export says `saved as: …` under each one, because Discord's own links stop working after about a day. Downloads only come from Discord's own servers, names are made safe for Windows, big zips are split into 2 GB parts, and it stops before your drive gets full.

## Install

### Easy way (Windows)

Download this repo (green **Code** button → **Download ZIP**), unzip it, and double-click **`install.bat`**. It:

1. checks for Git, Node.js and pnpm, and offers to install whatever's missing
2. asks where your Vencord source folder is (Enter = `%USERPROFILE%\Vencord`), and downloads Vencord there if it isn't there yet
3. offers to update Vencord, copies ChatExporter in, builds it and puts it into Discord

`install.bat` also works on its own: if the plugin files aren't next to it, it downloads them from here.

### By hand

ChatExporter is a [Vencord](https://github.com/Vendicated/Vencord) *user plugin*, so you need Vencord built from source (Vencord's docs explain how).

```sh
cd Vencord/src/userplugins
git clone https://github.com/Adamko-10/vencord-chat-exporter chatExporter
cd ../..
pnpm build
pnpm inject
```

Then quit Discord completely and open it again: the plugin has a desktop part (`native.ts`) that only loads on a full restart. It's switched on by default; its settings are under Settings → Vencord → Plugins → ChatExporter.

Saving straight to Downloads and downloading the files need the Discord desktop app. In a browser it falls back to a normal download without the zip.

## Settings

| setting | default | |
|---|---|---|
| Format | txt | txt, html or json |
| Save files | on | download the files people sent into a zip |
| Save location | Downloads | or ask where to save every time |
| Open folder | on | show the export in Explorer when it's done |
| Max messages | 0 | 0 = everything, otherwise only the newest N (not used by `since_last`) |
| Delay | 300 ms | between requests to Discord |
| Embed images | on | HTML: show pictures inline |
| Progress every | 2000 | messages between progress pop-ups (never more than one every 5 seconds; not shown while the progress bar is on) |
| Progress bar | on | a progress bar in the corner while an export runs, with a Cancel button |
| Skip duplicate files | off | when several people sent the same file (same name and size), the zip gets it once and the export points everyone to that copy |
| Message links | off | a link to every message, to jump to it in Discord |

## Is it heavy?

No. Measured with realistic Discord messages in the same JavaScript engine Discord uses:

- **When you're not exporting** it does nothing: no timers, no background checks, no polling. Apart from reading its small list of remembered exports at startup, it only reacts when you right-click or type `/exportchat`.
- **CPU:** an export mostly waits on Discord (one request per 100 messages plus a deliberate 300 ms pause, so it never spams the API). Building the file at the end takes about 0.25 s for TXT and under 1 s for HTML, even for 100,000 messages.
- **RAM:** about 1 KB per message while an export runs (10,000 messages ≈ 11 MB, 100,000 ≈ 106 MB). Saving briefly needs a few times the file's size on top: a 100,000-message export peaks around 180 MB as TXT and 260 MB as HTML. It's all freed when the export is done. JSON is the heaviest format for huge chats because it's the raw API data.
- **Files** are streamed straight to disk in small chunks, so a few GB of attachments still only use a few MB of RAM.
- **How big can an export be?** There's no limit in the plugin. Discord hands out 100 messages per request, so reading takes about an hour per 700,000 messages. About a million messages per export is fine; far beyond that, Discord itself can run out of memory (export big servers in date ranges or per channel then). JSON is written in pieces, so it isn't stopped by JavaScript's 512 MB limit on one piece of text either.

## When Vencord or Discord update

Plugins like this use parts of Vencord and Discord that can change without warning. ChatExporter routes all of them through one small file (`compat.ts`) with fallbacks:

- if something nice to have changes (pop-ups, the right-click menu, role names...), exports keep working and `/exportchat` tells you what's affected
- if something essential changes, it tells you plainly instead of failing with a cryptic error
- a renamed or removed part can't stop Vencord from building

## Good to know

- Client mods like Vencord are against Discord's Terms of Service, and so is automating a user account. This plugin only reads what your account can already see, slowly and one request at a time, but using it is at your own risk.
- Exports contain other people's messages and files. Keep them private unless everyone in them is fine with sharing.

## Credits

Made by [Adamko-10](https://github.com/Adamko-10), written together with Claude (Anthropic's AI).

## License

GPL-3.0-or-later, like Vencord.
