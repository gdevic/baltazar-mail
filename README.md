# Baltazar Mail

A fast, ad-free client for Yahoo Mail, packaged as a Chromium (Edge/Chrome) extension. It reuses the Yahoo sign-in already present in the browser and talks to the same API that Yahoo's own web client uses, so it is as quick as the official UI without any of its clutter. Everything works with the mouse; press `?` in the app for keyboard shortcuts.

Baltazar Mail is an independent project by [Baltazar Studios](https://baltazarstudios.com) and is not affiliated with Yahoo.

![Baltazar Mail in the light theme: folders, message list and preview, with photo attachments listed under the message](docs/screenshots/light.png)

## Features

- **Reading:** three-column or stacked layout with resizable panes, eleven light and dark palettes (one of them plain black on white), a Starred view across all folders, and remote images loaded automatically except in Spam and Trash. In a dark theme messages are darkened to match, keeping their colours' hues and leaving images alone; the ☀ button in the message header shows them in their original colours instead.
- **Mailbox actions:** read/unread, star, archive, move, delete, spam and not spam, on one message or a selection, with multi-level undo and redo.
- **Search:** scoped to the open folder and its subfolders, with matches in other folders listed below a divider. Words must all match; `AND`, `OR`, `NOT`, parentheses, quoted phrases and the fields `from:` `to:` `subject:` `has:attachment` `is:starred` `is:unread` `after:` `before:` refine it. The `?` in the search box explains the syntax.
- **Writing:** new message, reply, reply all and forward (with the original's attachments), drafts saved automatically, rich-text or plain-text editing with fonts, sizes and colours, pasted or dropped inline images, attachments, and undo-send.
- **Address book:** built from your own Inbox and Sent headers, with autocomplete ranked by recency and use. Automated senders you never wrote to (noreply, notifications, bulk-mail domains) are left out of suggestions. Settings › Address book lists it with a filter and hide/restore, also in bulk.
- **Attachments:** listed under the message and previewed in place: PDF with selectable text and zoom, Word, Excel and other spreadsheets, PowerPoint and older Office formats through Yahoo's converter, images, text and code, CSV, HTML, audio, video and ZIP listings. Anything else up to 100 KB can be read as text, or as a hex dump when it is binary.
- **Also:** contact cards on hover, printing, and all settings kept between sessions.

Attachments open in place, here a two-page PDF with selectable text and zoom; photos, Office documents and spreadsheets open the same way:

![Attachment viewer showing a PDF review document over the message](docs/screenshots/viewer.png)

The dark theme with the message list above the preview; the message is darkened to match:

![Dark theme with the message list above the preview and a darkened message](docs/screenshots/dark.png)

Settings:

![Settings: layout, theme and palettes, writing, images, behaviour and the address book](docs/screenshots/settings.png)

All names, addresses and messages in these screenshots are invented; `node tools/screenshots.js` regenerates them.

## Install

1. Download `baltazar-mail-<version>.zip` from the [latest release](https://github.com/gdevic/baltazar-mail/releases/latest) and unzip it into a folder you will keep; it contains one folder, `baltazar-mail`.
2. Open `edge://extensions` (or `chrome://extensions`) and turn on Developer mode.
3. Click Load unpacked and select the `baltazar-mail` folder.
4. Be signed in to mail.yahoo.com in the same browser profile, then click the Baltazar Mail toolbar icon.

To update, unzip the new release over the same `baltazar-mail` folder and click Reload on the extensions page. Removing the extension instead would delete its settings and address book. From a clone of this repository, load the `ext/` folder the same way.

To publish a release, set `version` in `ext/manifest.json`, commit, and push a matching tag (`git tag v0.13.4 && git push origin v0.13.4`), or run the Release workflow from the Actions tab with that tag. The workflow checks the tag against the manifest, builds the ZIP and creates the release.

Baltazar Mail relies on an undocumented Yahoo API that can change at any time; what is known about it is in `docs/yahoo-v3.md`. 
## Security and privacy

The extension talks only to Yahoo, with one exception: a copy installed from a release ZIP asks GitHub once a day whether a newer release exists, sending no cookies and nothing about you or your mail. It has no server, analytics or telemetry, and parses attachments in a sandbox with no access to your session. Details are in [SECURITY.md](SECURITY.md), including how to report a vulnerability, and in [PRIVACY.md](PRIVACY.md), including every host contacted, everything stored and every permission.

## License

MIT, see [LICENSE](LICENSE). The bundled third-party libraries keep their own licences (Apache-2.0 and MIT), listed in [`ext/vendor/README.md`](ext/vendor/README.md).
