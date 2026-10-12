// Switch tabs on LB / RB (content scripts can't touch tabs themselves).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.cmd !== 'tab' || !sender.tab) return;
  chrome.tabs.query({ windowId: sender.tab.windowId }, (tabs) => {
    tabs.sort((a, b) => a.index - b.index);
    const i = tabs.findIndex((t) => t.id === sender.tab.id);
    const next = tabs[(i + msg.delta + tabs.length) % tabs.length];
    chrome.tabs.update(next.id, { active: true });
  });
});
