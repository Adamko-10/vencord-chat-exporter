# ChatExporter (Vencord plugin)

Export a whole Discord chat, or every channel of a server, to a file with no message limit, plus a `.zip` of the pictures, videos and files people sent.

Works in channels, threads, forum posts, DMs and group DMs. Saves as **TXT** (same layout as the DiscordKit / DiscordChatExporter text export), **HTML** (looks like Discord, with a filter box) or **JSON** (raw API data).

## Using it

**Right-click**
- a chat → **Export Chat**, and **Export New Messages (since …)** once you've exported it before
- a server icon → **Export All Channels** (and **Export New Messages, All Channels**)
- right-click again while an export runs to cancel it

**`/exportchat`** in any chat. The notes it posts are only visible to you; run it again to cancel.

| option | what it does |
|---|---|
| `from` / `to` | date range: `2026-09-15`, `15.09.2026`, `15 sep`, `yesterday`, `7d` (7 days ago) or a message link. `to` includes that whole day. |
| `since_last` | `True` = only what's new since your last export of this chat or server (remembered per chat, per server and per `user`). Gets all of it; *Max messages* doesn't apply. |
| `user` | only this person's messages |
| `channels` | `all channels in this server` = every channel and thread you can read (text, announcements, voice-channel chats, forum posts, archived threads), in one file with a section per channel |
| `files` | `False` = don't download the files |
| `format` | `txt`, `html` or `json` |

Examples:
```
/exportchat from: 15.09.2026 to: 22.09.2026
/exportchat user: @someone channels: all channels in this server
/exportchat since_last: True
```

## Where things go

Exports land in your **Downloads** folder as `[ChatExporter] <chat>_<server>_<date>_<time>.txt` (or a Save window, if you change the setting), and the folder opens with the file selected.

Attachments go into `<same name> files.zip` next to it, and the export says `saved as: …` under each one, because Discord's own links stop working after about a day. Downloads only come from Discord's own servers, names are made safe for Windows, big zips are split into 2 GB parts, and it stops before your drive gets full.

## Install

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
| Progress every | 2000 | messages between progress pop-ups (never more than one every 5 seconds) |

## Good to know

- Client mods like Vencord are against Discord's Terms of Service, and so is automating a user account. This plugin only reads what your account can already see, slowly and one request at a time, but using it is at your own risk.
- Exports contain other people's messages and files. Keep them private unless everyone in them is fine with sharing.

## License

GPL-3.0-or-later, like Vencord.
