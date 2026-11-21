# Known bugs and problems

Found on 21 November 2026 at commit 3934a9d by six agents that each searched one area of the code and two independent security reviewers, one for each edition; the most serious findings were checked again against the code, and the security findings rerun in the real extension. Confidence: **reproduced** means a script showed the failure with the real source or in the real built extension; **confirmed** means the failing code path was read end to end; **likely** means the code path is confirmed but depends on Yahoo™ or Gmail™ behaviour that docs/yahoo-api.md and docs/gmail-api.md do not record.

## Summary

No critical, high or medium finding is open. What is left is low: rare cases, small faults, missing tests, hardening, and code that can go.

## Low

### COMP-10. Switching a reply to plain text drops the quote markers
`ext/compose.js:888-903` (`toText`) writes a blockquote's text without `> ` and keeps the HTML source's line breaks and indentation, whereas a reply opened in plain text quotes properly (`ext/compose.js:258`). Fix: prefix quoted lines for each level, and collapse white space outside pre. Confirmed.

### COMP-11. The 25 MB check sees only files attached in the composer
Pictures in the text (10 MB each, no total, `ext/compose.js:629`) and forwarded attachments (`ext/compose.js:269-270`) are not counted, and send checks nothing (`ext/compose.js:1076-1083`); the provider then refuses, and the draft cannot be saved, so the composer closes only with Discard. Fix: one total of all three, checked on insert, when a forward opens and before send. Confirmed.

### COMP-12. rfc822.js writes header lines over 998 characters and encoded words over 76
`gmail/rfc822.js:75-79`, `94-96`, `123`, `47`. A 127-character Russian file name gives a Content-Disposition line of 1,076 characters, an ASCII subject is never folded, a non-ASCII subject's first line is 81 characters, and multipart/related lacks the `type` parameter of RFC 2387. Fix: RFC 2231 continuations on folded lines, fold the fallback encoded words and ASCII subjects, size the first encoded word after the header name, and add `type="text/html"`. Reproduced.

### CORE-9. While a message's inline images load, its header sits over the previous message's body
`ext/mail.js:1322-1340` (`renderMessage`) fills the header and shows the old frame before it awaits `inlineImages`. Fix: show a blank frame, or the body without its inline images, first. Confirmed.

### VIEWER-6. Esc and the arrows stop once an HTML attachment has focus
Left as it is: `ext/viewer.js` shows an HTML attachment in a frame with an empty sandbox, which runs no script and so cannot pass its keys on; letting it would take `allow-same-origin`, which the attachment's frame is kept without. A click on the viewer's bar gives the keys back. Confirmed.

### RENDER-1. The JSON preview shows one value of a key the file gives twice
`ext/render.js` lays a .json file out again through `JSON.parse`, which keeps the last of two equal keys. Fix: lay it out from the text itself. Confirmed.

### ADPT-4. Gmail: a draft save answered 5xx after Gmail stored it can leave a second draft
`gmail/api.js` (`saveDraft` through `call`, which asks again after a server error). When Gmail stores a new draft and its answer is a 5xx, the save is asked again and a second draft is made. Fix: ask a first save again only for a rate limit, and look for the draft by its Message-ID before making another. Likely.

### TOOL-3. Dark mode leaves lab() and lch() colours alone
`ext/darken.js` (`parseColor`) reads hex, rgb(), hsl(), hwb(), oklab(), oklch(), color(srgb) and colour names, but not CIE lab() and lch(), so a light background written that way stays light under text that was made light. Fix: convert CIE Lab (D50) through XYZ to sRGB, or keep an element's text colour when its background did not parse. Confirmed.

### ADPT-5. Gmail: the Starred count includes starred mail in Trash
`gmail/api.js` (`starredCount`) reads the count Gmail keeps for its STARRED label, which takes in starred mail moved to Trash, so the count is higher than the Starred view. Fix: count with `messages.list`, which leaves Spam and Trash out, at five units a time instead of one. Likely.

### CONT-5. Mail filed out of Inbox during the first build, before Contacts reads it, is never learned
Left as it is: catching it would take a pass over all mail after the first build, which costs requests. The refresh after a poll reads Sent and Inbox down to its bookmark (`ext/contacts.js`, `sync`), and the build's last pass skips Inbox rows, so a new correspondent's message that arrives after the Inbox pass and is archived or filed before the build ends stays out of Contacts until a Rebuild. Reproduced.

### ADPT-8. Gmail search: after: and before: dates are read as midnight Pacific time
`gmail/api.js:105-109` writes `YYYY/MM/DD`, which Google™'s filtering guide reads as midnight PST. Fix: write the local midnight as epoch seconds. Likely.

### ADPT-9. Gmail: a rate-limited profile check during a silent renewal signs the user out
`gmail/auth.js:117-127` throws `NotSignedIn` for any 403 that is neither the API turned off nor a missing scope, and the call is not paced. Fix: treat a 429, and a 403 that names a rate limit, as an error to try again. Likely.

### ADPT-10. Yahoo: a save answered 206 still sends, without the forwarded attachments it dropped
`yahoo/api.js:604-610`, `637`: SendMessage is chained under SaveMessage and `partial` is ignored. Fix: report the attachments left out, or send only after a whole save. Likely.

### CONT-8. A name the file cannot carry is renamed by the round trip
`ext/contacts.js:153` cuts a name at 100 UTF-16 units, which can split an emoji, and keeps control characters; `ext/contactsfile.js:17` writes those as spaces, and the file's encoding turns a lone surrogate into U+FFFD, so a Merge of the unchanged file renames the contact. Fix: store names as the file writes them, and cut on code points. Reproduced.

### CONT-11. Two mail tabs during a build or a Rebuild ask for every page twice
A sync that finds the build under way resumes from the stored bookmark (`ext/contacts.js:254-260`, `301-305`), and the one-run guard is per tab (`ext/mail.js:2703`); on Gmail this spends twice the paced quota. Fix: one tab claims the build, for example with `navigator.locks`. Reproduced.

### TOOL-1. tools/review.js passes a scenario whatever the Content Security Policy blocked
`tools/review.js:1903-1904` fails a scenario on a request to the real network or a console error, but the harness files every CSP violation under `cspViolations` (`tools/harness.js:303-305`), which the runner never reads, so a scenario whose page the policy broke can still pass. Fix: fail on a violation the scenario does not expect, with a pattern per scenario for those it provokes on purpose. Confirmed.

### TOOL-6. The Contacts page's own zoom has no test
`settings.contactZoom` (`ext/mail.js:73`, `1228-1231`): Ctrl+wheel and + - 0 over a contact's recent messages. Confirmed.

## Security hardening

None of these is a vulnerability today.

- The workflows use actions by major tag (`actions/checkout@v7`, `actions/setup-node@v7`, `github/codeql-action@v4`, `actions/attest-build-provenance@v4`); a moved tag could change a signed release build. Pin the release job's actions to commit SHAs.
- tests.yml runs vendor-check without `--upstream`, so a pull request that swaps a library together with its recorded hash passes that job; vendor.yml and the release do compare with the published originals.
- `ext/render.js:34` hands a click back only when `tagName === "A"`, which misses SVG `a` and `area`; harmless while mail.html's `frame-src` stops the frame's own navigation. Use `localName`.
- `esc()` strips bidi controls, yet escaped values are read back as addresses (`data-hide` at `ext/compose.js:80`, `86`; `data-email`, `data-unmark`, `data-also` at `ext/people.js:132-133`), so an address holding such controls is acted on as its look-alike.
- Copy addresses (`ext/people.js:342`) replaces `"`, `,`, `<` and `>` in names but not `;`, which the address parser splits on.
- A reply to a Spam message saved as a draft and reopened loads its quote's images: saving puts the held attributes back, and drafts open with images allowed (`ext/compose.js:242`).

## Code to remove

About 26 lines of CSS, some 40 lines of code and 39 unused files, with no change in behaviour.

- **CSS that matches nothing:** `.tb-color` and `.tb-color input` (`ext/mail.css:390-391`), `#v-body pre`, `.v-note` and the table rules (`ext/mail.css:507-512`), `.v-pdf` through `.v-more` (`ext/mail.css:518-535`); viewer.js writes none of these, and render.css holds the live copies.
- **An id nothing uses:** `awake-row` (`ext/mail.html:203`).
- **Exports nothing imports:** `isShown`, `folderId` and `PAGE` in files.js, `CACHE_MAX` in cache.js, `kindOf` in viewer.js, `draftIsHtml`, `syncFontControls` and `FONTS` in compose.js, `TRACKING_PREFIXES`, `TRACKING_PARAMS` and `WRAPPERS` in links.js, `BIDI_CONTROLS` in text.js, `batch` in yahoo/api.js, `copyText` in guide.js (which mail.js's `copyReport` should import instead of repeating).
- **Code no caller reaches:** `AddrField.text()` (`ext/compose.js:34`); the folder and keyword branches of `search()` in both adapters (`yahoo/api.js:273`, `279-284`, `gmail/api.js:636-637`), since every caller passes no folder and a raw query; the fallbacks of `searchScoped` (`yahoo/api.js:493`, `gmail/api.js:647`); Gmail's `scopeFilter` (`gmail/api.js:642`); the false branch of `known()` and the `keyword:` fallbacks in `ext/query.js`; Gmail's write-only `session` and `profileCache` (`gmail/api.js:129-140`, `366-370`); the `HIDDEN` test in Gmail's `folderOf`; the unread `accounts` and `query` fields of the adapters' answers; the `full` parameter of `syncContacts` and `runContactsSync`; the leftovers of the first database version (`e.names`, `delete e.sent`) in contacts.js; the `CLASS` table in viewer.js, which is always `"k-" + kind`; the unused default of `extractInline`'s `taken`; `refs || []` on a value that is always an array.
- **Helpers written more than once:** `plural` (`ext/files.js:16`, `ext/mail.js:112`, a third version in `ext/people.js:44`); the short date and the full date from epoch seconds (`ext/mail.js:887`, `1087`, `1330`, `ext/people.js:234`, `ext/compose.js:246`, `ext/print.js:7`); the subfolder list of `subfolders` written again at `ext/mail.js:792`, `2031` and `2176`, two of them without its same-account test; `holding` in mail.js and `el` in guide.js; `norm` in files.js and mime.js; `normalizeFolders`, `isMessageId` and `checkIds`, `ApiError`, `TIMEOUTS` with `Timeout` and `timed`, and `dataUrl` in both adapters, and the has, is, after and before cases of their `atom()`; the composer's teardown in both `close()` and `send()`, and the Cc and Bcc rows and the autosave timer in both `open()` and `reopenFrom()`.
- **Files every ZIP carries and nothing loads:** 39 PDF.js toolbar images in `vendor/pdfjs/images/` (31 KB), which means listing the images one by one in vendor.json instead of mapping the folder; keep the annotation icons once TOOL-4 is fixed.
