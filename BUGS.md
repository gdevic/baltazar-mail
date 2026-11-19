# Known bugs and problems

Confidence: **confirmed** means the failing code path was read end to end; **likely** means the code path is confirmed but depends on Gmail™ or browser behaviour that was not tested live; **speculative** means plausible but unverified.

## Summary

| # | Severity | Area | Finding | Confidence |
|---|---|---|---|---|
| C1 | Critical | Release | Gmail release and store ZIPs ship the placeholder OAuth client id and no `key`; sign-in is impossible | confirmed |

## Critical

### C1. The Gmail release and store ZIPs cannot sign in

- **Where:** `gmail/manifest.json:28`, `tools/build.js` (`build`, where `local.json` is read), `.github/workflows/release.yml` (Gmail package step), `README.md` (Install, "Gmail and Google's sign-in"), `docs/google-setup.md:3`, `store/LISTING-gmail.md:3`.
- **Failure:** `gmail/local.json` is gitignored and CI provides nothing, so every built `manifest.json` carries `"client_id": "CLIENT_ID.apps.googleusercontent.com"` and no `key`. Sign in with Google fails with `invalid_client`. Even with a real client id, a ZIP without `key` gets an extension id derived from the user's unzip folder, so no redirect URI registered by the project can match it. A hand edit of `manifest.json` is lost on the next update, since updates unzip over the same folder. The README says a release ZIP "carries the project's client id", which is false today, and `build.js` does not complain about the placeholder.
- **Fix:** inject the client id from a repository secret in `release.yml` and commit the public `key` (or supply it the same way); make `build.js` fail on the placeholder in a release build (for example `--release`); correct the README until then.
