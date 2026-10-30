# YMail

A fast, ad-free front end for Yahoo Mail, packaged as a Chromium (Edge/Chrome) extension. Everything works with the mouse; the keyboard shortcuts are there for those who want them. It reuses the Yahoo sign-in already present in the browser and talks to the same `ws/v3` batch API that Yahoo's own web client uses, so it is as quick as the official UI without any of its chrome.

Status: browsing, search, reading, mailbox actions (read/unread, star, archive, move, delete) with multi-level undo, and compose, reply, reply all, forward with drafts, attachments, rich-text or plain-text editing, undo-send, and an address book with autocomplete built from your own Inbox and Sent headers. Also: spam / not spam, forwarding with the original's attachments, attachment previews, and contact cards on hover. Conversation threading is next.

## Install

1. Open `edge://extensions` (or `chrome://extensions`), enable Developer mode.
2. Load unpacked, select the `ext/` folder.
3. Be signed in to mail.yahoo.com in the same browser profile, then click the toolbar icon.

## Keyboard shortcuts (optional)

| Key | Action |
|---|---|
| `j` / `k`, arrows | next / previous message |
| `Enter`, `o` | open selected message |
| `/` | search; `Esc` clears |
| `g i` `g s` `g t` `g d` | Inbox, Sent, Trash, Drafts |
| `g f` | focus folder filter; type, arrows, `Enter` |
| `x` | select / deselect (Ctrl-click toggles, Shift-click ranges, Ctrl+A all) |
| `e` `#` `v` `u` `s` | archive, delete, move, read/unread, star; apply to the selection |
| `!` | spam; in Spam, not spam (back to Inbox) |
| `z` / `Shift+Z` | undo / redo; the status bar names the next undo |
| `c`, `r`, `a`, `f` | new message, reply, reply all, forward |
| `Ctrl+Enter` | send (held for the undo-send delay; `z` cancels) |
| `R` | refresh current list |
| `n` | load next 100 |
| `i` | load remote images in the open message |
| `t` | toggle dark / light |
| `,` | settings: layout, theme palettes, poll interval, row height |
| `?` | key reference |

## Layout

- `ext/` the extension: `manifest.json`, `background.js` (toolbar button and header rules), `api.js` (protocol adapter, the only file that knows the wire format), `mail.html/css/js` (UI), `compose.js` (composer), `contacts.js` (address book in IndexedDB), `themes.js` (palettes).
- `docs/yahoo-v3.md` what is known about the API, derived from captured traffic.
- `tools/har2spec.py` turns a DevTools HAR export into a redacted endpoint catalogue; `tools/ym.py` a stdlib-only CLI against the API; `tools/smoke.js` and `tools/themeshots.js` Playwright tests of the page against a mocked backend, `tools/runtime.js` the same with the real extension loaded into Chromium, covering reading, folder switches and compose/send (`node tools/runtime.js`).

## How it works

The extension page fetches `mail.yahoo.com` once to read `wssid`, `appId` and the mailbox id from the page's inline bootstrap data, then issues batch calls to `mail.yahoo.com/c/ws/v3/batch` with the browser's cookies. A `declarativeNetRequest` rule rewrites `Origin` and `Referer` on those requests, which Yahoo's edge proxy requires. Message HTML, already sanitised by Yahoo, is rendered in a sandboxed iframe with a CSP that blocks scripts and, by default, remote images.

This relies on an undocumented API that can change at any time. Everything protocol-specific lives in `ext/api.js` and `docs/yahoo-v3.md`.
