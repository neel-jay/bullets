const input = document.getElementById("apiKey");
const toggle = document.getElementById("toggle");
const saveBtn = document.getElementById("save");
const testBtn = document.getElementById("test");
const statusEl = document.getElementById("status");
const styleSel = document.getElementById("summaryStyle");
const showTranscriptChk = document.getElementById("showTranscript");
const vaultInput = document.getElementById("obsidianVault");
const folderInput = document.getElementById("obsidianFolder");
const saveObsidianBtn = document.getElementById("saveObsidian");
const obsidianStatusEl = document.getElementById("obsidianStatus");
const processModeSel = document.getElementById("processMode");
const cacheInfoEl = document.getElementById("cacheInfo");
const clearCacheBtn = document.getElementById("clearCache");
const providerSel = document.getElementById("provider");
const localFields = document.getElementById("localFields");
const localEndpointInput = document.getElementById("localEndpoint");
const localModelInput = document.getElementById("localModel");

chrome.storage.sync.get(["deepseekApiKey", "summaryStyle", "showTranscript", "obsidianVault", "obsidianFolder", "processMode", "provider", "localEndpoint", "localModel"], (res) => {
  if (res.deepseekApiKey) input.value = res.deepseekApiKey;
  if (res.summaryStyle) styleSel.value = res.summaryStyle;
  else styleSel.value = "auto";
  showTranscriptChk.checked = !!res.showTranscript;
  if (res.obsidianVault) vaultInput.value = res.obsidianVault;
  if (res.obsidianFolder) folderInput.value = res.obsidianFolder;
  else if (folderInput) folderInput.placeholder = "Clips";
  if (res.processMode) processModeSel.value = res.processMode;
  else processModeSel.value = "full";
  if (providerSel) {
    providerSel.value = res.provider || "deepseek";
    localFields.style.display = providerSel.value === "local" ? "block" : "none";
  }
  if (localEndpointInput) localEndpointInput.value = res.localEndpoint || "";
  if (localModelInput) localModelInput.value = res.localModel || "";
});

if (providerSel) {
  providerSel.onchange = async () => {
    localFields.style.display = providerSel.value === "local" ? "block" : "none";
    await chrome.storage.sync.set({ provider: providerSel.value });
    showStatus(providerSel.value === "local" ? "Provider: Local AI ✓" : "Provider: DeepSeek ✓", "ok");
  };
}

async function saveLocalSettings(silent) {
  if (!localEndpointInput || !localModelInput) return;
  const endpoint = localEndpointInput.value.trim() || "http://localhost:11434/v1";
  const model = localModelInput.value.trim() || "qwen2.5:14b";
  await chrome.storage.sync.set({ localEndpoint: endpoint, localModel: model });
  if (!silent) showStatus(`Local AI saved ✓ — ${endpoint} • ${model}`, "ok");
  return { endpoint, model };
}

if (localEndpointInput) localEndpointInput.addEventListener("change", () => saveLocalSettings(true));
if (localModelInput) localModelInput.addEventListener("change", () => saveLocalSettings(true));
if (processModeSel) {
  processModeSel.onchange = async () => {
    await chrome.storage.sync.set({ processMode: processModeSel.value });
    showStatus(`Processing mode: ${processModeSel.options[processModeSel.selectedIndex].text.split("—")[0].trim()} ✓`, "ok");
  };
}
// cache info + clear
async function refreshCacheInfo() {
  if (!cacheInfoEl) return;
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(k=>k.startsWith("yt_sum_cache_"));
    let totalKB = 0;
    for (const k of keys) {
      try { totalKB += JSON.stringify(all[k]).length / 1024; } catch {}
    }
    cacheInfoEl.textContent = `Cache: ${keys.length} videos • ${Math.round(totalKB)} KB • 7-day TTL • re-summarize instant`;
  } catch { cacheInfoEl.textContent = "Cache: unavailable"; }
}
refreshCacheInfo();
if (clearCacheBtn) {
  clearCacheBtn.onclick = async () => {
    try {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter(k=>k.startsWith("yt_sum_cache_"));
      if (keys.length) await chrome.storage.local.remove(keys);
      showStatus(`Cache cleared • ${keys.length} entries removed ✓`, "ok");
      refreshCacheInfo();
    } catch(e){ showStatus("Clear failed: "+e.message, "err"); }
  };
}

styleSel.onchange = async () => {
  await chrome.storage.sync.set({ summaryStyle: styleSel.value });
  showStatus(`Style saved: ${styleSel.options[styleSel.selectedIndex].text} ✓`, "ok");
};
showTranscriptChk.onchange = async () => {
  await chrome.storage.sync.set({ showTranscript: showTranscriptChk.checked });
  showStatus(showTranscriptChk.checked ? "Transcript button enabled ✓" : "Transcript button disabled", "ok");
};

toggle.onclick = () => {
  const isPass = input.type === "password";
  input.type = isPass ? "text" : "password";
  toggle.textContent = isPass ? "Hide" : "Show";
};

saveBtn.onclick = async () => {
  await saveLocalSettings(true);
  const provider = providerSel ? providerSel.value : "deepseek";
  if (provider === "local") {
    showStatus("Local AI settings saved ✓ — API key not required", "ok");
    return;
  }
  const key = input.value.trim();
  if (!key) return showStatus("Please paste API key", "err");
  if (!key.startsWith("sk-")) {
    showStatus("Warning: DeepSeek keys usually start with sk- — saving anyway", "err");
  }
  await chrome.storage.sync.set({ deepseekApiKey: key });
  showStatus("API key saved ✓", "ok");
};

testBtn.onclick = async () => {
  const provider = providerSel ? providerSel.value : "deepseek";
  if (provider === "local") {
    const { endpoint, model } = await saveLocalSettings(true);
    showStatus(`Testing local AI (${model})…`, "ok");
    testBtn.disabled = true;
    try {
      const isOllama = endpoint.includes("11434") || endpoint.includes("ollama");
      let res, data;
      if (isOllama) {
        // Ollama native API with think:false (qwen3.5 thinking otherwise needs 50+ tokens before content)
        const nativeBase = endpoint.replace(/\/v1\/?$/, "").replace(/\/+$/, "") || "http://localhost:11434";
        res = await fetch(`${nativeBase}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Reply with just: OK" }],
            stream: false,
            think: false,
            options: { num_predict: 20, temperature: 0.5, num_ctx: 2048 }
          })
        });
        if (!res.ok) {
          const t = await res.text();
          let hint = "";
          if (res.status === 403) hint = " — Ollama blocked chrome-extension origin. Fix: quit Ollama app, then in Terminal run: OLLAMA_ORIGINS=\"*\" ollama serve  (keep Terminal open). For permanent: launchctl setenv OLLAMA_ORIGINS \"*\" then restart Ollama. Then Test again.";
          else if (res.status === 404) hint = " — Model not found. Run: ollama pull " + model + "  or run: ollama list  to see installed models.";
          throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}${hint}`);
        }
        data = await res.json();
        if (!data.message?.content || !data.message.content.trim()) throw new Error("Empty response (thinking not disabled?)");
      } else {
        // LM Studio / generic OpenAI-compatible
        res = await fetch(`${endpoint.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Reply with just: OK" }],
            max_tokens: 20,
            stream: false
          })
        });
        if (!res.ok) {
          const t = await res.text();
          let hint = "";
          if (res.status === 403) hint = " — Blocked (CORS). Try OLLAMA_ORIGINS=\"*\" ollama serve or check endpoint.";
          else if (res.status === 404) hint = " — Model not found. Check model name in LM Studio / ollama list.";
          throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}${hint}`);
        }
        data = await res.json();
        const c = data.choices?.[0]?.message?.content;
        if (!c || !c.trim()) throw new Error("Empty response");
      }
      showStatus(`Local AI reachable ✓ (${model}) — ${isOllama ? "think:false, 0.4s" : "OpenAI-compat"}`, "ok");
    } catch (e) {
      showStatus("Test failed: " + e.message, "err");
    } finally {
      testBtn.disabled = false;
    }
    return;
  }
  const key = input.value.trim();
  if (!key) return showStatus("Paste API key first", "err");
  showStatus("Testing…", "ok");
  testBtn.disabled = true;
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "Reply with just: OK" }],
        max_tokens: 5
      })
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    showStatus("API key valid ✓ DeepSeek reachable", "ok");
  } catch (e) {
    showStatus("Test failed: " + e.message, "err");
  } finally {
    testBtn.disabled = false;
  }
};

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = "status " + type;
}

function showObsidianStatus(msg, type) {
  if (!obsidianStatusEl) return;
  obsidianStatusEl.textContent = msg;
  obsidianStatusEl.className = "status " + type;
}

if (saveObsidianBtn) {
  saveObsidianBtn.onclick = async () => {
    const vault = vaultInput.value.trim();
    const folder = folderInput.value.trim() || "Clips";
    // sanitize folder: no leading/trailing slash, no illegal
    const cleanFolder = folder.replace(/^\/+|\/+$/g, "").trim() || "Clips";
    await chrome.storage.sync.set({ obsidianVault: vault, obsidianFolder: cleanFolder });
    if (folderInput) folderInput.value = cleanFolder;
    showObsidianStatus(`Obsidian settings saved ✓ — vault: ${vault || "(auto)"} • folder: ${cleanFolder}`, "ok");
  };
  vaultInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveObsidianBtn.click(); });
  folderInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveObsidianBtn.click(); });
}

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBtn.click();
});
