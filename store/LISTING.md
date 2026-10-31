# Microsoft Edge Add-ons: submission kit

Everything to paste into Partner Center for Baltazar Mail. Upload `baltazar-mail-<version>-store.zip` from GitHub Releases as the package: the same files as the release ZIP, with `manifest.json` at the top level as the store requires. Images are in this folder; `node tools/screenshots.js --store` regenerates them.

## Account

Individual account, publisher display name "Goran Devic".

## Availability

Visibility: Public. Markets: all.

## Properties

- Category: Communication if offered, otherwise Productivity.
- Website: https://github.com/gdevic/baltazar-mail
- Support contact: https://github.com/gdevic/baltazar-mail/issues
- Mature content: not checked.

## Privacy

Single purpose description:

> Baltazar Mail is an alternative reading and writing interface for the user's own Yahoo Mail account. It shows the user's folders and messages, previews attachments, and sends mail, using the Yahoo sign-in the user already has in this browser.

Permission justifications:

- `storage`: Keeps the user's settings (layout, theme, fonts, intervals) on this computer, and, for the browser session only, the Yahoo session values that Yahoo's own web page uses, so the extension does not reload Yahoo's page for every request.
- `declarativeNetRequest`: Yahoo's mail servers accept requests only when they come from mail.yahoo.com. One rule, registered by the extension at start-up and shipped in its code, sets the Origin and Referer headers to https://mail.yahoo.com on the extension's own requests to Yahoo's mail hosts. The rule is limited to requests the extension itself initiates (initiatorDomains is the extension's own ID), to XHR/fetch requests only, and to mail.yahoo.com and its subdomains. It changes nothing on any web page the user visits.
- Host permission `https://mail.yahoo.com/*`: All mailbox operations (folders, message lists, search, reading, moving, deleting, drafts and sending) go to Yahoo's mail API on this host, with the user's existing Yahoo sign-in.
- Host permission `https://*.mail.yahoo.com/*`: Yahoo serves message source (used to show attachments), attachment thumbnails and images embedded in messages from subdomains of mail.yahoo.com (apis.mail.yahoo.com, cloud-apis.mail.yahoo.com).

Remote code: No, I am not using remote code. All code ships in the package; the Content Security Policy allows scripts only from the extension itself.

Data usage, what the extension handles (recommended declarations; all of it stays on the user's computer or goes only to Yahoo):

- Personal communications: email messages and attachments, fetched from Yahoo when the user opens them and shown on screen; not stored.
- Personally identifiable information: names and email addresses from the user's own Inbox and Sent headers, kept in a local address book for suggestions while writing.
- Authentication information: the Yahoo session values Yahoo's own web page uses, kept in the browser's session storage and cleared when the browser closes.

Certify: data is not sold, not used for purposes unrelated to the single purpose, and not used for creditworthiness or lending. No analytics, telemetry or advertising.

Privacy policy URL: https://github.com/gdevic/baltazar-mail/blob/main/PRIVACY.md

## Store listing (English)

Extension name: Baltazar Mail (from the manifest)

Short description (from the manifest): A fast, ad-free client for Yahoo Mail that reuses your existing Yahoo sign-in. Not affiliated with Yahoo.

Description:

> Baltazar Mail is a fast, clean, ad-free way to read and write your Yahoo Mail. It opens in its own tab and uses the Yahoo sign-in you already have in the browser, so there is nothing to set up: sign in to mail.yahoo.com once, then click the Baltazar Mail button.
>
> Reading: three-column or stacked layout with resizable panes, ten light and dark palettes, and a dark reading pane that darkens messages to match while keeping their colours and images. A Starred view collects flagged mail from every folder.
>
> Mailbox: read and unread, star, archive, move, delete, spam and not spam, on one message or a selection, with multi-level undo and redo.
>
> Search: scoped to the open folder and its subfolders, with matches elsewhere listed below. AND, OR, NOT, quoted phrases and fields such as from:, to:, subject:, has:attachment and after: refine it.
>
> Writing: new message, reply, reply all and forward with the original's attachments, rich or plain text, inline images, automatic drafts and undo-send. Address suggestions come from your own Inbox and Sent, with automated senders left out.
>
> Attachments open in place: PDF with selectable text and zoom, Word, Excel and other spreadsheets, PowerPoint, images, text and code, CSV, audio, video and ZIP listings. Files are parsed in an isolated sandbox with no access to your session.
>
> Privacy: no server, no analytics, no ads. Your mail goes only between your browser and Yahoo. The source code is public at github.com/gdevic/baltazar-mail.
>
> Baltazar Mail is an independent project and is not affiliated with, endorsed by or sponsored by Yahoo. Yahoo and Yahoo Mail are trademarks of their owner.

Logo: `logo-300.png`

Screenshots, in this order: `screenshots/light.png`, `screenshots/viewer.png`, `screenshots/dark.png`, `screenshots/settings.png`

Search terms: yahoo mail, email client, webmail, ad-free, dark mode, attachments

## Notes for certification

> To test: sign in to https://mail.yahoo.com in the same browser profile with the test account below, then click the Baltazar Mail toolbar button. The extension opens its own tab with the mailbox. The test account has a few messages, including attachments, to try reading, search, attachment previews and sending.
>
> Test account: <Yahoo address> / <password>
>
> How it works: the extension calls the same web API that Yahoo's own mail page uses, with the user's existing Yahoo sign-in; it never sees or stores the password. Yahoo's servers accept those calls only when they come from mail.yahoo.com, so a single declarativeNetRequest session rule sets Origin and Referer to https://mail.yahoo.com, limited to requests initiated by this extension (initiatorDomains), XHR/fetch only, on mail.yahoo.com and its subdomains.
>
> No remote code. No analytics or third-party services: an install from this store talks only to Yahoo. (The GitHub release build, installed with Load unpacked, also checks GitHub once a day for a newer version; that check is switched off for store installs.)
>
> Attachments are parsed by bundled open-source libraries (PDF.js, docx-preview, SheetJS, JSZip, DOMPurify) inside a manifest sandbox page with an opaque origin and no extension APIs. Source, security notes and a privacy policy: https://github.com/gdevic/baltazar-mail
