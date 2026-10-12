// Background script: things content scripts can't do themselves.
//  - LB / RB switch tabs.
//  - Relay messages between the engine (content script in a tab's top frame) and the clients
//    (content scripts in its iframes). Pages can't send or forge extension messages, and the
//    tab/frame ids come from the browser, so a page that embeds another site can't drive
//    SofaNav inside it (see content.js "frame transport", docs E29).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab || sender.id !== chrome.runtime.id) return;
  const tabId = sender.tab.id;

  if (msg?.cmd === 'tab') {
    chrome.tabs.query({ windowId: sender.tab.windowId }, (tabs) => {
      tabs.sort((a, b) => a.index - b.index);
      const i = tabs.findIndex((t) => t.id === tabId);
      const next = tabs[(i + msg.delta + tabs.length) % tabs.length];
      chrome.tabs.update(next.id, { active: true });
    });
    return;
  }

  // Engine -> one client: only the top frame may command, and only frames of its own tab.
  if (msg?.sofanav === 'toFrame') {
    if (sender.frameId !== 0 || !Number.isInteger(msg.frameId) || msg.frameId === 0) return;
    chrome.tabs.sendMessage(tabId, { sofanav: 'cmd', msg: msg.msg }, { frameId: msg.frameId }).catch(() => {});
    return;
  }

  // Client -> engine: always to the top frame, tagged with the sender's real frame id.
  if (msg?.sofanav === 'toTop') {
    if (sender.frameId === 0) return;
    chrome.tabs.sendMessage(tabId, { sofanav: 'fromFrame', frameId: sender.frameId, msg: msg.msg }, { frameId: 0 }).catch(() => {});
  }
});
