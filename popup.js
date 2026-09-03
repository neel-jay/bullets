const statusEl = document.getElementById("keyStatus");
const openBtn = document.getElementById("openOptions");
const sumBtn = document.getElementById("summarize");

chrome.storage.sync.get(["deepseekApiKey", "provider", "localModel"], ({ deepseekApiKey, provider, localModel }) => {
  if (provider === "local") {
    statusEl.textContent = "✓ Local AI (" + (localModel || "qwen2.5:14b") + ") — privacy mode";
    statusEl.className = "ok";
  } else if (deepseekApiKey) {
    statusEl.textContent = "✓ API key set (" + deepseekApiKey.slice(0, 6) + "…)";
    statusEl.className = "ok";
  } else {
    statusEl.textContent = "⚠ No API key — click Set API Key";
    statusEl.className = "warn";
  }
});

openBtn.onclick = () => chrome.runtime.openOptionsPage();

sumBtn.onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const url = tab.url || "";
  const hasVideo =
    /youtube\.com\/watch/i.test(url) ||
    /youtube\.com\/shorts\//i.test(url) ||
    /youtube\.com\/live\//i.test(url) ||
    /youtube\.com\/embed\//i.test(url) ||
    /youtu\.be\//i.test(url);
  if (!hasVideo) {
    statusEl.textContent = "Open a YouTube video first (watch, Shorts, or live)";
    statusEl.className = "warn";
    return;
  }
  // Trigger same flow as context menu by messaging background? Instead directly invoke via sendMessage to background not needed.
  // We use chrome.contextMenus simulation: ask background to summarize
  // Quick hack: use scripting to trigger summarize via background's handler? Instead just tell user to right-click.
  // Better: send message to background to execute summarize
  chrome.runtime.sendMessage({ type: "POPUP_SUMMARIZE", tabId: tab.id, url: tab.url });
  window.close();
};

// Listen for relay in background
chrome.runtime.onMessage.addListener((m) => {
  if (m.type === "OPEN_OPTIONS") chrome.runtime.openOptionsPage();
});
