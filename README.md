# YMail

A fast, ad-free front end for Yahoo Mail, packaged as a Chromium (Edge/Chrome) extension. It reuses the Yahoo sign-in already present in the browser and talks to the same API that Yahoo's own web client uses, so it is as quick as the official UI without any of its clutter. Everything works with the mouse; press `?` in the app for keyboard shortcuts.

## Features

- **Reading:** three-column or stacked layout with resizable panes, ten light and dark palettes, a Starred view across all folders, and remote images loaded automatically except in Spam and Trash.
- **Mailbox actions:** read/unread, star, archive, move, delete, spam and not spam, on one message or a selection, with multi-level undo and redo.
- **Search:** scoped to the open folder and its subfolders, with matches in other folders listed below a divider. Words must all match; `AND`, `OR`, `NOT`, parentheses, quoted phrases and the fields `from:` `to:` `subject:` `has:attachment` `is:starred` `is:unread` `after:` `before:` refine it. The `?` in the search box explains the syntax.
- **Writing:** new message, reply, reply all and forward (with the original's attachments), drafts saved automatically, rich-text or plain-text editing with fonts, sizes and colours, pasted or dropped inline images, attachments, and undo-send.
- **Address book:** built from your own Inbox and Sent headers, with autocomplete ranked by recency and use. Settings › Address book lists it with a filter and hide/restore, also in bulk.
- **Attachments:** listed under the message and previewed in place: PDF with selectable text and zoom, Word, Excel and other spreadsheets, PowerPoint and older Office formats through Yahoo's converter, images, text and code, CSV, HTML, audio, video and ZIP listings.
- **Also:** contact cards on hover, printing, and all settings kept between sessions.

## Install

1. Open `edge://extensions` (or `chrome://extensions`) and enable Developer mode.
2. Click Load unpacked and select the `ext/` folder.
3. Be signed in to mail.yahoo.com in the same browser profile, then click the YMail toolbar icon.

YMail relies on an undocumented Yahoo API that can change at any time; what is known about it is in `docs/yahoo-v3.md`. Third-party libraries and their licences are listed in `ext/vendor/README.md`.
