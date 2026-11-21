# Security review, 21 November 2026

An independent review of commit 3934a9d (version 0.22.0 and the work after it), the first to cover both editions, the one for Yahoo Mail™ and the one for Gmail™, and the supply chain. It was done by two AI agents that had no part in writing the code, one for each edition, each given the source, the threat model below and the instruction to break the claims of SECURITY.md and PRIVACY.md. Neither saw an earlier review's findings until its own were written. Every finding was shown by a script running hostile mail through the real built extension against a mocked Yahoo™ or Gmail, then checked against the code, fixed or decided, and the reviewers' scripts were run again against the fixes; each fix has a scenario in tools/review.js, which the tests run on every push and before every release.

## Threat model

Anyone who can send the user mail (body HTML and CSS, plain text, subject, display names, addresses, Reply-To and References, attachments of any type, file names, the MIME structure itself; Gmail hands over the sender's HTML unfiltered), a web page open in the same browser, a compromised bundled library, and anyone who can influence a build or release. Assets: the Yahoo session and the Google™ access token, the mail, the ability to act as the user, Contacts, and the user's privacy.

## Findings

| # | Finding | Severity | Outcome |
|---|---|---|---|
| 1 | A reply to or forward of a message whose images the reader holds back (Spam, Trash, or the setting) loaded the sender's images in the composer, through a `srcset` whose first candidate is `cid:` and through SVG `fill`, `mask` and `clip-path`; it told the sender that, and when, the message was answered. It got past the fix for finding 1 of the 31 October review | Medium | Fixed: while images are held, every `srcset` is held, and so is every attribute read as CSS (`style` and SVG's painting and clipping attributes) that names an address |
| 2 | In the Gmail edition a message's styles can still pick an image by what they see of the page: the window's width, a dark or light theme, the kind of pointer, what the pointer is over, the direction of the text and the message's own structure, and the image comes from the sender's server | Medium (privacy) | Kept: dropping such rules would break responsive and dark-mode mail. SECURITY.md and PRIVACY.md now say what a sender can learn this way; no rule that reads the values a message holds survives |
| 3 | A message's style sheet could move its own box over the printed header with a `:host` rule, so a printout or PDF showed a From, To, Date and Subject of the sender's choosing | Low | Fixed: `:host` rules are dropped with the other rules that read the page |
| 4 | A received message whose From is the user's own address put its recipients among the people the user wrote to, ranked above the real people of the same name in the suggestions | Low | Fixed: a message in Inbox is taken as received, whatever its From says |

The bug review done at the same time found two gaps in how the security claims are tested, both closed: the browser scenarios of tools/review.js, the security regressions among them, ran in no workflow, so no release waited for them; and the check that the attachment sandbox cannot reach the network could not fail, as the browser's CORS rules refused the probe either way. The scenarios now run in CI, and the check asserts that the request never left the sandbox.

## Hardening done

- Every action the workflows use is named by the commit of its release, so a moved tag cannot change what a signed release build runs.
- Links in SVG and in image maps of an attachment preview are handed back like any other link, and checked the same way.
- A suggestion's hide button names its row rather than an address read back from escaped text, which loses bidi controls; Copy addresses keeps the semicolon out of names.
- A draft reopened while images are set to never keeps its quote's remote images back.
- The Contacts view and the reader's contact card write the addresses and ids they read back into `data-` attributes with an escape that keeps bidi controls, so an address holding them is acted on as itself, not as the look-alike shown.
- PRIVACY.md says that a picture shown through Yahoo's proxy still tells its sender when the message was read.

## Hardening left

- A reply to a Spam message saved as a draft loads its quote's images when it is reopened, unless images are set to never.
- The Gmail app page may load images from any `https:` host, which its reader frame inherits; an HTML injection into the app page could use that, and none was found.
- The test workflow compares the bundled libraries with their recorded hashes only; the library workflow and every release compare them with their published originals.

## Checked and found sound

- No message, attachment or file name ran script, in the reader, the composer, the print page or the attachment sandbox: onerror and onload handlers, `javascript:` links, SVG, `<noscript>` mutation, forms, frames and meta refresh were all neutralised.
- No extension page loads an image from Yahoo's mail hosts, by any of `img`, `srcset`, `<source>`, SVG attributes, inline styles or `image-set()`, so mail cannot make a request that carries the Yahoo cookies; inline parts are fetched only in Yahoo's part shape, from the user's own mailbox and the message's own id.
- Links in messages keep their target only as an absolute http, https, mailto or tel address and open with no opener or referrer; the reader frame cannot navigate itself.
- The attachment sandbox has an opaque origin, no cookies, no extension APIs and no network; it checks the sender of every message both ways, and what it reports back is checked before the app acts on it. SVG pictures are shown as bitmaps, and only inert types open in a tab.
- Gmail sign-in uses the browser's own flow with a state check, keeps the token in session storage only, sends it only in a header or the revoke body, accepts a renewal only for the account signed in, and revokes it at sign-out.
- Outgoing Gmail mail cannot carry an injected header: display names and subjects are encoded, an address is written only when it is one address, and threading headers carry message ids only, a bounded number of them.
- Search values and ids reach no query unchecked; folder, message, account and task ids are validated.
- The Contacts file is read with bounds and quoting, and Replace refuses unreadable lines and asks first.
- The release check sends no credentials and takes only a `vX.Y.Z` tag; releases are built in Actions from a checked tag, values reach the shell only through environment variables, provenance is signed, and no pull request can start a release.

## Earlier reviews

- **31 October 2026**, version 0.14.0, the Yahoo edition: six findings, none letting script run, all fixed. The quoted message in a reply could restyle the app's own page; inline images were found by a regular expression, so an address hidden in an attribute was fetched with the session; a message of tens of thousands of MIME parts froze the page; ids dropped on Starred reached Yahoo's query language unchecked; Open in tab used the sender's type; the release workflow expanded the tag name inside shell scripts.
- **1 November 2026**, the Yahoo edition: no way for mail, attachments or GitHub to run script or reach the session; its medium findings, about quoted content in reply drafts and images and styles in quotes and print, were fixed.

## How a review is done

A review is done by AI agents that had no part in writing the code, so that it looks where the code's authors would not. It is repeated before each minor release, and whenever a new surface lands: an edition, a parser of mail or files, a permission, or a change to a Content Security Policy.

- **Reviewers.** Two work at once, one for each edition: one takes the shared code with the Yahoo edition, the other the Gmail edition and the supply chain (the workflows, the build and the bundled libraries). Each drives only its own edition's build, which the harness writes to a folder of its own.
- **What each is given.** The source at one commit, the threat model above, and the instruction to break the claims of SECURITY.md and PRIVACY.md, not to confirm them. It is told which surfaces changed since the last reviewed commit (`git diff --stat <commit>..HEAD`), but not what earlier reviews found.
- **Blind until done.** A reviewer reads neither this file, the Reviews paragraph of SECURITY.md, the history of earlier fixes, nor tools/review.js until its own findings are written; then it says which of them repeat an earlier finding or get past its fix.
- **Shown in the real extension.** A finding counts only when a script shows it: the reviewer plants hostile mail in the mocked Yahoo of tools/harness.js (`launch()`) or the mocked Gmail of tools/gmail-mock.js (`launch({ provider: "gmail" })`) and runs the real built extension against it, never against a real host; outgoing mail and sign-in can also be shown with Node scripts over their modules. Anything not shown goes under hardening. Every confirming script is kept.
- **Severity.** Critical: script runs in an extension page, or the session, the token or mail is readable by a third party. High: the user can be acted for, or mail content leaks without a click, or a release can be made to ship altered code. Medium: one plausible action of the user is needed, or what leaks identifies the user or the moment of reading. Low: unlikely conditions are needed.
- **The report.** The threat model as applied; each finding with its place in the code, its severity, the exact hostile input, what the script showed, why the defence missed it and a fix; the hardening items; and one line for each claim of SECURITY.md that was attacked and held.
- **Afterwards.** Each finding is checked against the code and fixed, the reviewer's scripts are run again against the fixes, and each becomes a scenario of tools/review.js, which the tests run on every push and before every release. This file is then rewritten as the latest review, and the Reviews paragraph of SECURITY.md gives it one line.
