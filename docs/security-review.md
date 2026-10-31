# Security review, 31 October 2026

An independent review of version 0.14.0, done by an AI agent that had no part in writing the code and was given only the source, a threat model and the instruction to break the claims in SECURITY.md. It confirmed findings by running hostile messages and attachments through the real extension against a mocked Yahoo backend. Every finding was then checked against the code, fixed, and the reviewer's own attack scripts were run again against the fixes.

## Threat model

Anyone who can send the user an email (body HTML, subject, names, attachments, filenames, MIME structure), a malicious web page in the same browser, and a compromised bundled library. Assets: the Yahoo session, mail contents, the ability to act as the user, the address book, and the user's privacy.

## Findings, all fixed

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | On Reply or Forward, the quoted message's HTML was shown in the extension's own page, so a sender's `<style>` blocks and element ids could restyle and clobber the interface (no script ran) | Medium | The quote is shown in a sandboxed frame like the reader; HTML put into the editor (reopened drafts, signatures) is cleaned without style sheets, ids, names or foreign classes |
| 2 | Inline images were found with a regular expression over the HTML text, so an address hidden in another attribute made the extension request any `*.mail.yahoo.com` URL with the user's session, and untyped responses could end up in a reply | Medium | Only real `<img>` sources in Yahoo's exact part-thumbnail shape, in the user's own mailbox, are fetched, and only image responses are kept |
| 3 | A message with tens of thousands of tiny MIME parts made parsing quadratic and could freeze the page for minutes when an attachment was opened | Low/Medium | Every search stays inside its part; part count and nesting depth are capped (40,000 parts now parse in about 35 ms) |
| 4 | Message ids dropped onto Starred were passed unchecked into Yahoo's query language | Low | Dropped ids are filtered to loaded messages, and every id is validated against Yahoo's id alphabet before it reaches a query or URI |
| 5 | "Open in tab" used the sender's declared MIME type, so an HTML attachment opened as a page under the extension's address (no script ran) | Low | Only PDF, raster images, audio, video and plain text open in a tab, typed by file name; everything else is downloaded |
| 6 | The release workflow expanded the tag name inside shell scripts | Low | Values reach the shell only through environment variables, and the tag must look like a version |

## Checked and found sound

- The reader frame runs no scripts, cannot submit forms or navigate itself, and popups from it have no opener or referrer.
- Links to extension pages from a message are blocked by the browser.
- Remote images from non-Yahoo hosts are blocked by the Content Security Policy, which the reader frame inherits.
- The attachment sandbox checks the sender of every message in both directions, allows only http, https and mailto links back out, and range-checks page requests.
- Every place names, addresses, subjects, filenames and folder names reach the page goes through escaping.
- Search values are URL-encoded and stripped of quote and grouping characters.
- The header-rewriting rule applies only to this extension's own requests to Yahoo's mail hosts.
- ZIP listings are bounds-checked and spreadsheet previews are capped.
- The CodeQL and library-check workflows have read-only permissions and no untrusted triggers.
