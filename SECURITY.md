# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/gdevic/baltazar-mail/security/advisories/new). Do not open a public issue for them. Include what you found, how to reproduce it, and which version you used.

This is a one-person project; expect an acknowledgement within a few days and a fix as fast as its severity warrants. Reports are credited in the release notes unless you prefer otherwise.

## Supported versions

Only the latest release receives fixes. Updating is a matter of unzipping the new release over the old folder and clicking Reload on the extensions page.

## What is in scope

Baltazar Mail runs with your Yahoo Mail session, so the most important problems are anything that lets a message, an attachment or a web page read your mail, act as you, or send data anywhere other than Yahoo. Problems in Yahoo's own service are out of scope; report those to Yahoo.

## How the extension is protected

- **Network.** The extension's Content Security Policy in `ext/manifest.json` lets its pages connect only to `mail.yahoo.com` and its subdomains, and load images only from those and Yahoo's image proxy. The browser enforces this, so even faulty code cannot send data to a third party. Host permissions are limited to the same mail hosts.
- **Message content.** Message HTML is cleaned with DOMPurify and shown in a sandboxed frame without scripts. Remote images are already routed through Yahoo's proxy by Yahoo, so senders do not see your address when they load.
- **Attachments.** Attachment files are parsed (PDF.js, docx-preview, SheetJS, ZIP listings, text) in `render.html`, a sandbox page with an opaque origin, no cookies, no extension APIs and no network access beyond its own files. Links and keys it reports back are checked before the extension acts on them.
- **Bundled libraries.** Every third-party file is recorded with its source and SHA-256 in `ext/vendor/vendor.json`. A GitHub Actions workflow compares each file with its published original and looks up known vulnerabilities in the OSV database on every change, weekly, and before each release.
- **Code scanning.** CodeQL scans the extension and the workflows on every push and weekly.
- **Releases.** Release ZIPs are built by GitHub Actions from a tagged commit, never on a personal machine, and carry a signed build provenance. Verify one with `gh attestation verify baltazar-mail-<version>.zip -R gdevic/baltazar-mail`.

## Known limits

The extension acts with your Yahoo session; the protections above keep your data from leaving for a third party, but they cannot stop misuse through Yahoo itself, such as sending mail as you, if the extension's own code were compromised. That is why the code is plain, unminified JavaScript with no build step: what is in this repository is exactly what runs.
