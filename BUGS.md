# Known bugs and problems

Confidence: **confirmed** means the failing code path was read end to end; **likely** means the code path is confirmed but depends on Gmail™ or browser behaviour that was not tested live; **speculative** means plausible but unverified.

## Summary

| # | Severity | Area | Finding | Confidence |
|---|---|---|---|---|
| C1 | Critical | Release | Gmail™ release and store ZIPs ship the placeholder OAuth client id and no `key`; sign-in is impossible | confirmed |
| L1 to L18 | Low | various | see below | |

## Critical

### C1. The Gmail™ release and store ZIPs cannot sign in

- **Where:** `gmail/manifest.json:28`, `tools/build.js:27-33`, `.github/workflows/release.yml` (Gmail™ package step), `README.md` (Install, "Gmail™ and Google™'s sign-in"), `docs/google-setup.md:3`, `store/LISTING-gmail.md:3`.
- **Failure:** `gmail/local.json` is gitignored and CI provides nothing, so every built `manifest.json` carries `"client_id": "CLIENT_ID.apps.googleusercontent.com"` and no `key`. Sign in with Google fails with `invalid_client`. Even with a real client id, a ZIP without `key` gets an extension id derived from the user's unzip folder, so no redirect URI registered by the project can match it. A hand edit of `manifest.json` is lost on the next update, since updates unzip over the same folder. The README says a release ZIP "carries the project's client id", which is false today, and `build.js` does not complain about the placeholder.
- **Fix:** inject the client id from a repository secret in `release.yml` and commit the public `key` (or supply it the same way); make `build.js` fail on the placeholder in a release build (for example `--release`); correct the README until then.

## Low

### L1. The insufficient-scope check never matches
`gmail/api.js:181`, `187`. Google™'s 403 for a missing scope has `errors[0].reason = "insufficientPermissions"` and `status = "PERMISSION_DENIED"`; `ACCESS_TOKEN_SCOPE_INSUFFICIENT` appears only in `error.details[].reason`, which is not read. A token without mail scope (granular consent, or the scope withdrawn) shows repeated errors instead of the sign-in page. Fix: also check `details[].reason` and `insufficientPermissions`. Likely.

### L2. The retry without a thread never runs for `messages.send`
`gmail/api.js:719` with `749`. For `messages.send` the metadata is `{ threadId }` itself, so `meta.message?.threadId` is undefined and a send Gmail™ refuses because of its thread fails instead of being retried without it. Fix: check `meta.threadId ?? meta.message?.threadId` and strip whichever is present. Confirmed.

### L3. Archive does nothing in the All Mail view
`gmail/api.js:382`. Listed from All Mail, every row's folder is `ALL`, so archiving an Inbox message says "already in All Mail" and leaves `INBOX` in place. Fix: when listing All Mail, take the row's folder from its labels (`folderOf(labels, null)`). Confirmed.

### L4. Addresses are not validated; one chip can hold several recipients
`gmail/rfc822.js:160-161` (`parseAddresses`), `53-56` (`formatAddress` writes the address verbatim). `Reply-To: Boss <boss@corp.com,attacker@evil.com>` parses as one entry, `{ name: "Boss", email: "boss@corp.com,attacker@evil.com" }`; a reply shows one "Boss" chip and sends `To: Boss <boss@corp.com,attacker@evil.com>`; the string is also stored in the address book. Whether Gmail™ delivers to both is untested. Fix: accept one addr-spec per entry when parsing and again when formatting; reject or split anything else. Parsing confirmed, delivery speculative.

### L5. A sender address can inject search operators into the contact card search
`gmail/api.js:65`, `72` (`bareAddress` keeps `{ } : - |`). An address such as `a@x{from:bank.com}` makes the card's recent messages and the person search list unrelated mail. It misleads only; nothing leaves the browser. Fix: quote the address in the query or allow only addr-spec characters. Confirmed.

### L6. Remote image requests may send the extension id as Referer
`ext/mail.js` `setFrame` and `bodyDoc`, `ext/print.html`. The iframe's `referrerpolicy` covers only its own navigation, not the srcdoc document's subresources, so senders' image servers likely see `chrome-extension://<id>/`; for a ZIP install that id is derived from the folder path, a stable identifier across senders. Fix: add `<meta name="referrer" content="no-referrer">` to the reader document and the print page, then check with a test server. Likely, untested.

### L7. The 60-image cap now counts other messages' images (Yahoo™)
`ext/mail.js` `inlineImages`. The cap used to apply after filtering to the message's own parts; now `isInlineRef` checks only the address shape and ownership is checked later in `inlineSource`, so a message with many foreign part addresses ahead of its own images gets fewer of its own inlined. Fix: pass the body to `isInlineRef`, or keep asking until 60 sources are accepted. Confirmed, rare.

### L8. The strip shows Yahoo™ attachments without an https download link
`ext/viewer.js:77`. Attachments without an https `downloadUrl` used to be hidden; now they show, and if such a part is also missing from the raw source, preview says "attachment not found in message source" and Download only reports "could not fetch the attachment". Fix: keep the filter as an adapter predicate, or accept the change. Confirmed change; whether Yahoo™ sends such entries is speculative.

### L9. Attachment limit counts duplicates; drop status overstates
`ext/compose.js:752-757` and `153`. A file already attached is counted against the 25 MB limit before `withFiles` skips it as a duplicate, giving a false "Not attached" near the limit; a drop on the editor always says "attached N files" even when the limit refused some. Fix: skip duplicates before the size check and have `addFiles` return the number attached. Confirmed.

### L10. Doubled "no preview" message
`ext/viewer.js` (`showText` throws "no preview available", the catch writes "No preview available for this file (no preview available)"). The Gmail™ runtime test asserts the doubled text (`tools/gmail-runtime.js:307`). Fix: throw a reason that reads well in the sentence, or omit the parenthesis for it, and update the test. Confirmed.

### L11. A huge References header is copied whole into replies
`gmail/api.js:689`, `703`; `gmail/rfc822.js:116`. An attacker's References of any size is copied into the reply, which Gmail™ may then reject. Not an injection: every white-space run becomes a fold. Fix: keep the first id and the last few, as mail clients do. Confirmed copy, size limit untested.

### L12. Weak or vacuous test assertions
- `tools/gmail-test.mjs:156` "counts through one batch": the mock does not record the outer `/batch` call, so separate GETs would pass too.
- `tools/harness.js` (Gmail™ section): the `accounts.google.com` route records nothing and is routed, so it never shows in `unexpectedHosts`; nothing asserts that no sign-in window opened.
- `tools/gmail-runtime.js:342`: drops every CSP violation that mentions `gmail.googleapis.com/`, not only the sandbox's deliberate fetch.

Fix: record batch calls and Google™ sign-in hits in the mock and assert on them, and narrow the CSP filter to `render.html`.

### L13. google-setup.md section 6: key versus id, CASA tier
`docs/google-setup.md:47`. "Use the published copy's id for `key`" is wrong: `key` is a public key (the store dashboard's "View public key"), not an id. "CASA Tier 2" is stated as fact, but Google™ assigns the tier. Fix: reword both. Confirmed (key), likely (tier).

### L14. Doc numbers and wording
- `docs/gmail-api.md` says Empty Trash and Spam delete "a thousand at a time"; `eachPage` uses pages of 500 and stops silently after 200 pages (100,000 messages).
- `store/LISTING-gmail.md` says "Your mail goes only between your browser and Google™", yet remote images go to senders' hosts.

Fix: correct the number, report the 100,000 cap, soften the wording. Confirmed.

### L15. Build robustness
- `tools/gmail-test.mjs:83` runs the build with `stdio: "ignore"`, so a build failure shows only "Command failed".
- `tools/build.js` empties `dist/baltazar-mail-gmail` before it copies; a concurrent run (unit test while a browser suite has that folder loaded) breaks the running suite.
- `tools/build.js:37-47`: the Yahoo™-address check can be fooled (comment-stripping regexes eat code between `"/*"` and `"*/"` strings; `"ya" + "hoo"` slips through) and ignores HTML comments, which could fail spuriously.
- The release job has no `setup-node`, so `build.js` runs on the runner's default Node.

Fix: show build output on failure, build into a temporary folder and swap, tighten the host check, pin Node in the release job.

### L16. Quoted-printable and RFC 2231 details
`gmail/rfc822.js`: a trailing space before a hard break becomes `=20` after the 75-character check, so a line can reach 77 characters; RFC 2231 `filename*` leaves `'()*` unescaped (`encodeURIComponent` does not escape them). Fix: account for the escape in the length check; escape those characters. Confirmed.

### L17. Full sender CSS and `img-src https:` in the Gmail™ reader
`gmail/manifest.json:34`, `ext/mail.js` `cleanHtml`. Gmail™ returns the sender's HTML with `<style>` blocks intact (Yahoo™ pre-filtered it), and with images on, CSS attribute selectors and `:has()` can make image requests that depend on the message's own content. This matters only if a third party can inject a style block into someone else's mail that holds a secret (for example an HTML-injection bug in a service's password-reset mail). Gmail™'s own web UI filters CSS and proxies images. Fix: consider dropping `<style>` blocks or attribute and `:has()` selectors in Gmail™ HTML, or defaulting Gmail™ to load images when asked. Confirmed mechanism.

### L18. SVG attachments open as SVG blobs
`ext/viewer.js` (`MIME.svg = image/svg+xml`). Inert inside the viewer's `<img>`, but "Open image in new tab" makes it a top-level document at the extension origin; the CSP still blocks inline script. Fix: type SVG as `application/octet-stream` or render it in `render.html`. Speculative.
