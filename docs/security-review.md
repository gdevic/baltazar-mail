# Security review, 31 October 2026

An independent review of version 0.14.0, done by an AI agent that had no part in writing the code and was given only the source, a threat model and the instruction to break the claims in SECURITY.md. It confirmed findings by running hostile messages and attachments through the real extension against a mocked Yahoo™ backend. Every finding was then checked against the code, fixed, and the reviewer's own attack scripts were run again against the fixes.

## Threat model

Anyone who can send the user an email (body HTML, subject, names, attachments, filenames, MIME structure), a malicious web page in the same browser, and a compromised bundled library. Assets: the Yahoo session, mail contents, the ability to act as the user, the address book, and the user's privacy.

## Findings, all fixed

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | On Reply or Forward, the quoted message's HTML was shown in the extension's own page, so a sender's `<style>` blocks and element ids could restyle and clobber the interface (no script ran) | Medium | HTML put into the editor (the quoted original of a reply or forward, reopened drafts, signatures) is cleaned without style sheets, ids, names, foreign classes or positioning, and the editor cannot paint outside its box; a quote's remote images are held back where the reader blocks them |
| 2 | Inline images were found with a regular expression over the HTML text, so an address hidden in another attribute made the extension request any `*.mail.yahoo.com` URL with the user's session, and untyped responses could end up in a reply | Medium | Only real `<img>` sources in Yahoo's exact part-thumbnail shape, in the user's own mailbox, are fetched, and only image responses are kept |
| 3 | A message with tens of thousands of tiny MIME parts made parsing quadratic and could freeze the page for minutes when an attachment was opened | Low/Medium | Every search stays inside its part; part count and nesting depth are capped (40,000 parts now parse in about 35 ms) |
| 4 | Message ids dropped onto Starred were passed unchecked into Yahoo's query language | Low | Dropped ids are filtered to loaded messages, and every id is validated against Yahoo's id alphabet before it reaches a query or URI |
| 5 | "Open in tab" used the sender's declared MIME type, so an HTML attachment opened as a page under the extension's address (no script ran) | Low | Only PDF, raster images, audio, video and plain text open in a tab, typed by file name; everything else is downloaded |
| 6 | The release workflow expanded the tag name inside shell scripts | Low | Values reach the shell only through environment variables, and the tag must look like a version |

## Checked and found sound

- The reader frame runs no scripts, cannot submit forms or navigate itself, and popups from it have no opener or referrer.
- Links in a message keep their target only when it is an absolute http, https, mailto or tel address, so none can open an extension page (a relative link would resolve to one); in-message anchors scroll the message.
- Remote images from non-Yahoo hosts are blocked by the Content Security Policy, which the reader frame inherits.
- The attachment sandbox checks the sender of every message in both directions, allows only http, https and mailto links back out, and range-checks page requests.
- Every place names, addresses, subjects, filenames and folder names reach the page goes through escaping.
- Search values are URL-encoded and stripped of quote and grouping characters.
- The header-rewriting rule applies only to this extension's own requests to Yahoo's mail hosts.
- ZIP listings are bounds-checked and spreadsheet previews are capped.
- The library-check workflow has read-only permissions; CodeQL also writes its results to code scanning (`security-events: write`). Neither has an untrusted trigger.
- `connect-src` includes `api.github.com` for the daily release check (`ext/update.js`) and nothing else outside Yahoo. The request sends no cookies or referrer, the answer is accepted only as a `vX.Y.Z` tag and used only for the version comparison, and the download link in Settings is fixed rather than taken from the response. No host permission is needed, because the API allows cross-origin reads.

## How a review is done

A review is done by AI agents that had no part in writing the code, so that it looks where the code's authors would not. It is repeated before each minor release, and whenever a new surface lands: an edition, a parser of mail or files, a permission, or a change to a Content Security Policy.

- **Reviewers.** Two work at once, one for each edition: one takes the shared code with the Yahoo edition, the other the Gmail™ edition and the supply chain (the workflows, the build and the bundled libraries). Each drives only its own edition's build, which the harness writes to a folder of its own.
- **What each is given.** The source at one commit, the threat model below, and the instruction to break the claims of SECURITY.md and PRIVACY.md, not to confirm them. It is told which surfaces changed since the last reviewed commit (`git diff --stat <commit>..HEAD`), but not what earlier reviews found.
- **Threat model.** The attacker is anyone who can send the user mail (body HTML and CSS, plain text, subject, display names, addresses, Reply-To and References, attachments of any type, file names, the MIME structure itself; Gmail hands over the sender's HTML unfiltered), a web page open in the same browser, a compromised bundled library, and anyone who can influence a build or release (a pull request, an updated action or dependency, a tag). The assets are the Yahoo session and the Google™ access token, the mail, the ability to act as the user, Contacts, and the user's privacy: whether and when mail was read, the IP address, and what a message says.
- **Blind until done.** A reviewer reads neither this file, the Reviews paragraph of SECURITY.md, the history of earlier fixes, nor tools/review.js until its own findings are written; then it says which of them repeat an earlier finding or get past its fix.
- **Shown in the real extension.** A finding counts only when a script shows it: the reviewer plants hostile mail in the mocked Yahoo of tools/harness.js (`launch()`) or the mocked Gmail of tools/gmail-mock.js (`launch({ provider: "gmail" })`) and runs the real built extension against it, never against a real host; outgoing mail and sign-in can also be shown with Node scripts over their modules. Anything not shown goes under hardening. Every confirming script is kept.
- **Severity.** Critical: script runs in an extension page, or the session, the token or mail is readable by a third party. High: the user can be acted for, or mail content leaks without a click, or a release can be made to ship altered code. Medium: one plausible action of the user is needed, or what leaks identifies the user or the moment of reading. Low: unlikely conditions are needed.
- **The report.** The threat model as applied; each finding with its place in the code, its severity, the exact hostile input, what the script showed, why the defence missed it and a fix; the hardening items; and one line for each claim of SECURITY.md that was attacked and held.
- **Afterwards.** Each finding is checked against the code and fixed, the reviewer's scripts are run again against the fixes, and each becomes a scenario of tools/review.js, which the tests run on every push and before every release. This file is then rewritten as the latest review, and the Reviews paragraph of SECURITY.md gives it one line.
