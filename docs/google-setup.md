# Google Cloud™ setup for Baltazar Mail for Gmail™

Google™ lets an app reach a Gmail mailbox only through an OAuth client registered with Google, identified by its Client ID. Baltazar Mail has no server and no shared client, so each user makes a client of their own: it is free, takes about two minutes, and is done once. The extension's sign-in page walks you through it step by step, with this copy's redirect address and a button for every page of Google's; this page is the same guide to read on GitHub, followed by what each of Google's errors means and notes for developers. [gmail-sign-in.md](gmail-sign-in.md) shows each step of the sign-in page with pictures.

## Before you start

The redirect address is where Google sends the answer of a sign-in, and the client must list it exactly. It is `https://<extension id>.chromiumapp.org/`, with the trailing slash; the sign-in page shows the one of your copy, with a Copy button. A copy installed from a release ZIP, or built from this repository, always has the id `enejfhgeailmbkfpdgfdlajlfhnnbafd`, wherever its folder is, so its address is `https://enejfhgeailmbkfpdgfdlajlfhnnbafd.chromiumapp.org/`. A copy from a browser store has the id the store gave it. Several copies (Chrome and Edge, or a ZIP and a store copy) can share one client: list each copy's address on it.

There are two ways to make the client. The quick way, Google's Personal mode, makes the project and the client on one page, needs no review by Google and shows no warning, but only the Google account that made the client can sign in with it. The classic way takes a few more steps and makes an app that any Google account can sign in to, or every account of a work or school organization; Google then warns, at each first sign-in, that it has not verified the app.

## The quick way: Personal mode

1. **Create your Google client.** Open [Google's Personal mode page](https://console.cloud.google.com/auth/overview/personal). Check the picture at the top right: it must be the Google account whose mail you want to read. Leave the project as Google suggests it. Under **Application type**, choose **Web application**. The page has two **Add URI** buttons: click the one under **Authorized redirect URIs** and paste the redirect address. Leave **Authorized JavaScript origins** empty; it refuses the address with "Invalid Origin". Tick the box that accepts the Terms of Service, then click **Continue**. Google shows **OAuth client created**: copy the **Client ID**. The client secret is not needed.
2. **Paste the Client ID** into the sign-in page. It ends in `.apps.googleusercontent.com`; the text of the JSON file that Google lets you download works as well. The page says at once when what you pasted is something else, such as the client secret or the redirect address.
3. **Switch on the Gmail API.** Google keeps it off in a new project. The sign-in page opens the Gmail API page of the client's own project (`https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=<project number>`, where the project number is the first part of the Client ID); click **Enable**. If the page shows **Manage** instead, it is on already.
4. **Sign in with Google.** Choose the Google account you made the client with. Google asks to let Baltazar Mail **Read, compose, send, and permanently delete all your email from Gmail**; allow it, since deleting for good is what Empty Trash and Delete in Trash do.

## The classic way: an app for several accounts

1. Open [Create a project](https://console.cloud.google.com/projectcreate), give it any name, such as `Baltazar Mail`, and click **Create**. Wait until Google shows the new project as selected at the top of the page.
2. Open the [Gmail API page](https://console.cloud.google.com/apis/library/gmail.googleapis.com), check that the new project is selected, and click **Enable**.
3. Open the [Google Auth Platform](https://console.cloud.google.com/auth/overview) and click **Get started**. Under **App Information**, give `Baltazar Mail` as **App name** and choose your address as **User support email**, then **Next**. Under **Audience**, choose **External** to sign in with any Google account, or **Internal** if every account is in your work or school organization, then **Next**. Under **Contact Information**, give your address and click **Next**. Under **Finish**, agree to the **Google API Services: User Data Policy**, then click **Continue** and **Create**.
4. With **External**, open [Audience](https://console.cloud.google.com/auth/audience), click **Publish app** and confirm. Until then, only the accounts listed under **Test users** can sign in, and Google asks them again every week. With **Internal**, skip this step.
5. Open [Clients](https://console.cloud.google.com/auth/clients) and click **Create client**. Under **Application type**, choose **Web application**; any **Name** will do. Of the two **Add URI** buttons, click the one under **Authorized redirect URIs** and paste the redirect address; **Authorized JavaScript origins** stays empty. Click **Create**, then copy the **Client ID**.
6. Paste the Client ID into the sign-in page, and sign in. Google says it **hasn't verified this app**, since the app is your own and nobody else uses it: click **Advanced**, then **Go to Baltazar Mail (unsafe)**. Then allow the permission, as in the quick way.

The scope the extension asks for, `https://mail.google.com/`, is one Google calls restricted, so an app made the classic way stays unverified; Google lets an unverified app be used by up to 100 accounts in all, which is plenty for a client of your own.

## When the sign-in does not work

What the extension can tell by itself, the sign-in page says in words: the window was closed before the end, Google's page could not be loaded, the sign-in was cancelled at Google, the permission for Gmail was left unticked, or the Gmail API is off in the client's project. In the last case Google has already signed you in: switch the API on, wait a minute, and press **Continue**, which needs no second window.

What only Google's window shows, the sign-in page lists under "What did Google's window say?":

| Google's window says | What to do |
|---|---|
| Error 400: redirect_uri_mismatch | The client does not list this copy's redirect address. Open the client, add the address under **Authorized redirect URIs**, and click **Save**. Google can take from five minutes to a few hours to apply a change to a client, so if the address is there already, try again later. A client with no redirect addresses at all is not of type **Web application**: create one that is. |
| Error 400: client_user_mismatch | The client was made in Personal mode by another Google account, and only that account can sign in with it. Choose that account, or make a client of your own while Google's page shows this account. |
| Error 401: invalid_client, or deleted_client | Google does not know this Client ID: part of it is missing, or the client was deleted. Copy it again from your clients and paste it with **Use a different Client ID**. A client deleted in the last 30 days can be restored on Google's page of deleted credentials. |
| Error 403: access_denied, or the app has not completed the Google verification process | The app is still in testing, which lets in only its test users. Open **Audience** and click **Publish app**, or add the account under **Test users**. |
| Google hasn't verified this app | Expected for a client made the classic way. Click **Advanced**, then **Go to Baltazar Mail (unsafe)**. |
| Error 403: org_internal | The app lets in only the accounts of its own organization (**Internal**). Sign in with such an account, or make the audience **External** and publish the app. |
| Error 400: admin_policy_enforced, or access blocked by your administrator | Your organization does not let this account use apps it has not approved. Ask its administrator, or use another account. |
| This app is blocked | Google keeps apps it has not verified away from the mail of accounts in its Advanced Protection Program, and of accounts that a parent supervises. Such an account cannot be used here. |
| Google asks me to sign in again every week | The app is still in testing, where Google's permission lasts seven days. Open **Audience** and click **Publish app**. |
| No window of Google's appeared | Google's sign-in opens in a window of its own, which may be behind the browser's: look for it in the taskbar or the list of windows. |

## After the setup

The sign-in gives the extension an access token, kept in the browser's session storage for this extension, that lasts an hour and is renewed silently while the browser holds your Google session, for the signed-in account only. The extension never opens Google's window by itself: when Google refuses a silent renewal, the sign-in page names the account and waits for the button; a renewal that could not reach Google at all is reported as a connection failure and tried again by itself. **Sign out**, in Settings, withdraws the permission at Google and keeps the Client ID, so signing in again is one press; **Use a different Client ID** on the sign-in page starts the guide again at the paste step. The permission can also be withdrawn in your Google account, under [Third-party apps and services](https://myaccount.google.com/connections).

## For developers

A build carries a client of its own when `gmail/local.json` (ignored by git) names one; the sign-in page then shows only the button, and no guide:

```json
{
  "client_id": "123456789012-abc123def456.apps.googleusercontent.com"
}
```

`node tools/build.js` writes it into the built manifest's `oauth2` block, and refuses a value that is not a Google client id; without it the built manifest has no `oauth2` block at all, and a Client ID the user pastes is kept in the extension's local storage (`gmClientId`) instead. `gmail/manifest.json` carries the public `key` that pins the extension id `enejfhgeailmbkfpdgfdlajlfhnnbafd` for every unpacked copy; the private key it was made from is not in the repository, and is needed only to pack a signed `.crx`. A `key` in `local.json` replaces it, and `--store` leaves it out, since a store assigns the id itself and refuses a key. The browser suites build without `local.json`, into `out/test/`, so every machine tests the extension a release ZIP holds and the copy a browser has loaded from `dist/` is left alone.

A store copy that signs in with one click needs a shared client that Google has verified for the restricted Gmail scope: a brand verification (the app's home page and privacy policy, with the project's domain verified) and a security assessment by a Google-approved assessor under the CASA framework, repeated yearly; Google assigns the tier of the assessment when it reviews the app. The stores (Chrome Web Store, Microsoft Edge Add-ons) give the published copy its own extension id; add that id's redirect address to the shared client before publishing. Until such a client exists, store copies use the guide like every other copy.
