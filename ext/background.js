// Toolbar button opens the client in its own tab, reusing an existing one if present.
const PAGE = chrome.runtime.getURL("mail.html");

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: PAGE });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: PAGE });
  }
});

// The /c/ edge proxy rejects batch calls whose Origin is not mail.yahoo.com (error EP-4010).
// Rewrite Origin and Referer on this extension's own requests so they match the web client's.
const RULES = [{
  id: 1, priority: 1,
  action: {
    type: "modifyHeaders",
    requestHeaders: [
      { header: "Origin", operation: "set", value: "https://mail.yahoo.com" },
      { header: "Referer", operation: "set", value: "https://mail.yahoo.com/" },
    ],
  },
  condition: {
    urlFilter: "||mail.yahoo.com/",
    initiatorDomains: [chrome.runtime.id],
    resourceTypes: ["xmlhttprequest"],
  },
}];

async function installRules() {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: existing.map(r => r.id), addRules: RULES });
}
chrome.runtime.onInstalled.addListener(installRules);
chrome.runtime.onStartup.addListener(installRules);
installRules();
