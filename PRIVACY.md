# Privacy

Baltazar Mail (the Yahoo Mail™ edition) and Baltazar Mail for Gmail™ are browser extensions that show your mail. They have no server, no account of their own, no analytics and no telemetry. Their author receives nothing about you or your mail. The two extensions share their code and differ only in the mail service they talk to; this page covers both, and says where they differ.

## Where your data goes

Each extension talks to its mail service and, when loaded with Load unpacked (a release ZIP or a copy built from the source), to GitHub for one thing:

| Host | Used for |
|---|---|
| `api.github.com` (both) | only for a copy loaded with Load unpacked (a release ZIP or a copy built from the source), which cannot update itself: once a day, a request for the latest release number of this project, so Settings can say when an update is available. It carries no cookies, no account or mail data and no identifier; GitHub sees only what any web request shows (IP address and browser). The answer is used only for the version comparison; nothing is downloaded or installed. An install from a browser store is updated by the browser and never contacts GitHub |

Baltazar Mail (the Yahoo Mail edition), using the Yahoo™ sign-in already in your browser:

| Host | Used for |
|---|---|
| `mail.yahoo.com` | reading the session values Yahoo's own web page uses, and every mailbox operation: folders, lists, search, reading, moving, deleting, drafts, sending |
| `apis.mail.yahoo.com` | the raw source of a message, from which attachments are taken for preview and download |
| `cloud-apis.mail.yahoo.com` | attachment thumbnails, images embedded in messages, and Yahoo's text extraction for documents |
| `*.yusercontent.com` | images in messages, which Yahoo routes through this proxy; Yahoo fetches each from its sender's server, so a picture shown can still tell the sender that, and when, the message was read, though not your IP address |

When a document format has no viewer in the extension (for example PowerPoint), the Yahoo extension's preview asks Yahoo's own document converter to render it. The file is already stored at Yahoo; nothing is sent elsewhere.

Baltazar Mail for Gmail, with the Google™ sign-in you give it:

| Host | Used for |
|---|---|
| `accounts.google.com` | Google's own sign-in page, opened in a window of its own when you click Sign in with Google, and used silently to renew the sign-in while the browser keeps your Google session |
| `gmail.googleapis.com` | every mailbox operation through the Gmail API: labels, lists, search, reading, attachments, moving, deleting, drafts, sending |
| `oauth2.googleapis.com` | revoking the sign-in when you click Sign out in Settings; the token goes in the request's body |
| the senders' own servers | images in messages, when the setting lets them load: Gmail's API hands over the message as the sender wrote it, so each image is fetched from wherever the sender put it, which tells that server your IP address and that the message was opened, and, through the message's styles, such things as how wide your window is, whether you read in a dark theme or with a mouse, and which parts of the message the pointer went over. The default is to load them automatically except in Spam and Trash; Settings can limit that to when you ask |

The setup guide on the Gmail extension's sign-in page links to pages of the Google Cloud™ console (`console.cloud.google.com`), where you make the Google client the extension signs in through. Each opens in a tab of its own when you click it, like any link; the extension itself sends nothing there.

The extension's Content Security Policy (in its `manifest.json`) makes the browser block any other destination for the extension's own requests, so mail and everything else the extension sends goes only to these hosts. The Yahoo extension's pages may load images only from Yahoo's image proxy. The Gmail extension's pages may load images (including those a message's styles name) from any `https:` host, which is what lets a message's images load from their senders' servers. Such a request is made by the message's own HTML and styles, so it can tell that server what the message itself is able to: that it was opened and when, your IP address and browser, and what the message's styles can see of the page it is shown in (the window's width, a dark or light theme, the kind of pointer, where the pointer is), never what other messages or the rest of the app hold. It carries no referrer and never your Google sign-in.

## What is stored on your computer

| Data | Where | Why |
|---|---|---|
| Settings: layout, theme, palettes and contrast, text and row size, the message zoom and the zoom of a contact's recent messages, pane sizes, expanded folders, writing font, size and HTML or plain text, when images load, whether links in messages are cleaned of tracking, whether dark mode shows messages in their original colours, the new-mail check, mark-read and undo-send intervals, and whether the tab is kept awake in the background | the extension's local storage | so your choices persist |
| The folders whose list of attachments includes their subfolders' attachments: folder ids, under the address of the account they belong to | the extension's local storage; a folder's entry is removed when the folder is deleted here, and the account's by Sign out (Gmail) | so a folder's attachments open as you left them |
| When you last looked at the mail tab | the extension's local storage | so a tab that opens in the background shows the new-mail dot for mail that arrived while the browser was closed |
| When the browser put the mail tab to sleep in the last 7 days and for how long (at most 50 times kept), and that the note about a long sleep was shown | the extension's local storage | so Settings can say whether mail checks in the background were interrupted, and the note appears once |
| The latest release number and when it was checked | the extension's local storage | to ask GitHub once a day, or an hour later after a failed check |
| For each draft saved here, whether it was written in HTML or plain text (keyed by the draft's id, removed when it is sent or discarded, at most 200 kept) | the extension's local storage | to reopen the draft in the same format |
| Contacts: names, addresses, the last date mail went either way and the last date you wrote to each, whether mail was copied to it (Cc or Bcc), whether you hid it, when you pinned it, the name you gave it and whether you added it or deleted it in Contacts (the address of a contact you deleted is kept, so that it stays out until you rebuild Contacts), with the address of the account it belongs to and how far its first build has come | the extension's IndexedDB; an address is forgotten once no mail with it is left outside Spam and Trash, unless you pinned, hid, named or added it or mail was copied to it; written to a text file only when you choose Export, where you save it, and read from one only when you choose Import; built anew by Rebuild in Settings, keeping only your pins and the names you gave, and once, keeping all you chose, by an update that changes what it records; started afresh when another account signs in, and cleared by Sign out (Gmail) | the Contacts list, and address suggestions while writing and in the search box; built from the headers of your own mail, in every folder but Spam, Trash and Drafts |
| Yahoo: the session values and the mailbox id | the extension's session storage, cleared when the browser closes | to call Yahoo without reloading its page |
| Gmail: the access token Google gave the extension, with its expiry and your address | the extension's session storage, cleared when the browser closes; revoked at Google by Sign out | to call the Gmail API; it is renewed silently an hour at a time |
| Gmail: the address of the Google account you signed in with | the extension's local storage, removed by Sign out | so a silent renewal asks Google for that account only, and refuses a token for any other |
| Gmail: when the first build of Contacts may start, two minutes after the mailbox first opened | the extension's local storage, removed by Sign out | so the build waits while you try the app, also across reloads |
| Gmail: the Client ID of the Google client you set up and, while the setup is under way, the step its guide is at | the extension's local storage; the Client ID is kept through Sign out until you use a different one, and the step is removed by the first sign-in | so the sign-in goes through your own client, and a tab closed during the setup carries on at the same step |
| A message being printed | session storage, removed as soon as the print page reads it | to hand it to the print page |

Message contents are not stored; they are fetched from the mail service when you open a message. Removing an extension from the browser deletes all of the above for it.

## Permissions

Baltazar Mail (the Yahoo Mail edition):

| Permission | Why |
|---|---|
| Access to `mail.yahoo.com` and `*.mail.yahoo.com` | to call Yahoo Mail with your existing sign-in |
| `storage` | settings, the release check, the session values and print hand-off described above |
| `declarativeNetRequest` | Yahoo's servers only accept requests that come from `mail.yahoo.com`; one rule sets the `Origin` and `Referer` headers on the extension's own requests to Yahoo |

Baltazar Mail for Gmail:

| Permission | Why |
|---|---|
| Access to `gmail.googleapis.com` and `oauth2.googleapis.com` | to call the Gmail API, and to revoke the sign-in |
| `identity` | to open Google's sign-in window and receive the token it answers with |
| `storage` | settings, the release check, the token, the account address, the Client ID and print hand-off described above |
| The Gmail permission you grant at sign-in (`https://mail.google.com/`) | the one that lets the extension read, write and permanently delete mail, which Empty Trash, Empty Spam and Delete in Trash need; it can be withdrawn at any time in your Google account's security settings |

## Contact

Questions about privacy can be raised as an issue on https://github.com/gdevic/baltazar-mail. Baltazar Mail is an independent project by Baltazar Studios. Yahoo and Yahoo Mail are trademarks of Yahoo Inc., and Gmail and Google are trademarks of Google LLC. Baltazar Mail and Baltazar Mail for Gmail are not created by, affiliated with, or endorsed by Yahoo Inc. or Google LLC.
