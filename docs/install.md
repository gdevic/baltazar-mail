# Installing and updating

## From a store

The Yahoo Mail™ edition, Baltazar Mail, is in both stores: in Chrome, install [Baltazar Mail from the Chrome Web Store](https://chromewebstore.google.com/detail/baltazar-mail/kkphbfhheikioedcgnjmeldabekdcnib); in Microsoft Edge, install [Baltazar Mail from Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/baltazar-mail/fmfafokapbejponlbknighiecagfcnai). Either store keeps it up to date. Be signed in to mail.yahoo.com in the same browser profile, then click the Baltazar Mail toolbar icon.

## From a release ZIP

Baltazar Mail for Gmail™, and either edition in other Chromium browsers or before a release reaches the stores, installs from a release ZIP, in Chrome, Edge or another browser built on Chromium, version 147 or later:

1. Download `baltazar-mail-yahoo-<version>.zip` (Yahoo™) or `baltazar-mail-gmail-<version>.zip` (Gmail) from the [latest release](https://github.com/gdevic/baltazar-mail/releases/latest) and unzip it into a folder you will keep; it contains one folder, `baltazar-mail-yahoo` or `baltazar-mail-gmail`.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on Developer mode.
3. Click Load unpacked and select that folder.
4. Yahoo: be signed in to mail.yahoo.com in the same browser profile, then click the Baltazar Mail toolbar icon. Gmail: the extension opens its tab by itself when first loaded (later, click the Baltazar Mail for Gmail toolbar icon). Its sign-in page guides you through making a free Google™ client of your own ([each step, with pictures](gmail-sign-in.md)), then you press Sign in with Google; Google asks for the account and the permission once, and the extension renews the sign-in silently afterwards, for that account only (Sign out, at the top of Settings, asks first, then withdraws the permission and clears Contacts; the client stays, so signing in again is one press).

## Updating a ZIP copy

A copy installed this way says in Settings when a newer release is out. To update, put the new release's files into the same folder, replacing the old ones, and click Reload on the extensions page. Windows' Extract All offers a new folder by default, so point it at the folder that contains `baltazar-mail-yahoo` (or `baltazar-mail-gmail`) and confirm replacing the files; macOS's Archive Utility never replaces files, so use `unzip -o baltazar-mail-yahoo-<version>.zip -d <that folder>` in Terminal. Loading the new release from a different folder, or removing the extension, would start over without its settings and Contacts.

## Moving from one copy to another

A ZIP copy in a folder named `baltazar-mail`, from an earlier release or the original Baltazar Mail, is a different extension from one in `baltazar-mail-yahoo`: load `baltazar-mail-yahoo` with Load unpacked, set your preferences again once (its Contacts list rebuilds itself from your message headers), then remove the old copy.

Moving from a ZIP install to a store copy: the store copy is a separate extension, so set your preferences again once; its Contacts list rebuilds itself from your message headers. Then remove the ZIP copy so only one toolbar button remains.

## The Gmail sign-in

Google lets an app reach Gmail only through an OAuth client registered with Google, and Baltazar Mail has no server or shared client, so each user makes one of their own, free. The sign-in page walks through it step by step, with a Copy button for this copy's redirect address and a button for each page of Google's. The quick way is Google's Personal mode: one page, no review by Google and no warning, but only the account that made the client can sign in with it. The classic way, for several accounts or a work or school organization, takes a few more steps and shows Google's "unverified app" screen at each first sign-in. When a sign-in fails, the page says why and what to do, including for each error Google's own window can show. A release ZIP, and any copy built from this repository, has the extension id `enejfhgeailmbkfpdgfdlajlfhnnbafd` wherever its folder is, so its redirect address never changes. [gmail-sign-in.md](gmail-sign-in.md) shows each step of the sign-in page with pictures; `google-setup.md` has the same guide as text, the classic setup, every error and its fix, and what a shared one-click client for a store would need.

## Staying awake in the background

A browser may put a tab you have left to sleep: Edge does it to every background tab after a set time, pinned ones included, and Chrome to a tab that works hard while Energy Saver is on. A sleeping tab cannot check for new mail until you click it, so the new-mail dot stops working. Baltazar Mail keeps its tab awake by itself while you are signed in, with nothing to set up: it holds a Web Lock, which both browsers leave awake, and asks the browser not to discard the tab, which keeps Chrome's Memory Saver from unloading it. Settings › Behaviour has the switch, on unless you turn it off (staying awake costs a little power), and says under it whether the browser put the tab to sleep in the last 7 days and for how long. The **Browser's own setting** link beside it opens the other way to stay awake: this copy's address with a Copy button, to add to the browser's own list of sites it never puts to sleep. Should a tab that was to stay awake sleep all the same, a note says so once and leads there.

The same by hand in Edge, which no extension can do for you:

1. Open `edge://settings/system` and find **Always keep these sites active** (older versions: "Never put these sites to sleep"). Click **Add site**.
2. Enter `chrome-extension://<ID>/`, with the `chrome-` prefix and the trailing slash, where `<ID>` is your copy's 32-letter extension ID:
   - Installed from Microsoft Edge Add-ons: `fmfafokapbejponlbknighiecagfcnai`, the same everywhere.
   - Installed from a release ZIP: for the Gmail edition always `enejfhgeailmbkfpdgfdlajlfhnnbafd`, which the key in its manifest pins; for the Yahoo edition an ID Edge derives from the folder you loaded, different on each computer or folder (it stays the same when you unzip updates over the same folder). A copy you build with a `key` in `local.json` keeps the id that key pins.

   Either way, the ID is in the address bar of the Baltazar Mail tab, after `chrome-extension://`, and on `edge://extensions` with Developer mode turned on.
3. To confirm, open `edge://discards`: the Baltazar Mail row has ✗ under **Is Freezable** (its **View Reason** says why), and its **Lifecycle State** reads "hidden", never "sleeping", while the tab is in the background.

## From the source

From a clone of this repository, run `node tools/build.js` and load `dist/baltazar-mail-yahoo` or `dist/baltazar-mail-gmail` the same way; after a change, build again and click Reload on the extension's card.
