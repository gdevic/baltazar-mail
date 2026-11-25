# Baltazar Mail for Gmail™: store submission kit

Everything to paste into the Chrome Web Store Developer Dashboard and Microsoft Partner Center for Baltazar Mail for Gmail. It is an item of its own in each store, apart from the Yahoo Mail™ edition's (whose kit is in `store/yahoo`), so each store gives its copy an id of its own. The package is the release's `baltazar-mail-gmail-<version>-store.zip`, the built extension with `manifest.json` at the top level as the stores require; an update's version must be higher than the one published. It carries no OAuth client, so a store copy opens, like a ZIP copy, with the setup guide, where each user makes a free Google™ client of their own (Personal mode, about two minutes), and the guide shows that copy's redirect address. A package that signs in with one click instead needs a shared client that Google has verified for the restricted Gmail scope, built in with `gmail/local.json` (`node tools/build.js gmail --store`, then zip the contents of `dist/baltazar-mail-gmail`); see `docs/google-setup.md`. The extension's name and short description come from the manifest. Images are in this folder; `node tools/screenshots.js --store gmail` regenerates them.

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

> Baltazar Mail for Gmail™ is an alternative reading and writing interface for the user's own Gmail account. It shows the user's labels and messages, previews attachments, and sends mail, through the Gmail API with a Google™ sign-in the user grants in the extension.

Permission justifications:

- `identity`: Opens Google™'s own sign-in page in a window when the user clicks Sign in with Google, through the OAuth client the user set up, and receives the access token Google answers with. The extension never sees a password. The token is renewed silently while the browser keeps the user's Google session, and Sign out in Settings revokes it.
- `storage`: Keeps the user's settings (layout, theme and contrast, sizes, fonts, intervals), the time of the last release check, the format of drafts saved here, the labels whose list of attachments includes those of the labels nested under them, when the mail tab was last looked at (for the new-mail dot), when the browser put it to sleep in the last week (so Settings can say whether background mail checks were interrupted), when the first build of Contacts may start (two minutes after the mailbox first opened), the Client ID of the Google™ client the user set up and, during the setup, the step its guide is at, and, until Sign out, the address of the Google account signed in, so a silent renewal asks for that account only; and, for the browser session only, the Google access token, so the extension does not ask Google for every request, and a message being printed, until the print page has read it.
- Host permission `https://gmail.googleapis.com/*`: All mailbox operations (labels, message lists, search, reading, attachments, moving, deleting, drafts and sending) go to the Gmail™ API on this host, with the token from the user's sign-in.
- Host permission `https://oauth2.googleapis.com/*`: Revoking the token when the user signs out.
- OAuth scope `https://mail.google.com/`: The extension reads, writes and sends mail, and permanently deletes messages when the user empties Trash or Spam or deletes a message already in Trash; the narrower Gmail™ scopes do not allow permanent deletion.

Remote code: No, I am not using remote code. All code ships in the package; the Content Security Policy allows scripts only from the extension itself.

Data usage, what the extension handles (recommended declarations; all of it stays on the user's computer or goes only to Google):

- Personal communications: email messages and attachments, fetched from Gmail when the user opens them and shown on screen; not stored. An attachment is saved to the computer only when the user downloads it.
- Personally identifiable information: names and email addresses from the headers of the user's own mail, kept locally for the Contacts list and for suggestions while writing and searching, and written to a file only when the user exports Contacts.
- Authentication information: the Google access token, kept in the browser's session storage and cleared when the browser closes, and the address of the Google account signed in, kept in local storage until Sign out.

Certify: data is not sold, not used for purposes unrelated to the single purpose, and not used for creditworthiness or lending. No analytics, telemetry or advertising.

Privacy policy URL: https://github.com/gdevic/baltazar-mail/blob/main/PRIVACY.md

## Store listing (English)

The description names features in sentences, not lists: the Chrome Web Store rejects runs of format or product names as keyword spam.

Extension name: Baltazar Mail for Gmail™ (from the manifest)

Short description (from the manifest): A fast, ad-free client for Gmail™ that signs in with your Google™ account. Not affiliated with Google.

Description:

> Baltazar Mail for Gmail™ is a fast, clean, ad-free way to read and write your Gmail. It opens in its own tab, where the first time a short guide helps you make a free Google™ client of your own, in about two minutes, on Google's own pages; then click Sign in with Google, Google asks which account and what permission, and the extension keeps you signed in while the browser does.
>
> Reading: a three-column or stacked layout with resizable panes, sixteen light and dark palettes in different hues with a contrast slider, an adjustable text size, and a dark reading pane that darkens messages to match while keeping their hues and leaving images untouched. Your labels are the folders, nested as you named them, and a Starred view collects starred mail from every one of them but Spam and Trash. A message's whole conversation can be listed from all your labels, each reply beneath the message it answers. Tracking pictures are taken out of every message, and links can be cleaned of tracking tags and of redirects that carry their destination.
>
> Mailbox: mark messages read or unread, star, archive, move, delete or report them as spam, one at a time or as a selection, with multi-level undo and redo and an undo history that takes back an older action alone. Labels can be created, renamed, moved and nested, empty ones deleted, and Trash and Spam emptied, all from a right-click menu.
>
> Search: limited to the open label and the ones nested under it, with matches elsewhere listed below, and simple operators written as in Gmail (from:, to:, subject:, has:attachment, is:starred, dates) to narrow it down.
>
> Writing: new messages, replies that keep their thread, and forwards that keep the original's attachments, rich or plain text, inline images that can be resized, automatic drafts and undo-send. A reply or forward quotes the original as you read it.
>
> Contacts: everyone in your own mail, learned from the message headers and suggested as you write, with automated senders left out. Pin, hide, rename or delete people, see the recent mail with each, write to several at once, and export the list to a text file you can edit and import back.
>
> Attachments open in place: documents, spreadsheets, images and media are previewed without downloading; documents are read inside an isolated sandbox with no access to your session. A label's attachments can be listed in one place, with those of the labels nested under it if you like, and several files downloaded together as one ZIP file.
>
> Also: a dot on the tab and the toolbar button when new mail arrives in the background, printing, and keyboard shortcuts throughout.
>
> Privacy: no server, no analytics, no ads. Your mail goes only between your browser and Google; pictures in a message load from the sender's own server, when your setting lets them. The source code is public at github.com/gdevic/baltazar-mail.
>
> Baltazar Mail for Gmail is an independent project. Gmail and Google are trademarks of Google LLC. Baltazar Mail for Gmail is not created by, affiliated with, or endorsed by Google LLC.

Logo: `logo-300.png`

Small promotional tile (440 x 280): `promo-small.png`

Large promotional tile (1400 x 560): `promo-large.png`

Screenshots (1280 x 800), in this order: `screenshots/light.png`, `screenshots/viewer.png`, `screenshots/dark.png`, `screenshots/contacts.png`, `screenshots/attachments.png`, `screenshots/settings.png`, `screenshots/setup.png` (the page a new install opens with). The Chrome Web Store takes five at most: leave out `screenshots/viewer.png` and `screenshots/contacts.png` there.

Search terms (7 terms, 14 words): gmail; gmail client; email client; webmail; ad-free email; dark mode email; pdf attachment viewer

## Notes for certification

> To test: the extension opens its tab when installed (afterwards, click the Baltazar Mail for Gmail™ toolbar button). Its sign-in page guides the reviewer through making a Google™ client on Google's own Personal mode page, about two minutes: copy the redirect address the page shows, create a client of type Web application with it, paste its Client ID, switch on the Gmail API, then Sign in with Google with the same account (the reviewer's own, or a test account; nothing in the account is changed unless the reviewer moves, deletes or sends mail). Things to try: open a label and a message, search (the ? beside the box explains the syntax), open an attachment from the strip under a message, right-click a label for Show attachments, open Contacts at the bottom of the folder list, write a message to yourself with New message, and open Settings with the gear button, where Sign out revokes the sign-in.
>
> How it works: the extension uses the Gmail API (gmail.googleapis.com) with an OAuth 2.0 token obtained through chrome.identity's web auth flow from Google's own sign-in page, through the user's own OAuth client; it never sees or stores the password, and uses no client secret. The token lives in session storage and is renewed silently; the extension opens Google's window only when the sign-in button is clicked.
>
> No remote code. No analytics or third-party services: an install from this store talks only to Google, apart from images in messages, which load from the senders' own servers when the user's setting allows. (A copy from GitHub, installed with Load unpacked, also asks GitHub once a day for a newer version; a store install never does.)
>
> Attachments are parsed by bundled open-source libraries (PDF.js, docx-preview, SheetJS, JSZip, DOMPurify) inside a manifest sandbox page with an opaque origin and no extension APIs. Source, security notes and a privacy policy: https://github.com/gdevic/baltazar-mail
