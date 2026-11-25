# Baltazar Mail: store submission kit

Everything to paste into the Chrome Web Store Developer Dashboard and Microsoft Partner Center for Baltazar Mail, the Yahoo Mail™ edition. It is published as [Baltazar Mail on the Chrome Web Store](https://chromewebstore.google.com/detail/baltazar-mail/kkphbfhheikioedcgnjmeldabekdcnib) (`kkphbfhheikioedcgnjmeldabekdcnib`) and [Baltazar Mail on Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/baltazar-mail/fmfafokapbejponlbknighiecagfcnai) (`fmfafokapbejponlbknighiecagfcnai`). An update uploads the new package to those items, which keeps their ids, so installed copies keep their settings and Contacts. The package is `baltazar-mail-yahoo-<version>-store.zip` from GitHub Releases: the same files as the release ZIP, with `manifest.json` at the top level as the stores require; its version must be higher than the one published. The extension's name and short description come from the manifest. Images are in this folder; `node tools/screenshots.js --store yahoo` regenerates them. The Gmail™ edition is an item of its own in each store, with its kit in `store/gmail`.

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

> Baltazar Mail is an alternative reading and writing interface for the user's own Yahoo Mail™ account. It shows the user's folders and messages, previews attachments, and sends mail, using the Yahoo™ sign-in the user already has in this browser.

Permission justifications:

- `storage`: Keeps the user's settings (layout, theme, fonts, intervals) on this computer, and, for the browser session only, the Yahoo session values that Yahoo's own web page uses, so the extension does not reload Yahoo's page for every request.
- `declarativeNetRequest`: Yahoo™'s mail servers accept requests only when they come from mail.yahoo.com. One rule, registered by the extension at start-up and shipped in its code, sets the Origin and Referer headers to https://mail.yahoo.com on the extension's own requests to Yahoo's mail hosts. The rule is limited to requests the extension itself initiates (initiatorDomains is the extension's own ID), to XHR/fetch requests only, and to mail.yahoo.com and its subdomains. It changes nothing on any web page the user visits.
- Host permission `https://mail.yahoo.com/*`: All mailbox operations (folders, message lists, search, reading, moving, deleting, drafts and sending) go to Yahoo™'s mail API on this host, with the user's existing Yahoo sign-in.
- Host permission `https://*.mail.yahoo.com/*`: Yahoo™ serves message source (used to show and download attachments), attachment thumbnails and images embedded in messages from subdomains of mail.yahoo.com (apis.mail.yahoo.com, cloud-apis.mail.yahoo.com).

Remote code: No, I am not using remote code. All code ships in the package; the Content Security Policy allows scripts only from the extension itself.

Data usage, what the extension handles (recommended declarations; all of it stays on the user's computer or goes only to Yahoo™):

- Personal communications: email messages and attachments, fetched from Yahoo when the user opens them and shown on screen; not stored. An attachment is saved to the computer only when the user downloads it.
- Personally identifiable information: names and email addresses from the headers of the user's own mail, kept locally for the Contacts list and for suggestions while writing and searching, and written to a file only when the user exports Contacts.
- Authentication information: the Yahoo session values Yahoo's own web page uses, kept in the browser's session storage and cleared when the browser closes.

Certify: data is not sold, not used for purposes unrelated to the single purpose, and not used for creditworthiness or lending. No analytics, telemetry or advertising.

Privacy policy URL: https://github.com/gdevic/baltazar-mail/blob/main/PRIVACY.md

## Store listing (English)

The description names features in sentences, not lists: the Chrome Web Store rejects runs of format or product names as keyword spam.

Extension name: Baltazar Mail (from the manifest)

Short description (from the manifest): A fast, ad-free client for Yahoo Mail™ that reuses your existing Yahoo™ sign-in. Not affiliated with Yahoo.

Description:

> Baltazar Mail is a fast, clean, ad-free way to read and write your Yahoo Mail™. It opens in its own tab and uses the Yahoo™ sign-in you already have in the browser, so there is nothing to set up: sign in to mail.yahoo.com once, then click the Baltazar Mail button.
>
> Reading: a three-column or stacked layout with resizable panes, sixteen light and dark palettes in different hues with a contrast slider, an adjustable text size, and a dark reading pane that darkens messages to match while keeping their hues and leaving images untouched. A Starred view collects flagged mail from every folder but Spam and Trash, and a message's whole conversation can be listed from all your folders, each reply beneath the message it answers. Tracking pictures are taken out of every message, and links can be cleaned of tracking tags and of redirects that carry their destination.
>
> Mailbox: mark messages read or unread, star, archive, move, delete or report them as spam, one at a time or as a selection, with multi-level undo and redo and an undo history that takes back an older action alone. Folders can be created, renamed, moved and nested, empty ones deleted, and Trash and Spam emptied, all from a right-click menu.
>
> Search: limited to the open folder and its subfolders, with matches elsewhere listed below, and simple operators to narrow it down.
>
> Writing: new messages, replies, and forwards that keep the original's attachments, rich or plain text, inline images that can be resized, automatic drafts and undo-send. A reply or forward quotes the original as you read it.
>
> Contacts: everyone in your own mail, learned from the message headers and suggested as you write, with automated senders left out. Pin, hide, rename or delete people, see the recent mail with each, write to several at once, and export the list to a text file you can edit and import back.
>
> Attachments open in place: documents, spreadsheets, presentations, images and media are previewed without downloading; documents are read inside an isolated sandbox with no access to your session. A folder's attachments can be listed in one place, with its subfolders' if you like, and several files downloaded together as one ZIP file.
>
> Also: a dot on the tab and the toolbar button when new mail arrives in the background, printing, and keyboard shortcuts throughout.
>
> Privacy: no server, no analytics, no ads. Your mail goes only between your browser and Yahoo. The source code is public at github.com/gdevic/baltazar-mail.
>
> Baltazar Mail is an independent project. Yahoo and Yahoo Mail are trademarks of Yahoo Inc. Baltazar Mail is not created by, affiliated with, or endorsed by Yahoo Inc.

Logo: `logo-300.png`

Small promotional tile (440 x 280): `promo-small.png`

Large promotional tile (1400 x 560): `promo-large.png`

Screenshots (1280 x 800), in this order: `screenshots/light.png`, `screenshots/viewer.png`, `screenshots/dark.png`, `screenshots/contacts.png`, `screenshots/attachments.png`, `screenshots/settings.png`. The Chrome Web Store takes five at most: leave out `screenshots/contacts.png` there.

Search terms (7 terms, 16 words): yahoo mail; yahoo mail client; email client; webmail; ad-free email; dark mode email; pdf attachment viewer

## Notes for certification

> No test account is included: Baltazar Mail works with any Yahoo Mail™ account, the reviewer's own or an existing test one. A shared account cannot be provided reliably, because Yahoo™ verifies every new account with a personal mobile number and challenges sign-ins from an unfamiliar computer with a code sent to that phone. If access is still needed, please ask through Partner Center.
>
> To test: in the same browser profile, sign in to https://mail.yahoo.com with any Yahoo account, then click the Baltazar Mail toolbar button, which opens the mailbox in a tab of its own. Things to try: open a folder and a message, search (the ? in the search box explains the syntax), open an attachment from the strip under a message, right-click a folder for Show attachments, open Contacts at the bottom of the folder list, write a message to yourself with New message, and open Settings with the gear button. Nothing is changed in the account unless the reviewer moves, deletes or sends mail.
>
> How it works: the extension calls the same web API that Yahoo's own mail page uses, with the user's existing Yahoo sign-in; it never sees or stores the password. Yahoo's servers accept those calls only from mail.yahoo.com, so one declarativeNetRequest session rule sets Origin and Referer to https://mail.yahoo.com, limited to requests this extension initiates (initiatorDomains), XHR/fetch only, on mail.yahoo.com and its subdomains.
>
> No remote code. No analytics or third-party services: an install from this store talks only to Yahoo. (A copy from GitHub, installed with Load unpacked, also asks GitHub once a day for a newer version; a store install never does.)
>
> Attachments are parsed by bundled open-source libraries (PDF.js, docx-preview, SheetJS, JSZip, DOMPurify) inside a manifest sandbox page with an opaque origin and no extension APIs. Source, security notes and a privacy policy: https://github.com/gdevic/baltazar-mail
