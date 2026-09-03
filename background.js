// background.js - service worker
const MENU_ID = "yt-summarize-deepseek";

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    // Single menu that appears on any YouTube page, on links/images/videos/pages
    // We filter by videoId in onClicked, so showing extra is okay.
    // targetUrlPatterns restricts link/image/video to YouTube watch/shorts/youtu.be
    try {
      chrome.contextMenus.create({
        id: MENU_ID,
        title: "AI Summary",
        contexts: ["link", "image", "video", "page", "frame"],
        documentUrlPatterns: ["*://*.youtube.com/*", "*://*.youtu.be/*"],
        icons: {
          "16": "icons/icon16.png",
          "32": "icons/icon32.png"
        }
      });
    } catch (e) {
      // Fallback without documentUrlPatterns / icons (older Chrome)
      try {
        chrome.contextMenus.create({
          id: MENU_ID,
          title: "AI Summary",
          contexts: ["link", "image", "video", "page"],
          icons: {
            "16": "icons/icon16.png",
            "32": "icons/icon32.png"
          }
        });
      } catch {
        chrome.contextMenus.create({
          id: MENU_ID,
          title: "AI Summary",
          contexts: ["link", "image", "video", "page"]
        });
      }
    }
  });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

// Also ensure menu exists when service worker wakes
createMenus();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  if (!tab?.id) return;

  const videoId = getVideoIdFromClick(info, tab);
  if (!videoId) {
    // Try to inject and show error on tab if possible
    try {
      await ensureContent(tab.id);
      sendToTab(tab.id, { type: "SHOW_ERROR", error: "No YouTube video found. Right-click on a video thumbnail, link, or on the watch page itself." });
    } catch {}
    return;
  }
  await handleSummarize(tab.id, videoId, info.linkUrl || tab.url);
});

async function handleSummarize(tabId, videoId, sourceUrl) {
  if (!videoId) {
    const err = "No YouTube video ID found.";
    sendToTab(tabId, { type: "SHOW_ERROR", error: err });
    return;
  }
  const { deepseekApiKey, summaryStyle, showTranscript, processMode } = await chrome.storage.sync.get(["deepseekApiKey", "summaryStyle", "showTranscript", "processMode"]);
  const cfg = await getProviderConfig();
  if (cfg.provider === "deepseek" && !deepseekApiKey) {
    try { await ensureContent(tabId); } catch {}
    sendToTab(tabId, { type: "SHOW_ERROR", error: "DeepSeek API key missing. Click extension icon → Set API Key." });
    chrome.runtime.openOptionsPage();
    return;
  }
  const mode = processMode || "full"; // full = comprehensive parallel, fast = single-pass truncated
  try { await ensureContent(tabId); } catch (_) {}
  // --- CACHE CHECK (chrome.storage.local, instant on repeat) ---
  const cacheKey = `yt_sum_cache_${videoId}_${summaryStyle||"auto"}_${mode}_${cfg.model}`;
  try {
    const cached = await chrome.storage.local.get(cacheKey);
    const entry = cached[cacheKey];
    if (entry && entry.pages && entry.summary && Date.now() - entry.ts < 7*24*60*60*1000) {
      console.log("[yt-sum] cache hit", videoId, mode);
      sendToTab(tabId, { type: "SHOW_SUMMARY", summary: entry.summary, pages: entry.pages, videoId, meta: entry.meta, cached: true });
      // also show subtle loading hint that it's cached
      return;
    }
  } catch(e) { console.warn("cache read fail", e); }

  sendToTab(tabId, { type: "SHOW_LOADING", text: "Fetching transcript…" });
  try {
    const data = await fetchTranscriptWithFallback(tabId, videoId);
    if (!data || !data.transcript || data.transcript.trim().length < 20) throw new Error("Transcript empty or unavailable");
    const style = summaryStyle || "auto";
    const meta = { title: data.title, duration: data.durationSeconds, channel: data.channel, segments: data.segments || [] };
    if (showTranscript) meta.transcript = data.transcript.slice(0, 8000);

    // progress helper -> pushes updates to reader so 10-min wait feels live, not stuck
    const onProgress = (p) => {
      try { sendToTab(tabId, { type: "SHOW_LOADING", text: p.text, sub: p.sub }); } catch {}
    };
    // partial streaming helper: as soon as first chunk done, render it immediately
    const onPartial = (partial) => {
      try {
        // partial = { pagesSoFar, fullSoFar, loaded, total, isPartial:true }
        // Send as SHOW_SUMMARY with isPartial flag so reader shows streaming banner
        sendToTab(tabId, { type: "SHOW_SUMMARY", summary: partial.fullSoFar, pages: partial.pagesSoFar, videoId, meta, isPartial: true, progress: { loaded: partial.loaded, total: partial.total } });
      } catch {}
    };
    onProgress({ text: `Transcript ${Math.round(data.transcript.length/1000)}k chars • ${formatDuration(data.durationSeconds)} — summarizing via ${cfg.model}…`, sub: mode==="fast" ? "Fast mode: single-pass (truncated)" : (data.transcript.length > 60000 ? "Full mode: parallel multi-part" : "Single-pass analysis") });

    // FAST MODE: truncate transcript and single call, much faster, less thorough
    let transcriptForAI = data.transcript;
    let fastOpts = null;
    if (mode === "fast" && data.transcript.length > 50000) {
      transcriptForAI = data.transcript.slice(0, 50000) + "\n\n[Transcript truncated for fast mode — enable Full mode for complete analysis]";
      fastOpts = { maxTokens: cfg.provider === "local" ? 600 : 2500 }; // local: much smaller (23 tok/s, 2500=108s vs 600=26s)
      onProgress({ text: `Fast mode: summarizing first 50k chars only…`, sub: `Full transcript ${Math.round(data.transcript.length/1000)}k → truncated 50k • ~50% faster` });
    }
    // local fast even without truncation: cap maxTokens early (handled in summarizeChunk) and hint
    if (mode === "fast" && cfg.provider === "local" && !fastOpts) {
      fastOpts = { maxTokens: 600 };
    }

    const result = await summarizeWithDeepSeek(transcriptForAI, deepseekApiKey, videoId, { title: data.title, duration: data.durationSeconds, channel: data.channel, style }, onProgress, onPartial, fastOpts, cfg);

    // result may be { pages, fullMarkdown } for new flow or legacy string
    let summary, pages;
    if (result && typeof result === "object" && Array.isArray(result.pages)) {
      pages = result.pages;
      summary = result.fullMarkdown || pages.join("\n\n---\n\n");
    } else {
      summary = result;
      pages = null;
    }
    // --- CACHE WRITE ---
    try {
      const entry = { summary, pages, meta, ts: Date.now(), mode, style };
      await chrome.storage.local.set({ [cacheKey]: entry });
      // also prune old cache entries to avoid quota (keep last 30)
      try { await pruneCache(30); } catch {}
    } catch(e) { console.warn("cache write fail", e); }

    sendToTab(tabId, { type: "SHOW_SUMMARY", summary, pages, videoId, meta, isPartial: false });
  } catch (err) {
    console.error(err);
    sendToTab(tabId, { type: "SHOW_ERROR", error: err.message || String(err) });
  }
}

async function pruneCache(keep=30) {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k=>k.startsWith("yt_sum_cache_"));
  if (keys.length <= keep) return;
  // sort by ts oldest first
  const entries = keys.map(k=>({k, ts: all[k]?.ts||0})).sort((a,b)=>a.ts-b.ts);
  const toRemove = entries.slice(0, keys.length - keep).map(e=>e.k);
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}

async function ensureContent(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
}

function getVideoIdFromClick(info, tab) {
  const candidates = [
    info.linkUrl,
    info.srcUrl,
    info.frameUrl,
    info.pageUrl,
    tab?.url
  ];
  for (const u of candidates) {
    if (!u) continue;
    const id = extractVideoId(u);
    if (id) return id;
  }
  // Thumbnails are often i.ytimg.com/vi/VIDEOID/...
  const imgSrc = info.srcUrl || "";
  const m = imgSrc.match(/\/vi\/([a-zA-Z0-9_-]{11})\//);
  if (m) return m[1];
  const m2 = imgSrc.match(/\/vi\/([a-zA-Z0-9_-]{11})[\/\?]/);
  if (m2) return m2[1];
  // Also check linkUrl may be like /watch?v=ID without domain
  if (info.linkUrl && info.linkUrl.includes("v=")) {
    const id2 = extractVideoId("https://www.youtube.com" + (info.linkUrl.startsWith("/") ? info.linkUrl : "/" + info.linkUrl));
    if (id2) return id2;
  }
  return null;
}

function extractVideoId(url) {
  if (!url) return null;
  try {
    // Handle relative URLs
    if (url.startsWith("/")) url = "https://www.youtube.com" + url;
    const u = new URL(url);
    if (u.searchParams.get("v")) {
      const v = u.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      // v may contain extra params like v=ID&list=...
      const m = v.match(/^([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    }
    // youtu.be/ID
    const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:shorts\/|embed\/|v\/|live\/))([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
    // i.ytimg.com/vi/ID
    const m3 = url.match(/\/vi\/([a-zA-Z0-9_-]{11})/);
    if (m3) return m3[1];
    return null;
  } catch { return null; }
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return "unknown";
  const s = parseInt(seconds, 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s (${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")})`;
  if (m > 0) return `${m}m ${sec}s (${m}:${String(sec).padStart(2,"0")})`;
  return `${sec}s (0:${String(sec).padStart(2,"0")})`;
}

// ---------- Transcript + metadata fetching ----------

async function fetchTranscriptWithFallback(tabId, videoId) {
  // 1. Try ANDROID InnerTube (no POT needed) - works from background, also gives title/duration
  try {
    const data = await fetchViaAndroid(videoId);
    if (data && data.transcript && data.transcript.length > 30) {
      console.log("transcript via ANDROID ok", data.transcript.length, data.title);
      return data;
    }
  } catch (e) {
    console.warn("ANDROID fetch failed", e);
  }

  // 2. Try content-script POT capture + WEB timedtext
  try {
    const data2 = await fetchViaContentPot(tabId, videoId);
    if (data2 && data2.transcript && data2.transcript.length > 30) {
      console.log("transcript via POT ok", data2.transcript.length);
      // data2 may not have metadata, try to enrich via Android metadata separately
      if (!data2.title) {
        try {
          const meta = await fetchMetadataOnly(videoId);
          data2.title = meta.title;
          data2.durationSeconds = meta.durationSeconds;
          data2.channel = meta.channel;
        } catch {}
      }
      return data2;
    }
  } catch (e) {
    console.warn("POT fetch failed", e);
  }

  // 3. Fallback old method (web watch html scraping)
  try {
    const data3 = await fetchViaWebScrape(videoId);
    if (data3 && data3.transcript && data3.transcript.length > 30) return data3;
  } catch (e) {
    console.warn("web scrape failed", e);
  }

  throw new Error("No captions/transcript available. The video may have captions disabled, or YouTube blocked the request (POT required). Try another video or open the video and use the in-page transcript panel.");
}

async function fetchMetadataOnly(videoId) {
  let apiKey = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  try {
    const html = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: { "User-Agent": "Mozilla/5.0" } }).then(r => r.text());
    const m = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    if (m && m[1]) apiKey = m[1];
  } catch (_) {}
  const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } }, videoId })
  });
  if (!res.ok) throw new Error(`player ${res.status}`);
  const data = await res.json();
  return {
    title: data?.videoDetails?.title || data?.microformat?.playerMicroformatRenderer?.title?.simpleText || "Unknown title",
    durationSeconds: parseInt(data?.videoDetails?.lengthSeconds || 0, 10) || 0,
    channel: data?.videoDetails?.author || data?.microformat?.playerMicroformatRenderer?.ownerChannelName?.simpleText || ""
  };
}

async function fetchViaAndroid(videoId) {
  let apiKey = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  let html = "";
  try {
    html = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: { "User-Agent": "Mozilla/5.0" } }).then(r => r.text());
    const m = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    if (m && m[1]) apiKey = m[1];
  } catch (_) {}

  const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } }, videoId })
  });
  if (!res.ok) throw new Error(`InnerTube player ${res.status}`);
  const data = await res.json();
  const title = data?.videoDetails?.title || data?.microformat?.playerMicroformatRenderer?.title?.simpleText || extractTitleFromHtml(html) || "Unknown title";
  const durationSeconds = parseInt(data?.videoDetails?.lengthSeconds || 0, 10) || 0;
  const channel = data?.videoDetails?.author || "";

  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) throw new Error("No captionTracks in Android response (captions disabled?)");

  let track =
    tracks.find(t => t.languageCode === "en" && t.kind !== "asr") ||
    tracks.find(t => t.languageCode?.startsWith("en") && t.kind !== "asr") ||
    tracks.find(t => t.languageCode === "en") ||
    tracks.find(t => t.languageCode?.startsWith("en")) ||
    tracks.find(t => t.kind !== "asr") ||
    tracks[0];

  if (!track?.baseUrl) throw new Error("No baseUrl in track");

  const xml = await fetch(track.baseUrl).then(r => {
    if (!r.ok) throw new Error(`timedtext ${r.status}`);
    return r.text();
  });
  if (!xml || xml.length < 50) throw new Error("Empty timedtext response (Android)");

  const parsed = parseCaptionXmlWithSegments(xml);
  if (!parsed.text || parsed.text.length < 20) throw new Error("Parsed transcript empty (Android)");

  return { transcript: parsed.text, segments: parsed.segments, title, durationSeconds, channel };
}

function extractTitleFromHtml(html) {
  try {
    const m = html.match(/<title>([^<]+)<\/title>/);
    if (m) return m[1].replace(" - YouTube", "").trim();
  } catch {}
  return null;
}

async function fetchViaContentPot(tabId, videoId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("POT capture timeout")), 8000);
    chrome.tabs.sendMessage(tabId, { type: "CAPTURE_POT_AND_FETCH", videoId }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response) return reject(new Error("No response from content"));
      if (response.error) return reject(new Error(response.error));
      if (response.transcript) {
        // response may include title/duration if content fetched them
        return resolve({
          transcript: response.transcript,
          segments: response.segments || [],
          title: response.title || "Unknown title",
          durationSeconds: response.durationSeconds || 0,
          channel: response.channel || ""
        });
      }
      reject(new Error("No transcript from POT method"));
    });
  });
}

async function fetchViaWebScrape(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const html = await fetch(watchUrl, { credentials: "omit", headers: { "User-Agent": "Mozilla/5.0" } }).then(r => {
    if (!r.ok) throw new Error(`watch ${r.status}`);
    return r.text();
  });
  const title = extractTitleFromHtml(html) || "Unknown title";
  // Try to extract lengthSeconds from html
  let durationSeconds = 0;
  try {
    const m = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
    if (m) durationSeconds = parseInt(m[1], 10);
    else {
      const m2 = html.match(/"approxDurationMs"\s*:\s*"(\d+)"/);
      if (m2) durationSeconds = Math.floor(parseInt(m2[1],10)/1000);
    }
  } catch {}
  const channel = (() => {
    try {
      const m = html.match(/"ownerChannelName"\s*:\s*\{"simpleText"\s*:\s*"([^"]+)"/);
      return m ? m[1] : "";
    } catch { return ""; }
  })();

  const captionTracks = extractCaptionTracks(html);
  if (!captionTracks || captionTracks.length === 0) throw new Error("No captions found via web scrape");

  let track =
    captionTracks.find(t => t.languageCode === "en" && t.kind !== "asr") ||
    captionTracks.find(t => t.languageCode === "en") ||
    captionTracks.find(t => t.languageCode?.startsWith("en")) ||
    captionTracks[0];
  let baseUrl = track.baseUrl.replace(/\\u0026/g, "&");
  baseUrl = new URL(baseUrl);
  baseUrl.searchParams.set("fmt", "json3");
  const jsonText = await fetch(baseUrl.toString()).then(r => r.text());
  const jsonParsed = parseJson3WithSegments(jsonText);
  if (jsonParsed.text && jsonParsed.text.length > 30) return { transcript: jsonParsed.text, segments: jsonParsed.segments, title, durationSeconds, channel };
  baseUrl.searchParams.set("fmt", "srv3");
  const xml = await fetch(baseUrl.toString()).then(r => r.text());
  const xmlParsed = parseCaptionXmlWithSegments(xml);
  if (xmlParsed.text && xmlParsed.text.length > 30) return { transcript: xmlParsed.text, segments: xmlParsed.segments, title, durationSeconds, channel };
  throw new Error("Web scrape returned empty (POT required)");
}

function extractCaptionTracks(html) {
  try {
    const m = html.match(/"captionTracks"\s*:\s*(\[.*?\])/s);
    if (m && m[1]) return JSON.parse(m[1]);
  } catch (e) { console.warn("captionTracks parse fail", e); }
  try {
    const baseUrls = [];
    const re = /"baseUrl"\s*:\s*"(https:\/\/www\.youtube\.com\/api\/timedtext[^"]+)"/g;
    let match;
    while ((match = re.exec(html)) !== null) {
      let url = match[1].replace(/\\u0026/g, "&");
      if (url.includes("timedtext")) baseUrls.push({ baseUrl: url, languageCode: guessLang(url) });
    }
    if (baseUrls.length) return baseUrls;
  } catch {}
  return null;
}

function guessLang(url) {
  try { return new URL(url).searchParams.get("lang") || "en"; } catch { return "en"; }
}

function parseCaptionXml(xml) {
  if (!xml || typeof xml !== "string") return "";
  const isFormat3 = xml.includes("<p ");
  const marker = isFormat3 ? "<p " : "<text ";
  const endMarker = isFormat3 ? "</p>" : "</text>";
  const texts = [];
  let pos = 0;
  while (true) {
    const tagStart = xml.indexOf(marker, pos);
    if (tagStart === -1) break;
    let contentStart = xml.indexOf(">", tagStart);
    if (contentStart === -1) break;
    contentStart += 1;
    const tagEnd = xml.indexOf(endMarker, contentStart);
    if (tagEnd === -1) break;
    let content = xml.slice(contentStart, tagEnd);
    content = content.replace(/<[^>]+>/g, "");
    content = decodeHtmlEntities(content);
    content = content.replace(/\n/g, " ").trim().replace(/\s+/g, " ");
    if (content) texts.push(content);
    pos = tagEnd + endMarker.length;
  }
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

function parseJson3(json3Text) {
  try {
    const data = JSON.parse(json3Text);
    if (!data.events) return null;
    const parts = [];
    for (const ev of data.events) {
      if (!ev.segs) continue;
      for (const seg of ev.segs) if (seg.utf8) parts.push(seg.utf8);
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  } catch { return null; }
}

function parseCaptionXmlWithSegments(xml) {
  if (!xml || typeof xml !== "string") return { text: "", segments: [] };
  const isFormat3 = xml.includes("<p ");
  const marker = isFormat3 ? "<p " : "<text ";
  const endMarker = isFormat3 ? "</p>" : "</text>";
  const segments = [];
  let pos = 0;
  while (true) {
    const tagStart = xml.indexOf(marker, pos);
    if (tagStart === -1) break;
    const tagSnippet = xml.slice(tagStart, xml.indexOf(">", tagStart)+1);
    let startSec = 0;
    try {
      const m1 = tagSnippet.match(/t="([^"]+)"/);
      const m2 = tagSnippet.match(/start="([^"]+)"/);
      const m3 = tagSnippet.match(/tStartMs="([^"]+)"/);
      if (m1) startSec = parseInt(m1[1],10)/1000;
      else if (m2) startSec = parseFloat(m2[1]);
      else if (m3) startSec = parseInt(m3[1],10)/1000;
    } catch {}
    let contentStart = xml.indexOf(">", tagStart);
    if (contentStart === -1) break;
    contentStart += 1;
    const tagEnd = xml.indexOf(endMarker, contentStart);
    if (tagEnd === -1) break;
    let content = xml.slice(contentStart, tagEnd);
    content = content.replace(/<[^>]+>/g, "");
    content = decodeHtmlEntities(content);
    content = content.replace(/\n/g, " ").trim().replace(/\s+/g, " ");
    if (content) segments.push({ text: content, start: startSec });
    pos = tagEnd + endMarker.length;
  }
  const text = segments.map(s=>s.text).join(" ").replace(/\s+/g, " ").trim();
  return { text, segments };
}

function parseJson3WithSegments(json3Text) {
  try {
    const data = JSON.parse(json3Text);
    if (!data.events) return { text: "", segments: [] };
    const segments = [];
    for (const ev of data.events) {
      if (!ev.segs) continue;
      const t = ev.tStartMs != null ? ev.tStartMs/1000 : 0;
      const txt = ev.segs.map(s=>s.utf8||"").join("").replace(/\s+/g, " ").trim();
      if (txt) segments.push({ text: txt, start: t });
    }
    const text = segments.map(s=>s.text).join(" ").replace(/\s+/g, " ").trim();
    return { text, segments };
  } catch { return { text: "", segments: [] }; }
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function chunkTranscript(text, maxChunkChars = 60000) {
  if (!text || text.length <= maxChunkChars) return [text];
  const chunks = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + maxChunkChars, text.length);
    if (end < text.length) {
      // try to find sentence boundary in last 3000 chars
      const windowStart = Math.max(pos + 8000, end - 3000);
      const slice = text.slice(windowStart, end);
      // prefer paragraph break, then sentence end
      let lastBreak = slice.lastIndexOf("\n\n");
      if (lastBreak === -1) lastBreak = slice.lastIndexOf(". ");
      if (lastBreak === -1) lastBreak = slice.lastIndexOf("! ");
      if (lastBreak === -1) lastBreak = slice.lastIndexOf("? ");
      if (lastBreak === -1) lastBreak = slice.lastIndexOf("\n");
      if (lastBreak !== -1) {
        end = windowStart + lastBreak + 1;
        // include the delimiter char
        if (text[end - 1] === " ") end = windowStart + lastBreak + 2;
      }
      // avoid tiny trailing chunk: if remaining < 5000, consume rest
      if (text.length - end < 5000) end = text.length;
    }
    const chunk = text.slice(pos, end).trim();
    if (chunk.length > 20) chunks.push(chunk);
    pos = end;
    // avoid infinite loop
    if (pos === 0 || chunks.length > 30) break;
  }
  return chunks.length ? chunks : [text];
}

function paginateMarkdown(md, charsPerPage = 6000) {
  if (!md || md.length <= charsPerPage) return [md];
  const pages = [];
  let start = 0;
  while (start < md.length) {
    let end = Math.min(start + charsPerPage, md.length);
    if (end < md.length) {
      const windowStart = Math.max(start + 1000, end - 1200);
      const slice = md.slice(windowStart, end);
      let cut = -1;
      // prefer split at heading
      const headingIdx = slice.lastIndexOf("\n## ");
      const h3Idx = slice.lastIndexOf("\n### ");
      const doubleNl = slice.lastIndexOf("\n\n");
      const singleNl = slice.lastIndexOf("\n");
      if (headingIdx !== -1) cut = headingIdx;
      else if (h3Idx !== -1) cut = h3Idx;
      else if (doubleNl !== -1) cut = doubleNl;
      else if (singleNl !== -1) cut = singleNl;
      if (cut !== -1 && windowStart + cut > start + 800) {
        end = windowStart + cut + 1;
      } else {
        // avoid cutting inside code block - ensure we close fence? try to find ``` boundary
        const before = md.slice(start, end);
        const fenceCount = (before.match(/```/g) || []).length;
        if (fenceCount % 2 === 1) {
          // inside code block, extend to closing fence if near
          const nextFence = md.indexOf("```", end);
          if (nextFence !== -1 && nextFence - end < 800) end = nextFence + 3;
        }
      }
    }
    const page = md.slice(start, end).trim();
    if (page) pages.push(page);
    start = end;
    // trim leading newlines for next page
    while (start < md.length && md[start] === "\n") start++;
    if (pages.length > 20) break; // safety
  }
  return pages.length ? pages : [md];
}

async function getProviderConfig() {
  const { provider, localEndpoint, localModel } = await chrome.storage.sync.get(["provider", "localEndpoint", "localModel"]);
  if (provider === "local") {
    const endpoint = (localEndpoint || "http://localhost:11434/v1").trim().replace(/\/+$/, "");
    return { provider: "local", baseUrl: endpoint, model: (localModel || "qwen2.5:14b").trim(), apiKey: "" };
  }
  return { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: null };
}

async function chatCompletion(cfg) {
  // Local Ollama: use native /api/chat with think:false for 4-5x speedup (qwen3.5 thinking otherwise eats 200+ tokens before content)
  if (cfg.provider === "local") {
    const nativeBase = cfg.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "") || "http://localhost:11434";
    // adaptive num_ctx based on prompt size: chars/4 ≈ tokens, + prompt overhead + maxTokens
    const estPromptTokens = cfg.messages ? cfg.messages.reduce((s, m) => s + Math.ceil((m.content||"").length/4), 0) : 800;
    const needTokens = estPromptTokens + (cfg.maxTokens || 1000) + 500;
    let numCtx = 8192;
    if (needTokens > 7000) numCtx = 16384;
    if (needTokens > 14000) numCtx = 32768;
    // clamp to model max 262k but keep small for speed; qwen3.5:2b-32k default 32768 is slow for short videos
    const body = {
      model: cfg.model,
      messages: cfg.messages,
      stream: !!cfg.stream,
      think: false,
      options: {
        temperature: cfg.temperature !== undefined ? cfg.temperature : 0.5,
        num_predict: cfg.maxTokens || 1000,
        num_ctx: numCtx
      }
    };
    const res = await fetch(`${nativeBase}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text();
      let msg = `API error ${res.status}`;
      try { const j = JSON.parse(errText); if (j.error) msg += `: ${j.error}`; else msg += `: ${errText.slice(0, 300)}`; } catch { msg += `: ${errText.slice(0, 300)}`; }
      if (res.status === 403) msg += " — Ollama blocked extension (CORS). Fix: quit Ollama, then run: OLLAMA_ORIGINS=\"*\" ollama serve";
      if (res.status === 404) msg += " — Model not found. Run: ollama pull " + cfg.model;
      throw new Error(msg);
    }
    if (cfg.stream) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop(); // keep partial
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const j = JSON.parse(trimmed);
            if (j.message?.content) full += j.message.content;
            if (j.done && j.message?.content) { /* already added */ }
          } catch {}
        }
      }
      // flush last line if not newline terminated
      if (buf.trim()) {
        try { const j = JSON.parse(buf.trim()); if (j.message?.content) full += j.message.content; } catch {}
      }
      const content = full.trim();
      if (!content) throw new Error("Empty response from AI (local think:false)");
      return content;
    }
    const data = await res.json();
    const content = data.message?.content;
    if (!content) throw new Error("Empty response from AI");
    return content.trim();
  }

  // DeepSeek / cloud OpenAI-compatible path
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  const body = {
    model: cfg.model,
    messages: cfg.messages,
    max_tokens: cfg.maxTokens || 4000,
    stream: !!cfg.stream
  };
  if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    let msg = `API error ${res.status}`;
    try { const j = JSON.parse(errText); if (j.error?.message) msg += `: ${j.error.message}`; else msg += `: ${errText.slice(0, 300)}`; } catch { msg += `: ${errText.slice(0, 300)}`; }
    if (res.status === 401 && cfg.apiKey) msg += " — Check API key in extension options.";
    if (res.status === 403) msg += " — Ollama blocked extension (CORS). Fix: quit Ollama, then run: OLLAMA_ORIGINS=\"*\" ollama serve  — or: launchctl setenv OLLAMA_ORIGINS \"*\" && open -a Ollama (then restart Ollama). See options page hint.";
    if (res.status === 404) msg += " — Model not found. Pull it with: ollama pull <model>, or check model name.";
    throw new Error(msg);
  }
  if (cfg.stream) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let buf = "";
    let rawAll = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      rawAll += text;
      buf += text;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) full += delta;
        } catch {}
      }
    }
    if (!full.trim()) {
      // server ignored stream flag and returned plain JSON — parse it
      try {
        const j = JSON.parse(rawAll);
        const c = j.choices?.[0]?.message?.content;
        if (c) full = c;
      } catch {}
    }
    const content = full.trim();
    if (!content) throw new Error("Empty response from AI");
    return content;
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from AI");
  return content.trim();
}

async function summarizeChunk(transcriptChunk, apiKey, videoId, meta, chunkInfo, opts, cfg) {
  const title = meta?.title || "Unknown";
  const duration = formatDuration(meta?.duration || meta?.durationSeconds);
  const channel = meta?.channel ? `Channel: ${meta.channel}` : "";
  const style = meta?.style || "auto";

  let styleInstruction = "";
  if (style === "bullets") {
    styleInstruction = `Format: Concise bullet points (5-10 bullets) with markdown '- '. Direct content only.`;
  } else if (style === "steps") {
    styleInstruction = `Format: Numbered steps (1., 2., 3.) with direct instructions. Direct content only.`;
  } else if (style === "sections") {
    styleInstruction = `Format: Sections with ## headers, bullets, tables if useful. Direct content only.`;
  } else {
    styleInstruction = `You decide BEST format from TITLE + DURATION:

- Short (<5m) simple → 3-5 bullets
- How-to / tutorial → numbered steps, optionally tiny ASCII flowchart ( \`\`\` , max 10 lines, 40 chars, e.g. A --> B --> C )
- List/jokes/memes → preserve the actual list/jokes themselves (e.g. "1. Joke: ..." ), don't describe that jokes exist
- News/review/comparison → pros/cons or sections with headers
- Story/vlog/interview → timeline or narrative points (the story itself)
- Technical deep dive → sections + bullets + optional ASCII diagram only if it clarifies

Auto rules:
- Use markdown: headers (##), bullets (-), numbered (1.), bold (**), code blocks (\`\`\`) for ASCII, blockquotes.
- Keep ASCII tiny (≤10 lines, ≤40 chars) in \`\`\`.
- Depth matches DURATION (longer = more detail, shorter = essentials only).
- For multi-part analysis, keep this part self-contained but don't repeat earlier parts.`;
  }

  const directContentRules = `
CRITICAL — DIRECT CONTENT ONLY:
- NEVER write meta phrases: "This video is about...", "In this video you will...", "The video discusses...", "The creator explains...", "You will find..."
- DO NOT describe the video. DELIVER the video's actual substance as if you are retelling it.
- Bad: "This video is about 3 jokes. The first joke is about a dog."
  Good: "**Three jokes:**\\n- A dog walks into a bar... punchline: ..." 
- Bad: "The video explains how to make pasta."
  Good: "**Pasta:** 1. Boil water with salt... 2. Add pasta 8 min..."
- Focus on topic/subject/content itself, not the container.
- For jokes/memes/skits: list the jokes/punchlines/story beats verbatim (condensed).
- For tutorials: list the actual steps, tips, mistakes.
- Start with a 1-line **essence** (bold) that IS the core takeaway, not "This video covers...".
 `;

  const isChunked = chunkInfo && chunkInfo.total > 1;
  const chunkHeader = isChunked ? `TRANSCRIPT PART ${chunkInfo.index}/${chunkInfo.total} (covering segment ${chunkInfo.index} of full video — summarize ONLY this segment, preserve order, don't invent):` : "TRANSCRIPT:";
  const chunkNote = isChunked ? `- This is part ${chunkInfo.index} of ${chunkInfo.total}. Summarize ONLY this segment's content in order. Keep headers scoped to this part (e.g. ## Part ${chunkInfo.index}: ...). Be comprehensive — analysis can be long.\n` : "";

  const prompt = `Summarize the ACTUAL CONTENT of this YouTube video (not what it's about).

TITLE: "${title}"
${channel}
DURATION: ${duration}
VIDEO_ID: ${videoId}
${isChunked ? `SEGMENT: Part ${chunkInfo.index}/${chunkInfo.total}` : ""}

${styleInstruction}
${directContentRules}
${chunkNote}- If transcript is messy (auto-captions), infer meaning but don't hallucinate; keep original phrasing where possible.
- Output markdown only, no preamble like "Here is the summary:".
- Language: match transcript language.
- Be thorough and detailed. If content is rich, produce comprehensive analysis — length is welcome, will be paginated.

${chunkHeader}
"""${transcriptChunk}"""`;

  // local: much smaller maxTokens (2b model @23 tok/s, 4000 tok = 170s). Scale by transcript size + duration.
  let defaultMax = 4000;
  if (cfg.provider === "local") {
    // 4-min video with ~4k chars needs ~600 tok, 10m ~1000, >30m chunked 800 per chunk
    const estTokens = Math.ceil(transcriptChunk.length / 4);
    if (estTokens < 1500) defaultMax = 800; // short video: 3-5 bullets
    else if (estTokens < 4000) defaultMax = 1200;
    else defaultMax = 1000; // chunked mode per-part budget
    // fast mode already passes smaller opts; respect it but cap local
    if (opts && opts.maxTokens) defaultMax = Math.min(opts.maxTokens, defaultMax);
  }
  const maxTokens = (opts && opts.maxTokens && cfg.provider !== "local") ? opts.maxTokens : defaultMax;
  const content = await chatCompletion({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    provider: cfg.provider,
    apiKey: cfg.apiKey || apiKey,
    messages: [
      { role: "system", content: "You are a direct-content summarizer. You NEVER describe videos meta-style. You deliver the video's actual ideas, facts, jokes, steps, stories as the content itself. No 'This video is about' phrasing. Concise, substantive, and format-adaptive (bullets/steps/ASCII) based on title+duration. For segmented transcripts, you summarize the given segment comprehensively and self-contained." },
      { role: "user", content: prompt }
    ],
    temperature: 0.5,
    maxTokens,
    stream: cfg.provider === "local"
  });
  let md = content.trim();
  // For chunked mode, ensure part header exists for clarity
  if (isChunked && !md.match(/^#+\s*Part\s+0*1|Part\s+0*1/i) && chunkInfo.index === 1) {
    // don't force header, let AI decide but we will add pagination UI anyway
  }
  return md;
}

async function summarizeWithDeepSeek(transcript, apiKey, videoId, meta, onProgress, onPartial, fastOpts, cfg) {
  const CHUNK_SIZE = cfg && cfg.provider === "local" ? 30000 : 60000; // local models: smaller chunks fit 32k context
  const paginate = (md) => paginateMarkdown(md, 6000);
  const chunkOpts = fastOpts || null;
  // single request path: whole transcript fits
  if (!transcript || transcript.length <= CHUNK_SIZE) {
    if (onProgress) try { onProgress({ text: "Analyzing full transcript (single pass)…", sub: `${Math.round(transcript.length/1000)}k chars • one AI call` }); } catch {}
    const md = await summarizeChunk(transcript, apiKey, videoId, meta, null, chunkOpts, cfg);
    const pages = paginate(md);
    return { fullMarkdown: md, pages };
  }
  // chunked path: split transcript and summarize parts in PARALLEL with progressive streaming
  const chunks = chunkTranscript(transcript, CHUNK_SIZE);
  console.log(`[yt-sum] transcript ${transcript.length} chars split into ${chunks.length} chunks (parallel)`);
  if (onProgress) try { onProgress({ text: `Split into ${chunks.length} parts • summarizing in parallel…`, sub: chunks.map(c=>Math.round(c.length/1000)+'k').join(' + ') + ' chars' }); } catch {}
  let completed = 0;
  const total = chunks.length;
  const results = new Array(total).fill(null); // slots for ordered results
  // helper to emit partial update whenever a contiguous prefix is ready
  const emitPartial = () => {
    if (!onPartial) return;
    // find longest contiguous prefix from 0 where results[i] !== null
    let prefixLen = 0;
    for (let i=0;i<total;i++) { if (results[i]) prefixLen++; else break; }
    if (prefixLen === 0) return;
    // also allow showing whatever pages we have in order, even if gap middle? prefer prefix only for coherence
    const pagesSoFar = [];
    let fullSoFar = "";
    for (let i=0;i<prefixLen;i++) {
      if (results[i]) pagesSoFar.push(...results[i].subPages);
    }
    fullSoFar = pagesSoFar.join("\n\n---\n\n");
    // Only stream if we have at least 1 chunk and not yet complete (avoid duplicate final)
    if (prefixLen < total) {
      try { onPartial({ pagesSoFar, fullSoFar, loaded: prefixLen, total }); } catch {}
    }
  };

  // fire all chunk requests in parallel — wall time = slowest chunk, not sum
  // DeepSeek tolerates 2-4 concurrent requests; we cap by chunk count (2-3 for 2h)
  const promises = chunks.map((chunk, i) => {
    const chunkInfo = { index: i + 1, total };
    return summarizeChunk(chunk, apiKey, videoId, meta, chunkInfo, chunkOpts, cfg).then(md => {
      completed++;
      if (onProgress) try {
        onProgress({ text: `Summarized ${completed}/${total} parts…`, sub: `Part ${chunkInfo.index}/${total} done • ${Math.round(md.length/1000)}k analysis` });
      } catch {}
      const subPages = paginate(md);
      results[i] = { idx: i, md, subPages };
      emitPartial(); // stream first page as soon as chunk 0 done, instead of waiting for all
      return { idx: i, md, subPages };
    }).catch(e => {
      console.warn(`chunk ${i+1} failed`, e);
      throw new Error(`Failed on segment ${i+1}/${total}: ${e.message}`);
    });
  });
  // await all in parallel
  const finalResults = await Promise.all(promises);
  // restore order (already in results array)
  finalResults.sort((a, b) => a.idx - b.idx);
  const allPages = [];
  for (const r of finalResults) allPages.push(...r.subPages);
  const fullMarkdown = allPages.join("\n\n---\n\n");
  if (onProgress) try { onProgress({ text: `Assembled ${allPages.length} pages`, sub: `${Math.round(fullMarkdown.length/1000)}k total analysis` }); } catch {}
  return { fullMarkdown, pages: allPages };
}

async function askWithDeepSeek(transcript, question, apiKey, videoId, meta, cfg) {
  const maxChars = 50000;
  let truncated = transcript;
  if (transcript.length > maxChars) truncated = transcript.slice(0, maxChars) + "\n\n[Transcript truncated for context...]";
  const title = meta?.title || "Unknown";
  const channel = meta?.channel ? `Channel: ${meta.channel}` : "";
  const prompt = `You are a helpful assistant answering questions about a YouTube video.\n\nTITLE: "${title}"\n${channel}\nVIDEO_ID: ${videoId}\n\nTRANSCRIPT:\n"""${truncated}"""\n\nQUESTION: ${question}\n\nAnswer directly and concisely using the transcript. If answer not in transcript, say so. Use markdown, cite timestamps if relevant like [01:23] when possible.`;
  const ans = await chatCompletion({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    provider: cfg.provider,
    apiKey: cfg.apiKey || apiKey,
    messages: [
      { role: "system", content: "You are a helpful video assistant. Answer questions directly from the transcript, concise, markdown." },
      { role: "user", content: prompt }
    ],
    temperature: 0.4,
    maxTokens: cfg.provider === "local" ? 600 : 1200,
    stream: cfg.provider === "local"
  });
  return ans.trim();
}

function sendToTab(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg, () => {
    if (chrome.runtime.lastError) console.warn("sendMessage failed:", chrome.runtime.lastError.message);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "OPEN_OPTIONS") chrome.runtime.openOptionsPage();
  if (msg.type === "POPUP_SUMMARIZE") {
    (async () => {
      const tabId = msg.tabId;
      const url = msg.url;
      const vid = extractVideoId(url);
      if (vid) await handleSummarize(tabId, vid, url);
      else sendToTab(tabId, { type: "SHOW_ERROR", error: "No video ID found in current tab." });
    })();
    return true;
  }
  if (msg.type === "SUMMARIZE_LINK" && msg.videoId) {
    (async () => {
      const tabId = sender.tab?.id;
      if (tabId) await handleSummarize(tabId, msg.videoId, msg.url);
    })();
    return true;
  }
  if (msg.type === "ASK_VIDEO") {
    (async () => {
      try {
        const { deepseekApiKey } = await chrome.storage.sync.get(["deepseekApiKey"]);
        const cfg = await getProviderConfig();
        if (cfg.provider === "deepseek" && !deepseekApiKey) throw new Error("DeepSeek API key missing");
        let transcript = msg.transcript || "";
        let fetchError = null;
        // try cache if not provided
        if (!transcript || transcript.length < 20) {
          try {
            const all = await chrome.storage.local.get(null);
            const keys = Object.keys(all).filter(k=>k.includes(msg.videoId));
            for (const k of keys) {
              const v = all[k];
              if (v?.transcript && v.transcript.length > 20) { transcript = v.transcript; break; }
              if (v?.meta?.transcript && v.meta.transcript.length > 20) { transcript = v.meta.transcript; break; }
              // also check stored transcript in meta.segments? fallback to fetching
            }
            if (!transcript || transcript.length < 20) {
              const tabId = sender.tab?.id;
              if (tabId) {
                const data = await fetchTranscriptWithFallback(tabId, msg.videoId);
                transcript = data.transcript;
              }
            }
          } catch (e) {
            fetchError = e;
          }
        }
        if (!transcript || transcript.length < 20) {
          const reason = fetchError ? fetchError.message || String(fetchError) : "No transcript found in cache or from YouTube";
          throw new Error("Transcript unavailable for asking: " + reason);
        }
        const answer = await askWithDeepSeek(transcript, msg.question, deepseekApiKey, msg.videoId, { title: msg.title, channel: msg.channel }, cfg);
        sendResponse({ answer });
      } catch (e) {
        sendResponse({ error: e.message || String(e) });
      }
    })();
    return true;
  }
});
