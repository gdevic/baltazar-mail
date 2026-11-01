# Privacy

Baltazar Mail is a browser extension that shows your Yahoo Mail. It has no server, no account of its own, no analytics and no telemetry. Its author receives nothing about you or your mail.

## Where your data goes

The extension talks to Yahoo, using the Yahoo sign-in already in your browser, and, when installed from a release ZIP, to GitHub for one thing:

| Host | Used for |
|---|---|
| `mail.yahoo.com` | reading the session values Yahoo's own web page uses, and every mailbox operation: folders, lists, search, reading, moving, deleting, drafts, sending |
| `apis.mail.yahoo.com` | the raw source of a message, from which attachments are taken for preview and download |
| `cloud-apis.mail.yahoo.com` | attachment thumbnails, images embedded in messages, and Yahoo's text extraction for documents |
| `*.yusercontent.com` | images in messages, which Yahoo routes through this proxy |
| `api.github.com` | only for a copy installed from a release ZIP (Load unpacked), which cannot update itself: once a day, a request for the latest release number of this project, so Settings can say when an update is available. It carries no cookies, no account or mail data and no identifier; GitHub sees only what any web request shows (IP address and browser). The answer is used only for the version comparison; nothing is downloaded or installed. An install from a browser store is updated by the browser and never contacts GitHub |

When a document format has no viewer in the extension (for example PowerPoint), the preview asks Yahoo's own document converter to render it. The file is already stored at Yahoo; nothing is sent elsewhere.

The extension's Content Security Policy (in `ext/manifest.json`) makes the browser block any other destination, so these are the only places the extension can send anything.

## What is stored on your computer

| Data | Where | Why |
|---|---|---|
| Settings (layout, theme and contrast, sizes, fonts, intervals, pane sizes, expanded folders) | the extension's local storage | so your choices persist |
| The latest release number and when it was checked | the extension's local storage | to ask GitHub once a day, or an hour later after a failed check |
| Address book: names, addresses, how many messages you sent to or received from each, last date, and whether you hid it from suggestions | the extension's IndexedDB | address suggestions while writing; built from the headers of your own Inbox and Sent |
| Yahoo session values and the mailbox id | the extension's session storage, cleared when the browser closes | to call Yahoo without reloading its page |
| A message being printed | session storage, removed as soon as the print page reads it | to hand it to the print page |

Message contents are not stored; they are fetched from Yahoo when you open a message. Removing the extension from the browser deletes all of the above.

## Permissions

| Permission | Why |
|---|---|
| Access to `mail.yahoo.com` and `*.mail.yahoo.com` | to call Yahoo Mail with your existing sign-in |
| `storage` | settings, the release check, the session values and print hand-off described above |
| `declarativeNetRequest` | Yahoo's servers only accept requests that come from `mail.yahoo.com`; one rule sets the `Origin` and `Referer` headers on the extension's own requests to Yahoo |

## Contact

Questions about privacy can be raised as an issue on https://github.com/gdevic/baltazar-mail. Baltazar Mail is an independent project by Baltazar Studios and is not affiliated with Yahoo.
