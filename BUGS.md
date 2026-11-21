# Known bugs and problems

Found on 21 November 2026 at commit 3934a9d by six agents that each searched one area of the code and two independent security reviewers, one for each edition; the most serious findings were checked again against the code, and the security findings rerun in the real extension. Confidence: **reproduced** means a script showed the failure with the real source or in the real built extension; **confirmed** means the failing code path was read end to end; **likely** means the code path is confirmed but depends on Yahoo™ or Gmail™ behaviour that docs/yahoo-api.md and docs/gmail-api.md do not record.

## Summary

No critical, high or medium finding is open. What is left is low: rare cases, small faults, missing tests, hardening, and code that can go.

## Low

### CORE-9. While a message's inline images load, its header sits over the previous message's body
`ext/mail.js:1322-1340` (`renderMessage`) fills the header and shows the old frame before it awaits `inlineImages`. Fix: show a blank frame, or the body without its inline images, first. Confirmed.

### VIEWER-6. Esc and the arrows stop once an HTML attachment has focus
Left as it is: `ext/viewer.js` shows an HTML attachment in a frame with an empty sandbox, which runs no script and so cannot pass its keys on; letting it would take `allow-same-origin`, which the attachment's frame is kept without. A click on the viewer's bar gives the keys back. Confirmed.

### RENDER-1. The JSON preview shows one value of a key the file gives twice
`ext/render.js` lays a .json file out again through `JSON.parse`, which keeps the last of two equal keys. Fix: lay it out from the text itself. Confirmed.

### ADPT-4. Gmail: a draft save answered 5xx after Gmail stored it can leave a second draft
`gmail/api.js` (`saveDraft` through `call`, which asks again after a server error). When Gmail stores a new draft and its answer is a 5xx, the save is asked again and a second draft is made. Fix: ask a first save again only for a rate limit, and look for the draft by its Message-ID before making another. Likely.

### ADPT-5. Gmail: the Starred count includes starred mail in Trash
`gmail/api.js` (`starredCount`) reads the count Gmail keeps for its STARRED label, which takes in starred mail moved to Trash, so the count is higher than the Starred view. Fix: count with `messages.list`, which leaves Spam and Trash out, at five units a time instead of one. Likely.

### CONT-5. Mail filed out of Inbox during the first build, before Contacts reads it, is never learned
Left as it is: catching it would take a pass over all mail after the first build, which costs requests. The refresh after a poll reads Sent and Inbox down to its bookmark (`ext/contacts.js`, `sync`), and the build's last pass skips Inbox rows, so a new correspondent's message that arrives after the Inbox pass and is archived or filed before the build ends stays out of Contacts until a Rebuild. Reproduced.

### ADPT-10. Yahoo: a save answered 206 still sends, without the forwarded attachments it dropped
`yahoo/api.js:604-610`, `637`: SendMessage is chained under SaveMessage and `partial` is ignored. Fix: report the attachments left out, or send only after a whole save. Likely.

### TOOL-1. tools/review.js passes a scenario whatever the Content Security Policy blocked
`tools/review.js:1903-1904` fails a scenario on a request to the real network or a console error, but the harness files every CSP violation under `cspViolations` (`tools/harness.js:303-305`), which the runner never reads, so a scenario whose page the policy broke can still pass. Fix: fail on a violation the scenario does not expect, with a pattern per scenario for those it provokes on purpose. Confirmed.

### TOOL-6. The Contacts page's own zoom has no test
`settings.contactZoom` (`ext/mail.js:73`, `1228-1231`): Ctrl+wheel and + - 0 over a contact's recent messages. Confirmed.

## Security hardening

None of these is a vulnerability today.

- The values `people.js` puts in its `data-email`, `data-unmark` and `data-also` attributes are escaped by `esc()`, which strips bidi controls, and read back as addresses (`ext/people.js:132-133`), so an address holding such controls is acted on as its look-alike; the rows could be named by their place in the list instead, as the composer's suggestions now are.

## Code to remove

Left for a pass of its own, as each changes more than one module's terms:

- **Code no caller reaches:** the folder and keyword branches of `search()` in both adapters, since every caller passes no folder and a raw query; the fallbacks of `searchScoped`; Gmail's `scopeFilter`; the false branch of `known()` and the `keyword:` fallbacks in `ext/query.js`; the unread `accounts` and `query` fields of the adapters' answers; the leftovers of the first database version (`e.names`, `delete e.sent`) in contacts.js.
- **Helpers written more than once:** `normalizeFolders`, `isMessageId` and `checkIds`, `ApiError`, `TIMEOUTS` with `Timeout` and `timed`, and `dataUrl` in both adapters, and the has, is, after and before cases of their `atom()`, which belong in shared code; the composer's teardown in both `close()` and `send()`.
- **Files every ZIP carries and nothing loads:** 28 PDF.js toolbar images in `vendor/pdfjs/images/`, which means listing the images one by one in vendor.json instead of mapping the folder; the annotation icons there are used.
