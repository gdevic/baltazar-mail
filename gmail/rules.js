// The Gmail extension's part of the service worker. The Gmail API takes the extension's requests
// as they are, so no request rules are installed here (yahoo/rules.js installs Yahoo's). On its
// first install the extension opens its mail tab, whose sign-in page walks the user through the
// setup of a Google client, so nobody has to find the toolbar button first; an update or a reload
// opens nothing.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("mail.html") }).catch(() => {});
});
