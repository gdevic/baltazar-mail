# Known bugs and problems

Found on 21 November 2026 at commit 3934a9d by six agents that each searched one area of the code and two independent security reviewers, one for each edition; the most serious findings were checked again against the code, and the security findings rerun in the real extension. Confidence: **reproduced** means a script showed the failure with the real source or in the real built extension; **confirmed** means the failing code path was read end to end; **likely** means the code path is confirmed but depends on Yahoo™ or Gmail™ behaviour that docs/yahoo-api.md and docs/gmail-api.md do not record.

## Summary

| # | Severity | Area | Finding | Confidence |
|---|---|---|---|---|
| COMP-2 | Medium | Writing | SVG, AVIF, TIFF, HEIC and ICO pictures in the text are left out of the message | reproduced |
| COMP-4 | Medium | Writing | Autosave commits, or complains about, the address being typed | confirmed |
| ADPT-4 | Medium | Gmail | A send answered 5xx after it was sent goes out twice | likely |
| CONT-6 | Medium | Contacts | Importing an unchanged export rewrites the user's choices | reproduced |
| CONT-4 | Medium | Contacts | An import line with several bracketed addresses becomes one contact | reproduced |
| CONT-2 | Medium | Contacts | Undoing the delete of a draft records its recipients as people the user wrote to | reproduced |
| CONT-5 | Medium | Contacts | Mail that arrives during the first build and is filed before the next refresh is never learned | reproduced |
| CONT-3 | Medium | Contacts | Double-clicking a row's trash bin deletes and leaves Contacts | confirmed |
| CORE-2 | Medium | App | Starred › Mark all read marks every row of the open list read | reproduced |
| CORE-3 | Medium | App | The unread count drops twice when a refresh lands within the mark-read delay | reproduced |
| CORE-4 | Medium | App | A search that ends after the user went to the composer takes the keyboard | reproduced |
| CORE-5 | Medium | App | After a search the reader's Delete does nothing and says the message is in Trash | reproduced |
| VIEWER-1 | Medium | Attachments | A file left before its bytes arrived still takes over the viewer | reproduced |
| VIEWER-3 | Medium | Attachments | Text, CSV and HTML attachments are decoded as UTF-8 only | reproduced |
| ADPT-3 | Medium | Gmail | A search in All Mail lists every hit twice | reproduced |
| ADPT-2 | Medium | Gmail | Load more at the exact end of a list starts again at page 1 | likely |
| ADPT-5 | Medium | Gmail | Label counts include trashed mail, so an emptied label cannot be deleted | likely |
| TOOL-3 | Medium | Dark mode | Legacy colours without `#` and modern colour syntax are not darkened | reproduced |
| VIEWER-2 | Medium | Attachments | Every picture, audio or video stepped past stays in memory until the viewer closes | reproduced |
| CACHE-1 | Medium | Gmail | Caches count entries, not bytes, and hold full-size images | confirmed |
| SG-1 | Medium | Security | A message's styles still tell its sender about the reader (Gmail) | reproduced |
| TOOL-2 | Medium | Tests | The sandbox's network isolation is asserted by checks that cannot fail | confirmed |
| COMP-7 to ADPT-15 | Low | various | see below | |

## Medium

### COMP-2. SVG, AVIF, TIFF, HEIC and ICO pictures in the text are left out of the message

`ext/compose.js:145-157` (the picker, paste and drop take any `image/*`), `ext/compose.js:626-638` (`insertImages` checks only the size), `ext/compose.js:817-819` (`extractInline` drops what it cannot send inline), `ext/bytes.js:29-33` (`sniffImage` knows PNG, JPEG, GIF, BMP and WebP). The picture shows in the editor, never reaches the recipient, and is gone from a reopened draft, with no message; dropped elsewhere on the composer the same file would have been attached. Fix: attach a picture that cannot go inline, with a status line. Reproduced.

### COMP-4. Autosave commits, or complains about, the address being typed

`ext/compose.js:312` (the timer), `ext/compose.js:1004-1009` and `1042` (`collect` calls `strictGet`), `ext/compose.js:1001`, `ext/compose.js:39-43` (`commit(true)` adds what parses and warns about what does not). If the 30 s tick lands while `john.smith@company.com` is half typed, either `john.smith@company.c` becomes a chip and the rest is typed on its own, or "Not an address: john.smith@comp" appears, and again every 30 s. The comment on `saveNow` promises no message about an unfinished address during a silent save. Fix: a draft save takes only the chips; `strictGet` is for sending. Confirmed.

### ADPT-4. Gmail: a send answered 5xx after it was sent goes out twice

`gmail/api.js:288-291` (`call` retries 500 to 504), `gmail/api.js:962-974` (`upload`), `gmail/api.js:1003-1004` (`send`). When `drafts.send` answers 503 although the message went out, `call()` repeats it and gets 404, since the draft is gone; `send()` reads that as a draft deleted elsewhere and sends again with `messages.send`. The retry in `saveDraft` can likewise leave a second draft. Fix: never retry a send upload on 5xx and never fall back to `messages.send` after a retried `drafts.send`; word a 5xx as the timeout is worded ("check Sent"). Likely: the chain is reproduced against the mock; that Gmail answers 5xx after sending is not recorded.

### CONT-6. Importing an unchanged export rewrites the user's choices

`ext/contacts.js:509` (`set` rewrites `hidden` even when it already gives the wanted visibility), `ext/contacts.js:505` (replace drops `given` when it equals the learned name), `ext/contacts.js:521`, `ext/mail.js:2795-2796`. A Merge of an unchanged file drops `hidden: false` from a contact hidden and then unhidden, and a Replace does so for every unhidden contact, so an automated-looking address the user writes to falls out of the suggestions; a Replace also drops the given name of a contact renamed to what its mail now says, after which forget can remove it. The status says nothing changed, yet an undo step is pushed. Fix: in `set`, return when the visibility is already the wanted one; in replace, drop `given` only when the name differs from `bestName(e)`. Reproduced, and the fix checked on a copy.

### CONT-4. An import line with several bracketed addresses becomes one contact

`ext/contactsfile.js:46-49` checks for several addresses only on a line without angle brackets; `ext/mail.js:2788` refuses Replace only on reported errors. `Ana Kos <ana@x.example>, Bob Ban <bob@x.example>` gives one entry, bob@x.example named `Ana Kos <ana@x.example>, Bob Ban`, with no error; Merge renames Bob, and Replace removes Ana without refusing. Fix: report several addresses when the name part, not quoted, holds `<`, `>` or `@`. Reproduced.

### CONT-2. Undoing the delete of a draft records its recipients as people the user wrote to

`ext/mail.js:1829`, `1741`, `1754`, `1778-1780` (`mailBack` learns the rows that came back), `ext/contacts.js:172-185` (`record` trusts a From that is the user's own). Deleting a draft to a new address and pressing z, or Undelete on it in Trash, moves the address to People with "you last wrote" and ranks it higher, for good, though the build leaves Drafts out for this very reason. Fix: skip draft rows in `mailBack`, as `hooks.draft` does. Reproduced.

### CONT-5. Mail that arrives during the first build and is filed before the next refresh is never learned

`ext/mail.js:593` clears `contactsDirty` although `syncContacts` only returns the run under way (`ext/mail.js:2703`); the refresh reads Sent and Inbox down to its bookmark (`ext/contacts.js:298`, `237`) and the build's last pass skips Inbox rows (`ext/contacts.js:269`). A new correspondent's message that arrives after the Inbox pass and is archived or filed during the build stays out of Contacts until a Rebuild; the Gmail build can span hours. Fix: remember a sync asked for during a run, and refresh once more when the run ends. Reproduced.

### CONT-3. Double-clicking a row's trash bin deletes and leaves Contacts

`ext/people.js:123`: the double-click handler leaves out `.pe` and `.pk` but not the bin `.tr`. The first click deletes the contact and redraws the list, the second deletes it again or deletes the contact that moved up into the row, and the double-click then opens All mail for it. Fix: leave out `.tr` as well. Confirmed.

### CORE-2. Starred › Mark all read marks every row of the open list read

`ext/mail.js:506-507`: for Starred the folder is null, so `here` is true whatever view is open and every row is shown read, while only starred messages were marked at the provider; opening them later does not mark them read, since the reader marks only rows it believes unread. Fix: treat only the Starred view as here, and elsewhere mark only starred rows. Reproduced.

### CORE-3. The unread count drops twice when a refresh lands within the mark-read delay

`ext/mail.js:1349-1359` (the mark-read timer), `ext/mail.js:1550-1564` (`applyFlags`), `ext/mail.js:742`, `757-759`, `626-630`. A refresh replaces the row objects; when the timer fires, `applyFlags` lowers the folder's count for the new row, then `!state.messages.includes(m)` holds for the old object it captured and `bumpFolder` lowers it again. The count and the tab title stay one too low, and if the tab is then in the background, the next poll's correct count looks like new mail and puts up the new-mail dot. Fix: compare by id, and read the current row's flags. Reproduced.

### CORE-4. A search that ends after the user went to the composer takes the keyboard

`ext/mail.js:2207` (`doSearch`), `1155` (`searchPerson`) and `1135` (`goToMessage`) end with `$("list").focus()`, where the folder loads use `focusListIfStill` (`ext/mail.js:1980`). Letters typed for the composer then run shortcuts: j selects a result, e archives it, # deletes it, and c, r, a or f replace the composer. Fix: note `focusWhere()` at the start and end with `focusListIfStill`. Reproduced.

### CORE-5. After a search the reader's Delete does nothing and says the message is in Trash

`ext/mail.js:2846`, `760`, `1824-1829`, `1713-1717`. A search that does not match the open message leaves it in the reader; Delete works from the list's rows, finds none and reports "already in Trash", and Undelete answers "already in Inbox". Fix: act on the open message when it is no row of the list, or clear the reader. Reproduced.

### VIEWER-1. A file left before its bytes arrived still takes over the viewer

`ext/viewer.js:262-264` calls `sandboxed()` after `await bytes()` without a stale check, `sandboxed()` replaces `current` (`ext/viewer.js:394`), and `stale()` (`ext/viewer.js:258`) compares only the list and the index. Open a slow PDF and step to a picture: when the PDF's bytes arrive, a hidden frame is added and `current` loses its zoom, so the zoom buttons and + - 0 stop working on the picture; stepping away and back to the same PDF before its bytes arrive renders it twice. Fix: a sequence number for each `show()`, checked before `sandboxed()`. Reproduced.

### VIEWER-3. Text, CSV and HTML attachments are decoded as UTF-8 only

`ext/viewer.js:293`, `283`, `458` use `blob.text()` or force `charset=utf-8`; `asText` (`ext/bytes.js:4-15`) reads byte-order marks and falls back to Windows-1252, but only the raw view uses it. An Excel CSV from a Western Windows, a Notepad "Unicode" file or a Windows-1252 HTML report shows replacement characters or NULs. Fix: decode with `asText`, or with the part's charset where the adapter has it. Reproduced.

### ADPT-3. Gmail: a search in All Mail lists every hit twice

`gmail/api.js:656-660` filters `ALL` out of the exclusions, so the "elsewhere" query is the bare search, and `ext/mail.js:715-716`, `737`, `745` append it without removing duplicates. Every hit repeats under "N matches in other folders", and "+N elsewhere" counts the same mail. Fix: `searchScoped` answers nothing when the exclusion holds `ALL`. Reproduced.

### ADPT-2. Gmail: Load more at the exact end of a list starts again at page 1

`gmail/api.js:588-612` (`listIds`). After a last page that is exactly full and has no `nextPageToken`, the next offset matches the cursor and `messages.list` is called without a token, which answers the first page. Load more never ends in a folder or search of 200, 300... messages, the Files view behaves the same, and the Contacts build rereads such a folder until it reaches 2,000 rows. Fix: answer no ids for an offset past a cursor that has no token. Likely: it depends on Gmail leaving out `nextPageToken` on an exactly full last page, as the mock does.

### ADPT-5. Gmail: label counts include trashed mail, so an emptied label cannot be deleted

`gmail/api.js:422-433` (counts from `labels.get`), `856-862` (a move to Trash keeps user labels and STARRED), `442-445` (`starredCount`), `ext/mail.js:350-353`, `433-441`. After all of a label's mail is deleted, the label keeps its total for up to 30 days, and Delete is greyed out ("it holds N messages"); the Starred count is higher than the Starred view. Fix: decide emptiness, and count Starred, with `messages.list` and `maxResults=1`, which leaves out Spam and Trash. Likely.

### TOOL-3. Legacy colours without # and modern colour syntax are not darkened

`ext/darken.js:44-68` (`parseColor`), `ext/darken.js:137-138`. `bgcolor="ffffff"` and `color="000000"`, which browsers read as #ffffff and #000000, are kept, giving black text on the dark page or light text on a table left white; `oklch()`, `lab()`, `hwb()`, `color()` and `hsl()` with bare numbers are kept the same way. Fix: give a bare 3- or 6-digit attribute value its `#` before remapping, and keep an element's text colour when its background colour did not parse. Reproduced.

### VIEWER-2. Every picture, audio or video stepped past stays in memory until the viewer closes

`ext/viewer.js:123-127` keeps every object URL, and only `close()` (`ext/viewer.js:142-148`) revokes them, not `teardown()` (`ext/viewer.js:136-140`). Stepping through 60 photos of 4 MB holds 240 MB. Fix: revoke the object URLs in `teardown()`. Reproduced.

### CACHE-1. Gmail: caches count entries, not bytes, and hold full-size images

`ext/cache.js:7-10` bounds a cache by entries only; `gmail/api.js:795` (`inlineCache`, 200 data URLs of full-size images), `773` (`thumbCache`, 100 of up to 2 MB) and `754` (`bytesCache`, 20 attachments of any size). Reading 50 messages with four 3 MB photos each holds about 860 MB in the page. Fix: a byte budget in `remember`, about 50 MB for these three. Confirmed, with the sizes from a script.

### SG-1. A message's styles still tell its sender about the reader (Gmail)

`ext/mail.js:1016-1036` (`READS_CONTENT` is only `[` and `:has(`), `gmail/api.js:47` (`img-src https:`). Rules under `@media` (`prefers-color-scheme`, `pointer`, width), `:hover`, `:dir(rtl)`, `:nth-child(An+B of S)`, `:empty` and sibling combinators survive the pruning. With images on, the default outside Spam and Trash, the Gmail reader fetches their addresses from any host, which tells the sender the reader's theme, pointer and window size, which parts were hovered, and the direction of the text, without a click. SECURITY.md ("a style cannot fetch an address that depends on what the message says") and PRIVACY.md ("that it was opened, your IP address and browser") say less than this. In the Yahoo edition such rules reach only Yahoo's image proxy. Fix: drop a rule that names an external `url()` when it sits under a feature query, under an interaction or `:dir()` pseudo-class, or under an `of S` selector, and correct both texts. Reproduced in the real extension.

### TOOL-2. The sandbox's network isolation is asserted by checks that cannot fail

`tools/yahoo-runtime.js:198` with `955`, `tools/gmail-runtime.js:155` with `574`, `tools/yahoo-runtime.js:951`. The probe fetch from render.html, whose origin is "null", is refused by CORS, since the mocked answers carry no `Access-Control-Allow-Origin`, whether or not the sandbox's CSP stops it; `connect-src *` in the sandbox CSP would pass both suites, as the Yahoo filter also drops every CSP violation that mentions `https://mail.yahoo.com/`. Fix: assert that the mock never saw the probe (`/sandbox-probe` in the Gmail mock's calls, a `/probe-` address in `mock.probes` for Yahoo), and narrow the Yahoo filter to it. Confirmed.

## Low

### COMP-7. Addresses pasted one per line are refused; a mailto: link keeps its query
`ext/compose.js:30`, `958-980`. `ann@x.org` and `bob@y.com` on two lines, or separated by a space, give "Not an address"; `mailto:info@shop.example?subject=Order%2012` becomes a chip holding all of that, written to To. Fix: also split on line breaks and on white space between bare addresses, and strip and decode the query of a mailto: link. Reproduced.

### COMP-8. Esc in To, Cc or Bcc never closes the composer
`ext/compose.js:64` stops every Escape, so the composer's handler (`ext/compose.js:182`) never sees it, and a new message starts in To. Fix: stop it only when the suggestion list is open. Confirmed.

### COMP-9. Clicking from To into Cc or Bcc, the recent-addresses list flashes and goes
`ext/compose.js:29`: To's blur timer hides the one shared list whichever field opened it. Fix: hide only when `suggestField` is this field. Confirmed.

### COMP-10. Switching a reply to plain text drops the quote markers
`ext/compose.js:888-903` (`toText`) writes a blockquote's text without `> ` and keeps the HTML source's line breaks and indentation, whereas a reply opened in plain text quotes properly (`ext/compose.js:258`). Fix: prefix quoted lines for each level, and collapse white space outside pre. Confirmed.

### COMP-11. The 25 MB check sees only files attached in the composer
Pictures in the text (10 MB each, no total, `ext/compose.js:629`) and forwarded attachments (`ext/compose.js:269-270`) are not counted, and send checks nothing (`ext/compose.js:1076-1083`); the provider then refuses, and the draft cannot be saved, so the composer closes only with Discard. Fix: one total of all three, checked on insert, when a forward opens and before send. Confirmed.

### COMP-12. rfc822.js writes header lines over 998 characters and encoded words over 76
`gmail/rfc822.js:75-79`, `94-96`, `123`, `47`. A 127-character Russian file name gives a Content-Disposition line of 1,076 characters, an ASCII subject is never folded, a non-ASCII subject's first line is 81 characters, and multipart/related lacks the `type` parameter of RFC 2387. Fix: RFC 2231 continuations on folded lines, fold the fallback encoded words and ASCII subjects, size the first encoded word after the header name, and add `type="text/html"`. Reproduced.

### COMP-13. A plain-text Gmail draft with an attachment reopens as HTML
`ext/compose.js:224-231` (`draftIsHtml`) falls back, when this browser has no record of the format, to a body test that never holds on Gmail, whose `body()` always fills `html` from the text parts (`gmail/api.js:717`, `559`). Fix: have `body()` say whether a text/html part exists. Confirmed.

### COMP-14. A message only to Cc or Bcc is announced as "to " with no one
`ext/compose.js:1094` names only To. Fix: name To, Cc and Bcc together. Confirmed.

### CORE-6. A fetch that fails after the user opened another message replaces it with the error
`ext/mail.js:1259` checks `state.openId` after a successful fetch only; `showReaderError` then hides the message on screen and clears `currentBody`. Fix: return quietly in the catch when `openId` changed. Reproduced.

### CORE-7. The mark-read timer is dropped when it fires during an action
`ext/mail.js:1349` runs the work through `run()`, which drops it while busy (`ext/mail.js:1603-1604`), and nothing tries again: the message stays unread and the status line says "busy, try again in a moment". Fix: rearm the timer briefly when busy. Reproduced.

### CORE-8. Each folder dialog adds another Tab handler
`ext/mail.js:565` calls `trapFocus` on every open of the name dialog (`ext/mail.js:532-541`), and the name box stops every key (`ext/mail.js:557-561`): after the second dialog of a session Tab from Cancel skips OK, and Shift+Tab from the name box always leaves the dialog. Fix: trap once at start-up and let Tab through in the name box. Reproduced.

### CORE-9. While a message's inline images load, its header sits over the previous message's body
`ext/mail.js:1322-1340` (`renderMessage`) fills the header and shows the old frame before it awaits `inlineImages`. Fix: show a blank frame, or the body without its inline images, first. Confirmed.

### CORE-10. The start-failure page disappears during each retry
`ext/mail.js:2657` hides the panel before `api.bootstrap()` (`ext/mail.js:2627-2639`), leaving a blank tab for as long as the service takes to answer, up to 60 s. Fix: keep the panel until start-up succeeds or the sign-in panel is needed. Confirmed.

### VIEWER-4. An Office file typed application/zip previews as a ZIP listing
`ext/viewer.js:27-33` (`kindOf`) tests the sender's subtype before the extension, so `contract.docx` sent as `application/zip` shows its XML parts. Fix: decide by extension first. Reproduced.

### VIEWER-5. A file the converter cannot convert is waited on twice
`ext/viewer.js:265` sends doc, sheet, slide and other to `showConverted`, and the catch at `ext/viewer.js:298` calls it again: about 50 s of "Loading..." and twice the requests before "No preview available". Fix: call it in the catch only when the try did not. Reproduced.

### VIEWER-6. Esc and the arrows stop once an HTML attachment has focus
`ext/viewer.js:284`: its frame (`sandbox=""`) runs no script and its keys never reach the viewer. Fix: `allow-same-origin` (its CSP still blocks script) and forward keydown from the frame on load, as the reader does. Confirmed.

### RENDER-1. The JSON preview shows numbers that are not in the file
`ext/render.js:208` parses and writes the JSON again, which rounds `1234567890123456789` and drops duplicate keys. Fix: keep each number's source text with `JSON.rawJSON` in a reviver. Reproduced.

### FILES-1. A folder's attachments that fail to load are shown as "No attachments"
`ext/files.js:124-130`, `156`. Fix: render a failure note after a failed fresh load. Reproduced.

### PRINT-1. Printing messages with different image permissions gives broken images
`ext/mail.js:1539` keeps a permitted message's https images, while `ext/mail.js:1543` makes the page's `img-src` `data:` unless every message is permitted (`ext/print.js:19-21`). Fix: decide the page's permission first and pass it to `printableImages` for every message. Confirmed.

### TOOL-4. PDF note icons point at files that are not there
`ext/render.js:82` gives PDFViewer no `imageResourcesPath`, so annotation icons resolve to the extension's root. Fix: `imageResourcesPath: base + "images/"`. Confirmed.

### ADPT-6. Gmail keeps every opened message's text part data until sign-out
`gmail/api.js:680`, `712`, `748` (`partRefs`): reading 200 messages of 494 KB keeps about 130 MB. Fix: keep only the attachment id, type and name, or bound the map. Reproduced.

### ADPT-7. Gmail search: a quoted "-word", "OR" or "AND" acts as an operator
`gmail/api.js:91` (`quoted`) quotes only white space, colons and parentheses, so `"-v2"` excludes v2 and `apple "OR" pie` is an OR. Fix: also quote a value that starts with `-` or `+`, holds `{` or `}`, or is OR or AND. Reproduced.

### ADPT-8. Gmail search: after: and before: dates are read as midnight Pacific time
`gmail/api.js:105-109` writes `YYYY/MM/DD`, which Google™'s filtering guide reads as midnight PST. Fix: write the local midnight as epoch seconds. Likely.

### ADPT-9. Gmail: a rate-limited profile check during a silent renewal signs the user out
`gmail/auth.js:117-127` throws `NotSignedIn` for any 403 that is neither the API turned off nor a missing scope, and the call is not paced. Fix: treat a 429, and a 403 that names a rate limit, as an error to try again. Likely.

### ADPT-10. Yahoo: a save answered 206 still sends, without the forwarded attachments it dropped
`yahoo/api.js:604-610`, `637`: SendMessage is chained under SaveMessage and `partial` is ignored. Fix: report the attachments left out, or send only after a whole save. Likely.

### ADPT-11. Gmail: a bulk change of more than 1,000 messages reports all as failed when a later chunk fails
`gmail/api.js:814-816`, `835`, `891-892`: flags are not applied and no undo is pushed for the chunks that did change. Fix: return those as ok and the rest as failed. Confirmed.

### CONT-7. Pins made together are rewritten by Replace, and imported pin times run ahead of the clock
`ext/contacts.js:496` treats equal pin times as out of order, `ext/contacts.js:511` dates imported pins `now + pin`, and `pinMany` (`ext/contacts.js:404-405`) gives one time to all. A Replace of 20 contacts pinned together reports 19 changed, and a pin made 3 s after importing 20 pinned lines lands fourth. Fix: compare with `<`, and date imported pins so the last is now. Reproduced.

### CONT-8. A name the file cannot carry is renamed by the round trip
`ext/contacts.js:153` cuts a name at 100 UTF-16 units, which can split an emoji, and keeps control characters; `ext/contactsfile.js:17` writes those as spaces, and the file's encoding turns a lone surrogate into U+FFFD, so a Merge of the unchanged file renames the contact. Fix: store names as the file writes them, and cut on code points. Reproduced.

### CONT-9. Deleting a message and undoing it puts an unhidden address back under Hidden
`ext/contacts.js:436` (forget spares only `hidden === true`, while `chosen` at `ext/contacts.js:133` counts `hidden: false` as a choice); `ext/mail.js:1765-1767` promises that a delete undone leaves the book as it was. Fix: spare any defined `hidden`, or put the forgotten rows back on undo. Reproduced.

### CONT-10. The selection page's Delete tooltip promises that an export lists deleted contacts
`ext/people.js:599` says "an export lists them under Deleted"; the export has no such section. Fix: use `DELETE_TIP`'s wording. Confirmed.

### CONT-11. Two mail tabs during a build or a Rebuild ask for every page twice
A sync that finds the build under way resumes from the stored bookmark (`ext/contacts.js:254-260`, `301-305`), and the one-run guard is per tab (`ext/mail.js:2703`); on Gmail this spends twice the paced quota. Fix: one tab claims the build, for example with `navigator.locks`. Reproduced.

### SY-2. A message's style sheet can replace the printed header
`ext/print.js:37-38` puts each message in a shadow root, where `:host{position:relative!important;top:-139px!important;z-index:9!important;background:#fff!important}` moves the whole message box over the header above it, so a forged From, To, Date and Subject print; `contain: paint` (`ext/print.css:14`) clips only what is inside the box. It breaks SECURITY.md's "their styles cannot change the printed header". Fix: drop `:host` and `:host-context` rules in `contentBlindCss`, and pin the position of `.body` in print.css. Reproduced in the real extension.

### SY-3. A forged From of the user's own address puts its sender among the people the user wrote to
`ext/contacts.js:172` (`isOwn`) trusts the From header, so a received message `From: me@yahoo.com` to `"Alice Smith" <alice.smith@attacker.example>` records the attacker as someone the user wrote to, ranked above the real Alice in the suggestions. Yahoo's sender authentication limits this to aliases and linked accounts on other domains. Fix: take "the user wrote it" only from Sent and from `noteSent`. Reproduced in the real extension.

### TOOL-1. tools/review.js passes a scenario whatever the Content Security Policy blocked
`tools/review.js:1903-1904` fails a scenario on a request to the real network or a console error, but the harness files every CSP violation under `cspViolations` (`tools/harness.js:303-305`), which the runner never reads, so a scenario whose page the policy broke can still pass. Fix: fail on a violation the scenario does not expect, with a pattern per scenario for those it provokes on purpose. Confirmed.

### TOOL-5. tools/themeshots.js has been broken since 1 November
It copies smoke.js up to its first `page.goto`, which since 79f94de includes a route that refuses every host but 127.0.0.1, and then opens `localhost`; it also reads smoke.js relative to the working directory. Fix: use 127.0.0.1 and `__dirname`, or delete it. Confirmed.

### TOOL-6. The Contacts page's own zoom has no test
`settings.contactZoom` (`ext/mail.js:73`, `1228-1231`): Ctrl+wheel and + - 0 over a contact's recent messages. Confirmed.

### ADPT-15. tools/gmail-test.mjs has no case for paging at the exact end, an All Mail search or a 5xx on send
ADPT-2 to ADPT-4 all pass it today. Confirmed.

## Security hardening

None of these is a vulnerability today.

- The workflows use actions by major tag (`actions/checkout@v7`, `actions/setup-node@v7`, `github/codeql-action@v4`, `actions/attest-build-provenance@v4`); a moved tag could change a signed release build. Pin the release job's actions to commit SHAs.
- tests.yml runs vendor-check without `--upstream`, so a pull request that swaps a library together with its recorded hash passes that job; vendor.yml and the release do compare with the published originals.
- `ext/render.js:34` hands a click back only when `tagName === "A"`, which misses SVG `a` and `area`; harmless while mail.html's `frame-src` stops the frame's own navigation. Use `localName`.
- `esc()` strips bidi controls, yet escaped values are read back as addresses (`data-hide` at `ext/compose.js:80`, `86`; `data-email`, `data-unmark`, `data-also` at `ext/people.js:132-133`), so an address holding such controls is acted on as its look-alike.
- Copy addresses (`ext/people.js:342`) replaces `"`, `,`, `<` and `>` in names but not `;`, which the address parser splits on.
- A reply to a Spam message saved as a draft and reopened loads its quote's images: saving puts the held attributes back, and drafts open with images allowed (`ext/compose.js:242`).
- PRIVACY.md's Yahoo section does not say that an image shown through Yahoo's proxy still tells its sender when the message was read.

## Code to remove

About 26 lines of CSS, some 40 lines of code and 39 unused files, with no change in behaviour.

- **CSS that matches nothing:** `.tb-color` and `.tb-color input` (`ext/mail.css:390-391`), `#v-body pre`, `.v-note` and the table rules (`ext/mail.css:507-512`), `.v-pdf` through `.v-more` (`ext/mail.css:518-535`); viewer.js writes none of these, and render.css holds the live copies.
- **An id nothing uses:** `awake-row` (`ext/mail.html:203`).
- **Exports nothing imports:** `isShown`, `folderId` and `PAGE` in files.js, `CACHE_MAX` in cache.js, `kindOf` in viewer.js, `draftIsHtml`, `syncFontControls` and `FONTS` in compose.js, `TRACKING_PREFIXES`, `TRACKING_PARAMS` and `WRAPPERS` in links.js, `BIDI_CONTROLS` in text.js, `batch` in yahoo/api.js, `copyText` in guide.js (which mail.js's `copyReport` should import instead of repeating).
- **Code no caller reaches:** `AddrField.text()` (`ext/compose.js:34`); the folder and keyword branches of `search()` in both adapters (`yahoo/api.js:273`, `279-284`, `gmail/api.js:636-637`), since every caller passes no folder and a raw query; the fallbacks of `searchScoped` (`yahoo/api.js:493`, `gmail/api.js:647`); Gmail's `scopeFilter` (`gmail/api.js:642`); the false branch of `known()` and the `keyword:` fallbacks in `ext/query.js`; Gmail's write-only `session` and `profileCache` (`gmail/api.js:129-140`, `366-370`); the `HIDDEN` test in Gmail's `folderOf`; the unread `accounts` and `query` fields of the adapters' answers; the `full` parameter of `syncContacts` and `runContactsSync`; the leftovers of the first database version (`e.names`, `delete e.sent`) in contacts.js; the `CLASS` table in viewer.js, which is always `"k-" + kind`; the unused default of `extractInline`'s `taken`; `refs || []` on a value that is always an array.
- **Helpers written more than once:** `plural` (`ext/files.js:16`, `ext/mail.js:112`, a third version in `ext/people.js:44`); the short date and the full date from epoch seconds (`ext/mail.js:887`, `1087`, `1330`, `ext/people.js:234`, `ext/compose.js:246`, `ext/print.js:7`); the subfolder list of `subfolders` written again at `ext/mail.js:792`, `2031` and `2176`, two of them without its same-account test; `holding` in mail.js and `el` in guide.js; `norm` in files.js and mime.js; `normalizeFolders`, `isMessageId` and `checkIds`, `ApiError`, `TIMEOUTS` with `Timeout` and `timed`, and `dataUrl` in both adapters, and the has, is, after and before cases of their `atom()`; the composer's teardown in both `close()` and `send()`, and the Cc and Bcc rows and the autosave timer in both `open()` and `reopenFrom()`.
- **Files every ZIP carries and nothing loads:** 39 PDF.js toolbar images in `vendor/pdfjs/images/` (31 KB), which means listing the images one by one in vendor.json instead of mapping the folder; keep the annotation icons once TOOL-4 is fixed.
