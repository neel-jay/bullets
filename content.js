(() => {
  if (window.__ytSummarizerInjected) return;
  window.__ytSummarizerInjected = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "SHOW_LOADING") showLoading(msg.text, msg.sub);
    if (msg.type === "SHOW_SUMMARY") {
      // New: support paginated pages from background; fallback to single summary string
      const pages = Array.isArray(msg.pages) && msg.pages.length ? msg.pages : null;
      const summary = msg.summary || "";
      const isPartial = !!msg.isPartial;
      const progress = msg.progress || null;
      // lastMarkdown always full (for Obsidian + copy-all) - for partial, keep appending but store latest partial as lastMarkdown for now; final will overwrite
      if (isPartial) {
        // progressive render: keep meta but append pages as they stream
        lastMarkdown = summary; // partial full so far
        lastPages = pages && pages.length ? pages : (summary ? paginateMarkdownClient(summary, 6000) : []);
        lastMeta = msg.meta || lastMeta || null;
        lastVideoId = msg.videoId || lastVideoId || null;
        // don't reset page if user already navigated; but for first partial keep at 0
        if (lastCurrentPage >= lastPages.length) lastCurrentPage = 0;
        showSummary(summary, msg.meta, lastPages, isPartial, progress);
      } else {
        lastMarkdown = pages ? pages.join("\n\n---\n\n") : summary;
        // lastPages is paginated view (array)
        if (pages) {
          lastPages = pages;
        } else if (summary && summary.length > 6000) {
          lastPages = paginateMarkdownClient(summary, 6000);
          // keep full markdown for save
          lastMarkdown = summary;
        } else {
          lastPages = summary ? [summary] : [];
        }
        lastMeta = msg.meta || null;
        lastVideoId = msg.videoId || null;
        lastCurrentPage = 0;
        // clear streaming banner if any
        const ov = document.getElementById("yt-summarizer-overlay");
        const streamEl = ov ? ov.querySelector("#yt-sum-streaming") : null;
        if (streamEl) streamEl.style.display = "none";
        showSummary(summary, msg.meta, lastPages, false, progress);
        // if this was cached, show subtle badge
        if (msg.cached) {
          setTimeout(() => {
            const ov2 = document.getElementById("yt-summarizer-overlay");
            const c = ov2 ? ov2.querySelector("#yt-summarizer-content") : null;
            if (c) {
              const badge = document.createElement("div");
              badge.textContent = "⚡ Loaded from cache — instant";
              badge.style.cssText = "margin-bottom:8px; font-size:11px; color:#137333; background:#e6f4ea; border:1px solid #b6e1c3; padding:6px 10px; border-radius:8px; display:inline-block;";
              c.prepend(badge);
              setTimeout(()=> badge.remove(), 3000);
            }
          }, 100);
        }
      }
    }
    if (msg.type === "SHOW_ERROR") showError(msg.error);
    if (msg.type === "CAPTURE_POT_AND_FETCH") {
      handlePotFetch(msg.videoId).then(result => {
        // result may be string or object with transcript
        if (typeof result === "string") sendResponse({ transcript: result });
        else sendResponse(result);
      }).catch(err => {
        sendResponse({ error: err.message || String(err) });
      });
      return true; // async
    }
  });

  // ---------- POT + Android transcript fetching in content world ----------

  async function handlePotFetch(videoId) {
    // 1. Try ANDROID InnerTube from content world (same-origin, no POT) - also returns metadata
    try {
      const r = await fetchViaAndroidContent(videoId);
      if (r && r.transcript && r.transcript.length > 30) return r;
      if (typeof r === "string" && r.length > 30) return { transcript: r, title: document.title.replace(" - YouTube","").trim(), durationSeconds: 0 };
    } catch (e) {
      console.warn("[yt-sum] android content fail", e);
    }
    // 2. Try POT capture + WEB timedtext
    try {
      const t2 = await fetchViaPotCapture(videoId);
      const txt2 = typeof t2 === "string" ? t2 : t2?.transcript || t2?.text || "";
      const segs2 = typeof t2 === "object" ? t2.segments || [] : [];
      if (txt2 && txt2.length > 30) {
        const title = document.title.replace(" - YouTube","").trim() || "Unknown";
        return { transcript: txt2, segments: segs2, title, durationSeconds: 0, channel: "" };
      }
    } catch (e) {
      console.warn("[yt-sum] pot capture fail", e);
    }
    // 3. Try DOM panel scrape
    try {
      const t3 = await scrapeViaPanel();
      const txt3 = typeof t3 === "string" ? t3 : t3?.transcript || t3?.text || "";
      const segs3 = typeof t3 === "object" ? t3.segments || [] : [];
      if (txt3 && txt3.length > 30) {
        const title = document.title.replace(" - YouTube","").trim() || "Unknown";
        return { transcript: txt3, segments: segs3, title, durationSeconds: 0, channel: "" };
      }
    } catch (e) {
      console.warn("[yt-sum] panel scrape fail", e);
    }
    throw new Error("Content transcript fetch failed (no captions or YouTube blocked)");
  }

  async function fetchViaAndroidContent(videoId) {
    const apiKey = await getApiKey();
    const res = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
        videoId
      })
    });
    if (!res.ok) throw new Error(`player ${res.status}`);
    const data = await res.json();
    const title = data?.videoDetails?.title || document.title.replace(" - YouTube","").trim() || "Unknown";
    const durationSeconds = parseInt(data?.videoDetails?.lengthSeconds || 0, 10) || 0;
    const channel = data?.videoDetails?.author || "";
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || !tracks.length) throw new Error("no captionTracks");
    let track =
      tracks.find(t => t.languageCode === "en" && t.kind !== "asr") ||
      tracks.find(t => t.languageCode?.startsWith("en") && t.kind !== "asr") ||
      tracks.find(t => t.languageCode === "en") ||
      tracks.find(t => t.languageCode?.startsWith("en")) ||
      tracks.find(t => t.kind !== "asr") ||
      tracks[0];
    if (!track?.baseUrl) throw new Error("no baseUrl");
    const xml = await fetch(track.baseUrl, { credentials: "same-origin" }).then(r => r.text());
    const parsed = parseCaptionXmlWithSegments(xml);
    if (!parsed.text) throw new Error("parse empty");
    return { transcript: parsed.text, segments: parsed.segments, title, durationSeconds, channel };
  }

  async function getApiKey() {
    // Try to extract from page html via meta or yt cfg
    try {
      const html = document.documentElement.innerHTML;
      const m = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
      if (m && m[1]) return JSON.parse(`"${m[1]}"`);
    } catch {}
    // Fallback to fetch current page
    try {
      const text = await fetch(location.href, { credentials: "same-origin" }).then(r => r.text());
      const m = text.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
      if (m && m[1]) return JSON.parse(`"${m[1]}"`);
    } catch {}
    return "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  }

  async function fetchViaPotCapture(videoId) {
    // Get baseUrl from page HTML
    const html = await fetch(location.href, { credentials: "same-origin" }).then(r => r.text());
    const tracks = extractTracksFromHtml(html);
    if (!tracks || !tracks.length) throw new Error("no tracks for pot");
    let track =
      tracks.find(t => t.languageCode === "en" && t.kind !== "asr") ||
      tracks.find(t => t.languageCode === "en") ||
      tracks[0];
    let baseUrl = track.baseUrl.replace(/\\u0026/g, "&");
    const pot = await capturePotToken();
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "json3");
    if (pot) {
      url.searchParams.set("pot", pot);
      url.searchParams.set("c", "WEB");
    }
    const res = await fetch(url.toString(), { credentials: "same-origin" });
    if (!res.ok) throw new Error(`timedtext pot ${res.status}`);
    const jsonText = await res.text();
    const jsonParsed = parseJson3WithSegments(jsonText);
    if (jsonParsed.text && jsonParsed.text.length > 30) return { transcript: jsonParsed.text, segments: jsonParsed.segments };
    const xmlParsed = parseCaptionXmlWithSegments(jsonText);
    if (xmlParsed.text && xmlParsed.text.length > 30) return { transcript: xmlParsed.text, segments: xmlParsed.segments };
    throw new Error("pot fetch returned empty");
  }

  function extractTracksFromHtml(html) {
    try {
      const m = html.match(/"captionTracks"\s*:\s*(\[.*?\])/s);
      if (m && m[1]) return JSON.parse(m[1]);
    } catch {}
    try {
      const re = /"baseUrl"\s*:\s*"(https:\/\/www\.youtube\.com\/api\/timedtext[^"]+)"/g;
      const arr = [];
      let match;
      while ((match = re.exec(html)) !== null) {
        let u = match[1].replace(/\\u0026/g, "&");
        if (u.includes("timedtext")) arr.push({ baseUrl: u, languageCode: guessLang(u) });
      }
      if (arr.length) return arr;
    } catch {}
    return null;
  }

  function guessLang(url) {
    try { return new URL(url).searchParams.get("lang") || "en"; } catch { return "en"; }
  }

  async function capturePotToken() {
    const cacheKey = "yt-pot-cache";
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) return cached;
    } catch {}
    const btn = document.querySelector('#movie_player button.ytp-subtitles-button') ||
                document.querySelector('#movie_player .ytp-subtitles-button');
    if (!btn || !window.performance) {
      console.warn("[yt-sum] no subtitles button for pot");
      return "";
    }
    try {
      performance.clearResourceTimings();
      // Click to toggle captions (force network)
      btn.click();
      await sleep(400);
      btn.click();
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        const entries = performance.getEntriesByType("resource").filter(e => e.name.includes("/api/timedtext"));
        const last = entries.pop();
        if (last) {
          try {
            const u = new URL(last.name);
            const pot = u.searchParams.get("pot");
            if (pot) {
              try { sessionStorage.setItem(cacheKey, pot); } catch {}
              console.log("[yt-sum] captured pot", pot.slice(0,12)+"...");
              return pot;
            }
          } catch {}
        }
      }
    } catch (e) {
      console.warn("[yt-sum] pot capture error", e);
    }
    return "";
  }

  async function scrapeViaPanel() {
    // Try to find and click transcript panel button (language agnostic)
    const findTranscriptButton = () => {
      // Common selectors: yt chip, button with transcript text, description section
      const all = [...document.querySelectorAll('button, [role="button"], yt-chip-cloud-chip-renderer, ytd-button-renderer, tp-yt-paper-button')];
      // Languages: transcript, transkrypcja, transcripción, transcrit
      const re = /transcript|transkry|transcripci|transcrit|untertitel/i;
      for (const el of all) {
        const txt = (el.textContent || el.getAttribute("aria-label") || "").trim();
        if (re.test(txt) && txt.length < 80) return el;
      }
      // Fallback: ytd-video-description-transcript-section-renderer contains button
      const sec = document.querySelector("ytd-video-description-transcript-section-renderer");
      if (sec) {
        const b = sec.querySelector("button, [role='button']");
        if (b) return b;
      }
      return null;
    };
    let btn = findTranscriptButton();
    if (btn) {
      try {
        btn.click();
        console.log("[yt-sum] clicked transcript button", btn.textContent?.trim().slice(0,30));
        await sleep(1200);
      } catch (e) { console.warn(e); }
    } else {
      // Try to open description expand then search again
      const expand = document.querySelector("tp-yt-paper-button#expand, #expand");
      if (expand) {
        try { expand.click(); await sleep(600); btn = findTranscriptButton(); if (btn) { btn.click(); await sleep(1000);} } catch {}
      }
    }
    // Wait for segments — also capture timestamps for jump-to-moment
    for (let attempt = 0; attempt < 24; attempt++) {
      const segments = document.querySelectorAll("ytd-transcript-segment-renderer");
      if (segments.length > 0) {
        const segs = [...segments].map(s => {
          const c = s.querySelector("#content-text") || s.querySelector("yt-formatted-string") || s;
          const txt = (c.textContent || "").trim();
          let start = 0;
          try {
            const tsEl = s.querySelector("#timestamp") || s.querySelector("[id*='timestamp']") || s.querySelector("ytd-transcript-segment-renderer #timestamp");
            let tsText = tsEl ? (tsEl.textContent || "").trim() : "";
            if (!tsText) {
              // fallback: find time like 0:12 or 1:02:03 in segment
              const m = s.textContent.match(/(\d+:)?\d+:\d+/);
              if (m) tsText = m[0];
            }
            if (tsText) {
              const parts = tsText.split(":").map(p=>parseInt(p,10));
              if (parts.length === 3) start = parts[0]*3600 + parts[1]*60 + parts[2];
              else if (parts.length === 2) start = parts[0]*60 + parts[1];
            }
          } catch {}
          return { text: txt, start };
        }).filter(s=>s.text);
        if (segs.length > 2) {
          console.log("[yt-sum] scraped via panel", segs.length, "segments");
          const txt = segs.map(s=>s.text).join(" ").replace(/\s+/g, " ").trim();
          return { transcript: txt, segments: segs };
        }
      }
      await sleep(250);
    }
    return null;
  }

  function parseCaptionXml(xml) {
    if (!xml || typeof xml !== "string") return "";
    const isFormat3 = xml.includes("<p ");
    const marker = isFormat3 ? "<p " : "<text ";
    const endMarker = isFormat3 ? "</p>" : "</text>";
    const out = [];
    let pos = 0;
    while (true) {
      const s = xml.indexOf(marker, pos);
      if (s === -1) break;
      let cs = xml.indexOf(">", s);
      if (cs === -1) break;
      cs += 1;
      const e = xml.indexOf(endMarker, cs);
      if (e === -1) break;
      let content = xml.slice(cs, e);
      content = content.replace(/<[^>]+>/g, "");
      content = content.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
      content = content.replace(/\n/g, " ").trim().replace(/\s+/g, " ");
      if (content) out.push(content);
      pos = e + endMarker.length;
    }
    return out.join(" ").replace(/\s+/g, " ").trim();
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function parseCaptionXmlWithSegments(xml) {
    if (!xml || typeof xml !== "string") return { text: "", segments: [] };
    const isFormat3 = xml.includes("<p ");
    const marker = isFormat3 ? "<p " : "<text ";
    const endMarker = isFormat3 ? "</p>" : "</text>";
    const segments = [];
    let pos = 0;
    while (true) {
      const s = xml.indexOf(marker, pos);
      if (s === -1) break;
      const tagSnippet = xml.slice(s, xml.indexOf(">", s)+1);
      let startSec = 0;
      try {
        const m1 = tagSnippet.match(/t="([^"]+)"/);
        const m2 = tagSnippet.match(/start="([^"]+)"/);
        if (m1) startSec = parseInt(m1[1],10)/1000;
        else if (m2) startSec = parseFloat(m2[1]);
      } catch {}
      let cs = xml.indexOf(">", s);
      if (cs === -1) break;
      cs += 1;
      const e = xml.indexOf(endMarker, cs);
      if (e === -1) break;
      let content = xml.slice(cs, e);
      content = content.replace(/<[^>]+>/g, "");
      content = content.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
      content = content.replace(/\n/g, " ").trim().replace(/\s+/g, " ");
      if (content) segments.push({ text: content, start: startSec });
      pos = e + endMarker.length;
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

  // Store last summary for copy + pagination
  let lastMarkdown = "";
  let lastMeta = null;
  let lastVideoId = null;
  let lastPages = []; // array of markdown pages
  let lastCurrentPage = 0;

  function paginateMarkdownClient(md, charsPerPage = 6000) {
    if (!md || md.length <= charsPerPage) return [md];
    const pages = [];
    let start = 0;
    while (start < md.length) {
      let end = Math.min(start + charsPerPage, md.length);
      if (end < md.length) {
        const windowStart = Math.max(start + 1000, end - 1200);
        const slice = md.slice(windowStart, end);
        let cut = -1;
        const headingIdx = slice.lastIndexOf("\n## ");
        const h3Idx = slice.lastIndexOf("\n### ");
        const doubleNl = slice.lastIndexOf("\n\n");
        const singleNl = slice.lastIndexOf("\n");
        if (headingIdx !== -1) cut = headingIdx;
        else if (h3Idx !== -1) cut = h3Idx;
        else if (doubleNl !== -1) cut = doubleNl;
        else if (singleNl !== -1) cut = singleNl;
        if (cut !== -1 && windowStart + cut > start + 800) end = windowStart + cut + 1;
      }
      const page = md.slice(start, end).trim();
      if (page) pages.push(page);
      start = end;
      while (start < md.length && md[start] === "\n") start++;
      if (pages.length > 20) break;
    }
    return pages.length ? pages : [md];
  }

  function ensureContainer() {
    let overlay = document.getElementById("yt-summarizer-overlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "yt-summarizer-overlay";
    overlay.innerHTML = `
      <div id="yt-summarizer-backdrop"></div>
      <div id="yt-summarizer-modal" role="dialog" aria-modal="true">
        <div id="yt-sum-drag-handle" title="Drag to move" aria-hidden="true"><span></span></div>
        <div id="yt-sum-streaming" style="display:none;"></div>
        <div id="yt-summarizer-body">
          <div id="yt-summarizer-content"></div>
        </div>
        <div id="yt-summarizer-corner-actions">
          <div id="yt-summarizer-pagination" style="display:none">
            <button id="yt-sum-prev" aria-label="Previous page" title="Previous page"><span>‹</span></button>
            <span id="yt-sum-pageinfo">1 / 1</span>
            <button id="yt-sum-next" aria-label="Next page" title="Next page"><span>›</span></button>
          </div>
          <button id="yt-summarizer-copy" class="yt-sum-corner-btn" title="Copy summary">Copy</button>
          <button id="yt-summarizer-obsidian" class="yt-sum-corner-btn" title="Save to Obsidian">Obsidian</button>
          <button id="yt-summarizer-close" class="yt-sum-corner-btn yt-sum-close-corner" aria-label="Close" title="Close">×</button>
        </div>
        <div class="yt-sum-resize-handle se" data-dir="se" title="Drag to resize"></div>
        <div class="yt-sum-resize-handle sw" data-dir="sw"></div>
        <div class="yt-sum-resize-handle ne" data-dir="ne"></div>
        <div class="yt-sum-resize-handle nw" data-dir="nw"></div>
        <div class="yt-sum-resize-handle e" data-dir="e"></div>
        <div class="yt-sum-resize-handle s" data-dir="s"></div>
        <div class="yt-sum-resize-handle w" data-dir="w"></div>
        <div class="yt-sum-resize-handle n" data-dir="n"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector("#yt-summarizer-close").onclick = hide;
    overlay.querySelector("#yt-summarizer-backdrop").onclick = hide;
    overlay.querySelector("#yt-summarizer-copy").onclick = () => {
      const text = lastMarkdown || overlay.querySelector("#yt-summarizer-content").innerText;
      navigator.clipboard.writeText(text).then(() => {
        const btn = overlay.querySelector("#yt-summarizer-copy");
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = orig), 1500);
      });
    };
    overlay.querySelector("#yt-summarizer-obsidian").onclick = handleObsidianClip;
    // pagination controls
    const prevBtn = overlay.querySelector("#yt-sum-prev");
    const nextBtn = overlay.querySelector("#yt-sum-next");
    if (prevBtn) prevBtn.onclick = () => navigatePage(-1);
    if (nextBtn) nextBtn.onclick = () => navigatePage(1);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.classList.contains("visible")) hide();
      const ov = document.getElementById("yt-summarizer-overlay");
      if (!ov || !ov.classList.contains("visible")) return;
      if (lastPages.length > 1) {
        if (e.key === "ArrowLeft") { e.preventDefault(); navigatePage(-1); }
        if (e.key === "ArrowRight") { e.preventDefault(); navigatePage(1); }
      }
    });

    // Single-panel drag: subtle handle + whole modal background (keeps resize intact)
    const modal = overlay.querySelector("#yt-summarizer-modal");
    const dragHandle = overlay.querySelector("#yt-sum-drag-handle");
    if (dragHandle) makeDraggable(modal, dragHandle);
    makeDraggable(modal, modal);
    makeResizable(modal);

    return overlay;
  }

  function makeDraggable(modal, handle) {
    if (!handle) return;
    let isDragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const isWholeModalHandle = handle === modal;

    const onMouseDown = (e) => {
      // Ignore interactive elements
      if (e.target.closest("button, a, input, textarea, select, [contenteditable]")) return;
      if (e.target.closest(".yt-sum-resize-handle")) return;
      if (e.target.closest("#yt-summarizer-corner-actions")) return;
      // For whole-modal drag, be subtle: don't start drag when clicking on text content (allow selection/scroll)
      if (isWholeModalHandle) {
        // Only drag from drag-handle or from modal/body background, not from paragraphs/lists
        const isHandle = e.target.closest("#yt-sum-drag-handle");
        const isModalBg = e.target === modal;
        const isBodyBg = e.target === modal.querySelector("#yt-summarizer-body");
        // If clicking directly on text elements, skip drag to preserve selection
        if (!isHandle && !isModalBg && !isBodyBg) {
          if (e.target.closest("#yt-summarizer-content p, #yt-summarizer-content li, #yt-summarizer-content h2, #yt-summarizer-content h3, #yt-summarizer-content h4, #yt-summarizer-content pre, #yt-summarizer-content blockquote, #yt-summarizer-content code, #yt-summarizer-content span, #yt-summarizer-content strong, #yt-summarizer-content a")) return;
          // Also if clicking on the content container itself but has selection, don't drag
          if (window.getSelection() && window.getSelection().toString().length > 0) return;
        }
      }
      // Ignore right-click
      if (e.button !== 0 && e.button !== undefined) return;
      isDragging = true;
      modal.classList.add("dragging");
      const rect = modal.getBoundingClientRect();
      // Convert right-positioned to left/top
      modal.style.left = rect.left + "px";
      modal.style.top = rect.top + "px";
      modal.style.right = "auto";
      modal.style.bottom = "auto";
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    };
    const onMouseMove = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newLeft = startLeft + dx;
      let newTop = startTop + dy;
      // Keep within viewport bounds
      const maxLeft = window.innerWidth - modal.offsetWidth - 8;
      const maxTop = window.innerHeight - modal.offsetHeight - 8;
      newLeft = Math.max(8, Math.min(newLeft, maxLeft));
      newTop = Math.max(8, Math.min(newTop, maxTop));
      modal.style.left = newLeft + "px";
      modal.style.top = newTop + "px";
    };
    const onMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        modal.classList.remove("dragging");
      }
    };
    handle.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    // Touch support
    handle.addEventListener("touchstart", (e) => {
      const touch = e.touches[0];
      if (!touch) return;
      onMouseDown({ clientX: touch.clientX, clientY: touch.clientY, target: e.target, preventDefault: () => e.preventDefault() });
    }, { passive: false });
    document.addEventListener("touchmove", (e) => {
      const touch = e.touches[0];
      if (!touch) return;
      onMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
    }, { passive: false });
    document.addEventListener("touchend", onMouseUp);
    // Double-click to reset to top-right (only on handle / modal bg, not content)
    handle.addEventListener("dblclick", (e) => {
      if (isWholeModalHandle && e.target.closest("#yt-summarizer-content, #yt-summarizer-corner-actions, button, a")) return;
      modal.style.top = "20px";
      modal.style.right = "20px";
      modal.style.left = "auto";
      modal.style.bottom = "auto";
    });
  }

  function makeResizable(modal) {
    const handles = modal.querySelectorAll(".yt-sum-resize-handle");
    let activeDir = null;
    let startX = 0, startY = 0, startW = 0, startH = 0, startLeft = 0, startTop = 0;
    const minW = 320, minH = 240;
    const maxW = () => window.innerWidth - 16;
    const maxH = () => window.innerHeight - 16;

    const onMouseDown = (e) => {
      const dir = e.target.dataset.dir;
      if (!dir) return;
      activeDir = dir;
      const rect = modal.getBoundingClientRect();
      // Ensure modal is positioned via left/top
      if (modal.style.right !== "auto" || !modal.style.left || modal.style.left === "auto") {
        modal.style.left = rect.left + "px";
        modal.style.right = "auto";
      }
      if (!modal.style.top || modal.style.top === "auto") {
        modal.style.top = rect.top + "px";
        modal.style.bottom = "auto";
      }
      startX = e.clientX;
      startY = e.clientY;
      startW = rect.width;
      startH = rect.height;
      startLeft = rect.left;
      startTop = rect.top;
      modal.classList.add("resizing");
      e.preventDefault();
      e.stopPropagation();
    };
    const onMouseMove = (e) => {
      if (!activeDir) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newW = startW;
      let newH = startH;
      let newLeft = startLeft;
      let newTop = startTop;

      if (activeDir.includes("e")) newW = Math.max(minW, Math.min(startW + dx, maxW() - startLeft));
      if (activeDir.includes("w")) {
        newW = Math.max(minW, Math.min(startW - dx, startLeft + startW - 8));
        newLeft = startLeft + (startW - newW);
        newLeft = Math.max(8, Math.min(newLeft, window.innerWidth - newW - 8));
      }
      if (activeDir.includes("s")) newH = Math.max(minH, Math.min(startH + dy, maxH() - startTop));
      if (activeDir.includes("n")) {
        newH = Math.max(minH, Math.min(startH - dy, startTop + startH - 8));
        newTop = startTop + (startH - newH);
        newTop = Math.max(8, Math.min(newTop, window.innerHeight - newH - 8));
      }

      // Apply
      modal.style.width = newW + "px";
      modal.style.height = newH + "px";
      // For flex column, set max-height via height; also update body max-height? Let CSS handle via flex
      modal.style.maxHeight = "none";
      if (activeDir.includes("w") || activeDir.includes("n")) {
        modal.style.left = newLeft + "px";
        modal.style.top = newTop + "px";
      } else if (activeDir.includes("e") || activeDir.includes("s")) {
        // Keep left/top as is, ensure right/bottom auto
        modal.style.left = newLeft + "px";
        modal.style.top = newTop + "px";
      }
      // Update body max-height to fit (include pagination bar if visible)
      const header = modal.querySelector("#yt-summarizer-header");
      const footer = modal.querySelector("#yt-summarizer-footer");
      const pagination = modal.querySelector("#yt-summarizer-pagination");
      const headerH = header ? header.offsetHeight : 0;
      const footerH = footer ? footer.offsetHeight : 0;
      const paginationH = pagination && pagination.style.display !== "none" ? pagination.offsetHeight : 0;
      const body = modal.querySelector("#yt-summarizer-body");
      if (body) body.style.maxHeight = (newH - headerH - footerH - paginationH - 4) + "px";
    };
    const onMouseUp = () => {
      if (activeDir) {
        activeDir = null;
        modal.classList.remove("resizing");
      }
    };
    handles.forEach(h => h.addEventListener("mousedown", onMouseDown));
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    // Touch
    handles.forEach(h => h.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      if (!t) return;
      onMouseDown({ target: e.target, clientX: t.clientX, clientY: t.clientY, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() });
    }, { passive: false }));
    document.addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      if (!t) return;
      onMouseMove({ clientX: t.clientX, clientY: t.clientY });
    }, { passive: false });
    document.addEventListener("touchend", onMouseUp);
  }

  // ---------- Obsidian clip ----------
  async function handleObsidianClip() {
    const overlay = document.getElementById("yt-summarizer-overlay");
    const btn = overlay ? overlay.querySelector("#yt-summarizer-obsidian") : null;
    const markdown = lastMarkdown || "";
    if (!markdown || markdown.trim().length < 10) {
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = "No summary yet";
        setTimeout(() => (btn.textContent = orig), 1800);
      }
      return;
    }
    const videoId = lastVideoId || extractVideoIdFromUrl(location.href) || "unknown";
    const meta = lastMeta || {};
    const { obsidianVault, obsidianFolder } = await new Promise(resolve => {
      try {
        chrome.storage.sync.get(["obsidianVault", "obsidianFolder"], resolve);
      } catch { resolve({}); }
    });

    const clipMarkdown = buildObsidianMarkdown(markdown, meta, videoId);
    const sanitizedTitle = sanitizeFilename(meta.title || "YouTube Summary");
    const datePrefix = new Date().toISOString().slice(0, 10);
    // filename: include date + title + videoId to avoid collisions, keep under 80 chars
    let baseName = `${datePrefix} - ${sanitizedTitle}`.slice(0, 80).trim();
    if (videoId && videoId !== "unknown") baseName += ` - ${videoId}`;
    const folder = (obsidianFolder || "Clips").replace(/^\/+|\/+$/g, "").trim() || "Clips";
    const fileName = baseName.replace(/\.md$/i, "") + ".md";
    const filePath = `${folder}/${fileName}`;

    // Try Obsidian URI if vault configured or content small enough
    const vaultParam = obsidianVault ? `vault=${encodeURIComponent(obsidianVault)}&` : "";
    const encodedContent = encodeURIComponent(clipMarkdown);
    const encodedFile = encodeURIComponent(filePath);
    const obsidianUri = `obsidian://new?${vaultParam}file=${encodedFile}&content=${encodedContent}`;

    // Obsidian URI length limit ~ 8000, fallback to download if too long
    const canUseUri = obsidianUri.length < 8000;

    // helper to open Obsidian URI safely via hidden anchor + window.open fallback
    const openObsidianUri = (uri) => {
      try {
        const a = document.createElement("a");
        a.href = uri;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { a.remove(); } catch {} }, 1000);
        try { window.open(uri, "_blank"); } catch {}
        return true;
      } catch { return false; }
    };

    if (btn) {
      const orig = btn.textContent;
      if (canUseUri) {
        btn.textContent = "Opening Obsidian…";
        openObsidianUri(obsidianUri);
        setTimeout(() => {
          btn.textContent = obsidianVault ? "Added to Obsidian ✓" : "Opened Obsidian ✓";
          setTimeout(() => (btn.textContent = orig), 1800);
        }, 600);
        // Copy as backup
        try { await navigator.clipboard.writeText(clipMarkdown); } catch {}
        // If no vault configured, still trigger download as guarantee
        if (!obsidianVault) {
          setTimeout(() => { try { downloadMarkdown(fileName, clipMarkdown); } catch {} }, 1200);
        }
      } else {
        // Too long for single URI -> hybrid: clipboard + download + open placeholder in Obsidian (so vault actually gets a file)
        btn.textContent = "Copying & opening…";
        let clipboardOk = false;
        try { await navigator.clipboard.writeText(clipMarkdown); clipboardOk = true; } catch {}
        // Always download as fallback (goes to Downloads folder)
        downloadMarkdown(fileName, clipMarkdown);

        // Build short placeholder (<2k URI) that WILL fit and actually create/open the note in the vault
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const dur = meta.duration ? formatDuration(meta.duration) : (meta.durationSeconds ? formatDuration(meta.durationSeconds) : "");
        const ch = meta.channel || "";
        const kb = Math.round(clipMarkdown.length/1000);
        const pageCount = lastPages ? lastPages.length : Math.ceil(clipMarkdown.length/6000);
        const placeholder = `# ${sanitizeFilename(meta.title || "YouTube Summary").slice(0,60)}\n\n> Source: [${meta.title || "Video"}](${url})${ch ? ` — ${ch}` : ""}${dur ? ` • ${dur}` : ""}\n\n> ⚠️ Full analysis is **${kb}k / ${pageCount} pages** — too long for direct open (URI limit). Full content **${clipboardOk ? "copied to clipboard ✓" : "downloaded (clipboard failed)"}** and **downloaded as \`${fileName}\`**.\n>\n> **Next step:** Press **Ctrl+V / Cmd+V here** to paste full analysis into this note, or move the downloaded file into your vault's \`${folder}/\` folder.\n\n---\n\n*Placeholder created — paste will replace this note's content. If paste didn't work, open Downloads and move \`${fileName}\` into vault.*\n`;
        const encodedPlaceholder = encodeURIComponent(placeholder);
        const placeholderUri = `obsidian://new?${vaultParam}file=${encodedFile}&content=${encodedPlaceholder}`;
        // Open placeholder note in Obsidian — this actually creates the file in the vault
        const opened = openObsidianUri(placeholderUri);
        // Fallback: try file-only URI (creates empty file) if placeholder failed due to vault param
        if (!opened) {
          const fileOnlyUri = `obsidian://new?${vaultParam}file=${encodedFile}`;
          openObsidianUri(fileOnlyUri);
        }

        // Best-effort: try to append full content in chunks via Advanced URI plugin (if user has it installed)
        // This will silently succeed for plugin users and fail harmlessly for others
        if (clipboardOk) {
          // don't await blocking UI — run in background
          (async () => {
            try { await tryAdvancedUriAppend(filePath, clipMarkdown, obsidianVault); } catch {}
          })();
        }

        setTimeout(() => {
          btn.textContent = clipboardOk ? "Opened Obsidian ✓ — paste to fill" : "Downloaded ✓ — move file to vault";
          setTimeout(() => (btn.textContent = orig), 3500);
        }, 500);
      }
    } else if (canUseUri) {
      window.location.href = obsidianUri;
    } else {
      // no button context, but still do hybrid for long content
      try { await navigator.clipboard.writeText(clipMarkdown); } catch {}
      downloadMarkdown(fileName, clipMarkdown);
      const placeholder = `# Note\n\nContent too long — copied to clipboard and downloaded as ${fileName}. Paste here.\n`;
      const placeholderUri = `obsidian://new?${vaultParam}file=${encodedFile}&content=${encodeURIComponent(placeholder)}`;
      openObsidianUri(placeholderUri);
    }
  }

  function buildObsidianMarkdown(summary, meta, videoId) {
    const url = videoId && videoId !== "unknown" ? `https://www.youtube.com/watch?v=${videoId}` : (location.href || "");
    const title = (meta.title || document.title.replace(" - YouTube", "").trim() || "Untitled").trim();
    const channel = meta.channel || "";
    const dur = meta.duration ? formatDuration(meta.duration) : (meta.durationSeconds ? formatDuration(meta.durationSeconds) : "");
    const created = new Date().toISOString();
    const dateShort = created.slice(0, 10);
    const escTitle = escapeYaml(title);
    const escChannel = escapeYaml(channel);
    const header = [
      "---",
      `title: "${escTitle}"`,
      `source: "${url}"`,
      `video_id: "${videoId}"`,
      channel ? `channel: "${escChannel}"` : null,
      dur ? `duration: "${dur}"` : null,
      `created: ${created}`,
      `date: ${dateShort}`,
      `tags: [youtube, clip]`,
      `author: "${escChannel}"`,
      "---",
      ""
    ].filter(v => v !== null && v !== undefined).join("\n");

    const sourceLine = `> Source: [${title}](${url})${channel ? ` — ${channel}` : ""}${dur ? ` • ${dur}` : ""}`;

    let transcriptBlock = "";
    if (meta.transcript && meta.transcript.length > 20) {
      const tr = meta.transcript.slice(0, 6000);
      transcriptBlock = `\n\n<details>\n<summary>Transcript</summary>\n\n\`\`\`text\n${tr}${meta.transcript.length > 6000 ? "\n...[truncated]" : ""}\n\`\`\`\n</details>`;
    }

    return `${header}# ${title}\n\n${sourceLine}\n\n${summary}${transcriptBlock}\n`;
  }

  function sanitizeFilename(name) {
    if (!name) return "Untitled";
    return name
      .replace(/[\\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/\.+$/g, "")
      .trim()
      .slice(0, 80) || "Untitled";
  }

  function escapeYaml(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function downloadMarkdown(filename, content) {
    try {
      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { URL.revokeObjectURL(url); a.remove(); } catch {}
      }, 1000);
    } catch (e) {
      console.warn("[yt-sum] download failed", e);
    }
  }

  // Best-effort: if user has Obsidian Advanced URI plugin, we can append long content in chunks
  // Standard obsidian://new fails for >8000 chars due to URI length. This tries advanced-uri append.
  // Silently fails if plugin not installed — fallback is clipboard + download already done.
  async function tryAdvancedUriAppend(filePath, fullContent, vault) {
    const chunkSize = 6500; // keep URI <8000 after encoding
    const chunks = [];
    for (let i = 0; i < fullContent.length; i += chunkSize) chunks.push(fullContent.slice(i, i + chunkSize));
    if (chunks.length === 0) return;
    // Cap to avoid flooding vault with dozens of URI opens (clipboard+download covers rest)
    const capped = chunks.slice(0, 8); // ~52k chars — enough for most multi-page analyses
    for (let i = 0; i < capped.length; i++) {
      const data = encodeURIComponent(capped[i]);
      const vaultParam = vault ? `vault=${encodeURIComponent(vault)}&` : "";
      const mode = i === 0 ? "overwrite" : "append";
      const uri = `obsidian://advanced-uri?${vaultParam}filepath=${encodeURIComponent(filePath)}&data=${data}&mode=${mode}`;
      if (uri.length > 8000) continue;
      try {
        const a = document.createElement("a");
        a.href = uri;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { a.remove(); } catch {} }, 500);
        try { window.open(uri, "_blank"); } catch {}
      } catch {}
      await new Promise(r => setTimeout(r, 400));
    }
  }

  function extractVideoIdFromUrl(url) {
    if (!url) return null;
    try {
      if (url.startsWith("/")) url = "https://www.youtube.com" + url;
      const u = new URL(url);
      const v = u.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:shorts\/|embed\/|v\/|live\/))([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
      const m3 = url.match(/\/vi\/([a-zA-Z0-9_-]{11})/);
      if (m3) return m3[1];
      return null;
    } catch { return null; }
  }

  function isYouTubeFullscreen() {
    return !!document.fullscreenElement || !!document.querySelector("ytd-watch-flexy[fullscreen], #movie_player.ytp-fullscreen, .ytp-fullscreen, ytd-watch-flexy[theater]");
  }
  function updateOrbFullscreenVisibility() {
    const orb = document.getElementById("yt-sum-siri-orb");
    if (!orb) return;
    // Only hide when truly fullscreen video (not theater)
    const isFs = !!document.fullscreenElement || !!document.querySelector("#movie_player.ytp-fullscreen");
    if (isFs) {
      orb.classList.add("yt-sum-hidden-fullscreen");
      hideOrbDropdown();
    } else {
      orb.classList.remove("yt-sum-hidden-fullscreen");
    }
  }
  function tryEmbedOrbInMasthead() {
    // For pill-expanding mode, keep orb as fixed overlay positioned in header gap
    // (embedding inside masthead would clip the 380px expanded height)
    // So we just position it fixed in the gap and return true to indicate positioned
    const orb = document.getElementById("yt-sum-siri-orb");
    if (!orb) return false;
    // Remove embedded class if previously set — we want fixed for expandable pill
    if (orb.classList.contains("yt-sum-embedded")) {
      orb.classList.remove("yt-sum-embedded");
      // move back to body if it was moved
      if (!document.body.contains(orb) || orb.closest("ytd-masthead, #masthead")) {
        document.body.appendChild(orb);
      }
      orb.style.position = "fixed";
    }
    return positionOrbBetweenLogoAndSearch(orb);
  }
  function initPersistentOrb() {
    const orb = ensureSiriOrb();
    // Try embedded first, fallback to fixed gap
    const embedded = tryEmbedOrbInMasthead();
    if (!embedded) {
      orb.classList.remove("yt-sum-embedded");
      // keep fixed positioning logic for fallback
      positionOrbBetweenLogoAndSearch(orb);
    }
    setOrbIdle();
    orb.style.display = "flex";
    orb.style.opacity = "";
    orb.style.transform = "";
    // Observe masthead for SPA re-renders
    try {
      const mast = document.querySelector("ytd-masthead, #masthead");
      if (mast && !mast._ytOrbObserver) {
        const obs = new MutationObserver(() => {
          if (!document.body.contains(orb) || (!orb.closest("ytd-masthead, #masthead") && !orb.classList.contains("yt-sum-embedded"))) {
            setTimeout(() => { if (!tryEmbedOrbInMasthead()) positionOrbBetweenLogoAndSearch(orb); }, 300);
          }
        });
        obs.observe(mast, { childList: true, subtree: false });
        mast._ytOrbObserver = obs;
      }
    } catch {}
    document.addEventListener("fullscreenchange", updateOrbFullscreenVisibility);
    document.addEventListener("webkitfullscreenchange", updateOrbFullscreenVisibility);
    // Also watch YT's fullscreen attribute
    try {
      const watch = document.querySelector("ytd-watch-flexy, #movie_player");
      if (watch && !watch._ytOrbFSObs) {
        const obs2 = new MutationObserver(updateOrbFullscreenVisibility);
        obs2.observe(watch, { attributes: true, attributeFilter: ["fullscreen","class"] });
        obs2.observe(document.documentElement, { attributes: true, attributeFilter: ["fullscreen"] });
        watch._ytOrbFSObs = obs2;
      }
    } catch {}
    updateOrbFullscreenVisibility();
    // Re-try embed on YouTube SPA navigation
    window.addEventListener("yt-navigate-finish", () => setTimeout(() => { tryEmbedOrbInMasthead() || positionOrbBetweenLogoAndSearch(orb); }, 500));
  }

  function hide() {
    const o = document.getElementById("yt-summarizer-overlay");
    if (o) o.classList.remove("visible");
    // keep Siri orb persistent — don't hide it on modal close
    const pill = document.getElementById("yt-sum-loading-pill");
    if (pill) pill.style.display = "none";
    // close dropdown if open
    const dd = document.getElementById("yt-sum-orb-dropdown");
    if (dd) dd.classList.remove("visible");
  }

  function positionOrbBetweenLogoAndSearch(orb) {
    // if already embedded in masthead, keep it there — don't override with fixed
    if (orb.classList.contains("yt-sum-embedded") && orb.closest("ytd-masthead, #masthead")) return true;
    try {
      // Try to sit in the horizontal gap between YouTube logo and search bar
      const logoEl = document.querySelector("ytd-masthead #start #logo, ytd-masthead #start, #masthead #logo, #start #logo");
      const centerEl = document.querySelector("ytd-masthead #center, #masthead #center, ytd-masthead #search, #center #search");
      const masthead = document.querySelector("ytd-masthead, #masthead");
      if (logoEl && centerEl && masthead) {
        const logoRect = logoEl.getBoundingClientRect();
        const centerRect = centerEl.getBoundingClientRect();
        const mastRect = masthead.getBoundingClientRect();
        const gapStart = logoRect.right;
        const gapEnd = centerRect.left;
        const gapWidth = gapEnd - gapStart;
        // Need at least 90px to fit orb pill comfortably
        if (gapWidth > 88 && mastRect.top < 80) {
          // Place centered in gap, vertically centered in masthead (56px header)
          const orbWidth = Math.min(220, gapWidth - 16); // keep margin
          const left = gapStart + (gapWidth - orbWidth) / 2;
          const top = mastRect.top + (mastRect.height - 28) / 2; // 28 = new compact pill height
          orb.style.left = `${Math.round(left)}px`;
          orb.style.top = `${Math.round(Math.max(6, top))}px`;
          orb.style.right = "auto";
          orb.style.bottom = "auto";
          orb.style.maxWidth = `${Math.round(orbWidth)}px`;
          return true;
        }
      }
    } catch {}
    return false;
  }

  function ensureSiriOrb() {
    let orb = document.getElementById("yt-sum-siri-orb");
    if (orb) return orb;
    orb = document.createElement("div");
    orb.id = "yt-sum-siri-orb";
    orb.style.display = "none";
    orb.innerHTML = `
      <div class="yt-sum-orb-header">
        <div class="yt-sum-orb-wrap">
          <div class="yt-sum-orb"></div>
          <svg class="yt-sum-orb-ring" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <circle class="bg" cx="10" cy="10" r="9"></circle>
            <circle class="fg" cx="10" cy="10" r="9"></circle>
          </svg>
        </div>
        <div class="yt-sum-orb-text">
          <strong>AI summary</strong>
          <span style="display:none"></span>
        </div>
      </div>
      <div id="yt-sum-orb-dropdown" role="menu" aria-hidden="true">
        <div class="yt-sum-dropdown-list" id="yt-sum-dropdown-list"></div>
        <div class="yt-sum-no-results" id="yt-sum-no-results">No matching summaries</div>
        <div class="yt-sum-search-wrap" id="yt-sum-search-wrap-pill" style="position:relative">
          <input id="yt-sum-search-input-pill" type="text" placeholder="Filter summaries…" autocomplete="off">
          <svg class="yt-sum-search-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="12.5" y1="12.5" x2="17" y2="17"/></svg>
          <button class="yt-sum-search-clear" id="yt-sum-search-clear-pill" title="Clear">✕</button>
        </div>
      </div>
      <div id="yt-sum-orb-preview" role="complementary" aria-hidden="true"></div>
    `;
    document.body.appendChild(orb);

    // Hover: CSS :hover handles pill expansion consistently (no JS timer flicker). JS only ensures data is loaded.
    let _hasFetched = false;
    const _ensureDropdownData = async () => {
      if (_hasFetched) return;
      const list = document.getElementById("yt-sum-dropdown-list");
      if (list && list.dataset.loaded === "true") { _hasFetched = true; return; }
      _hasFetched = true;
      try {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter(k=>k.startsWith("yt_sum_cache_"));
        const entries = keys.map(k=>{
          const v = all[k];
          return { key:k, ...v, videoId: v.meta?.videoId || v.videoId || (k.match(/^yt_sum_cache_([a-zA-Z0-9_-]{11})_/)||[])[1] || "unknown", ts: v.ts||0 };
        }).filter(e=>e.pages && e.summary).sort((a,b)=>b.ts - a.ts).slice(0,50);
        renderOrbDropdown(entries);
        if (list) list.dataset.loaded = "true";
      } catch {
        if (list) list.innerHTML = `<div class="yt-sum-dropdown-empty">No history yet.<br>Right-click a YouTube thumbnail → Summarize video</div>`;
      }
    };
    orb.addEventListener("mouseenter", _ensureDropdownData);
    // dropdown/preview hover is now handled by CSS :hover on #yt-sum-siri-orb — no JS timers needed for visibility
    // Quick search — filter dropdown entries by title, channel, and content
    const searchInputPill = orb.querySelector("#yt-sum-search-input-pill");
    const searchClearPill = orb.querySelector("#yt-sum-search-clear-pill");
    const noResultsEl = orb.querySelector("#yt-sum-no-results");
    const handleSearchFilter = () => {
      const q = (searchInputPill?.value || "").trim().toLowerCase();
      const list = document.getElementById("yt-sum-dropdown-list");
      if (!list) return;
      const items = list.querySelectorAll(".yt-sum-dropdown-item");
      const qEsc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let visibleCount = 0;
      items.forEach(el => {
        const titleEl = el.querySelector(".yt-sum-dropdown-title");
        const subEl = el.querySelector(".yt-sum-dropdown-sub");
        if (!q) {
          el.classList.remove("yt-sum-hidden");
          if (titleEl) titleEl.innerHTML = escapeHtml(el.dataset.title || "");
          if (subEl) subEl.innerHTML = escapeHtml(el.dataset.sub || "");
          visibleCount++;
          return;
        }
        const title = (el.dataset.title || "").toLowerCase();
        const sub = (el.dataset.sub || "").toLowerCase();
        const content = (el.dataset.summary || "").toLowerCase();
        const match = title.includes(q) || sub.includes(q) || content.includes(q);
        el.classList.toggle("yt-sum-hidden", !match);
        if (!match) return;
        visibleCount++;
        if (titleEl) titleEl.innerHTML = highlightSearchText(el.dataset.title || "", qEsc);
        if (subEl) subEl.innerHTML = highlightSearchText(el.dataset.sub || "", qEsc);
      });
      // show/hide clear button
      if (searchClearPill) searchClearPill.classList.toggle("visible", q.length > 0);
      // show/hide no-results message
      if (noResultsEl) noResultsEl.classList.toggle("visible", visibleCount === 0 && q.length > 0);
    };
    if (searchInputPill) {
      searchInputPill.addEventListener("input", handleSearchFilter);
      searchInputPill.addEventListener("keydown", (e) => { if (e.key === "Escape") { searchInputPill.value = ""; handleSearchFilter(); } e.stopPropagation(); });
      searchInputPill.addEventListener("click", (e) => e.stopPropagation());
      searchInputPill.addEventListener("focus", (e) => e.stopPropagation());
    }
    if (searchClearPill) {
      searchClearPill.addEventListener("click", (e) => { e.stopPropagation(); if (searchInputPill) { searchInputPill.value = ""; handleSearchFilter(); searchInputPill.focus(); } });
    }

    // click fallback for touch / mobile (tap toggles) — desktop hover is CSS-driven
    let _orbClickArmed = true;
    let _dragMoved = false;
    orb.addEventListener("mousedown", () => { _dragMoved = false; _orbClickArmed = true; });
    orb.addEventListener("mousemove", () => { _dragMoved = true; });
    orb.addEventListener("mouseup", () => { if (_dragMoved) _orbClickArmed = false; setTimeout(()=> _orbClickArmed=true, 100); });
    orb.addEventListener("click", (e) => {
      if (e.target.closest("#yt-sum-orb-dropdown") || e.target.closest("#yt-sum-orb-preview")) return;
      if (!_orbClickArmed) return;
      if (window.matchMedia("(hover: hover)").matches) {
        _ensureDropdownData();
        return;
      }
      e.stopPropagation();
      const isExpanded = orb.classList.contains("expanded");
      if (isExpanded) {
        hideOrbDropdown();
        orb.classList.remove("expanded");
      } else {
        _ensureDropdownData();
        orb.classList.add("expanded");
        const dd = document.getElementById("yt-sum-orb-dropdown");
        if (dd) { dd.classList.add("visible"); dd.setAttribute("aria-hidden","false"); }
      }
    });
    // click outside to close for touch-expanded mode (desktop hover is CSS, no need)
    document.addEventListener("click", (e) => {
      const orbEl = document.getElementById("yt-sum-siri-orb");
      if (!orbEl || !orbEl.classList.contains("expanded")) return;
      if (window.matchMedia("(hover: hover)").matches) return;
      if (e.target.closest("#yt-sum-siri-orb")) return;
      orbEl.classList.remove("expanded");
      hideOrbDropdown();
    });
    // keep position updated on resize/scroll (masthead is sticky) — only if not embedded
    let _repositionTimer = null;
    const _onResize = () => {
      if (orb.style.display === "none" || orb.classList.contains("yt-sum-embedded")) return;
      clearTimeout(_repositionTimer);
      _repositionTimer = setTimeout(() => positionOrbBetweenLogoAndSearch(orb), 80);
    };
    window.addEventListener("resize", _onResize);
    window.addEventListener("scroll", _onResize, { passive: true });
    return orb;
  }

  function hideOrbDropdown() {
    const dd = document.getElementById("yt-sum-orb-dropdown");
    const orb = document.getElementById("yt-sum-siri-orb");
    if (dd) { dd.classList.remove("visible"); dd.setAttribute("aria-hidden","true"); }
    if (orb) orb.classList.remove("expanded");
    hideOrbPreview();
  }
  function hideOrbPreview() {
    const pv = document.getElementById("yt-sum-orb-preview");
    if (pv) { pv.classList.remove("visible"); pv.setAttribute("aria-hidden","true"); pv.innerHTML = ""; }
  }
  function toggleOrbDropdown() {
    const dd = document.getElementById("yt-sum-orb-dropdown");
    if (!dd) return;
    if (dd.classList.contains("visible")) { hideOrbDropdown(); return; }
    showOrbDropdown();
  }
  async function showOrbDropdown() {
    const dd = document.getElementById("yt-sum-orb-dropdown");
    const list = document.getElementById("yt-sum-dropdown-list");
    const orb = document.getElementById("yt-sum-siri-orb");
    if (!dd || !list) return;
    if (orb) orb.classList.add("expanded");
    dd.classList.add("visible");
    dd.setAttribute("aria-hidden","false");
    if (list) list.innerHTML = `<div class="yt-sum-dropdown-empty">Loading…</div>`;
    try {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter(k=>k.startsWith("yt_sum_cache_"));
      const entries = keys.map(k=>{
        const v = all[k];
        return { key:k, ...v, videoId: v.meta?.videoId || v.videoId || (k.match(/^yt_sum_cache_([a-zA-Z0-9_-]{11})_/)||[])[1] || "unknown", ts: v.ts||0 };
      }).filter(e=>e.pages && e.summary).sort((a,b)=>b.ts - a.ts).slice(0,10);
      renderOrbDropdown(entries);
    } catch {
      if (list) list.innerHTML = `<div class="yt-sum-dropdown-empty">No history yet.<br>Right-click a YouTube thumbnail → Summarize video</div>`;
    }
  }
  function showOrbPreview(entry) {
    const pv = document.getElementById("yt-sum-orb-preview");
    const orb = document.getElementById("yt-sum-siri-orb");
    if (!pv || !orb || !entry) return;
    // Build preview from cached summary (first page, truncated)
    const title = (entry.meta?.title || "Untitled").slice(0,64);
    const ch = entry.meta?.channel || "";
    const dur = entry.meta?.duration || entry.meta?.durationSeconds || 0;
    const durStr = dur ? formatDuration(dur) : "";
    const pages = entry.pages || [];
    const firstPage = pages[0] || entry.summary || "";
    // Render first ~800 chars of summary as preview
    const previewMd = firstPage.slice(0, 800) + (firstPage.length > 800 ? "…" : "");
    const previewHtml = renderMarkdown(previewMd);
    pv.setAttribute("data-vid", entry.videoId || "unknown");
    pv.dataset.vid = entry.videoId || "unknown";
    pv.setAttribute("data-key", entry.key || "");
    pv.innerHTML = `
      <div class="yt-sum-preview-title">${escapeHtml(title)}</div>
      <div class="yt-sum-preview-sub">${escapeHtml(ch)}${ch && durStr ? " • " : ""}${escapeHtml(durStr)} • ${pages.length} pg</div>
      <div class="yt-sum-preview-body">${previewHtml}</div>
      <div class="yt-sum-preview-hint">Click to expand into full summary box</div>
    `;
    pv.classList.add("visible");
    pv.setAttribute("aria-hidden","false");
    const qRaw = (document.getElementById("yt-sum-search-input-pill")?.value || "").trim().toLowerCase();
    const qEsc = qRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (qEsc) {
      highlightInElement(pv.querySelector(".yt-sum-preview-title"), qEsc);
      highlightInElement(pv.querySelector(".yt-sum-preview-sub"), qEsc);
      highlightInElement(pv.querySelector(".yt-sum-preview-body"), qEsc);
    }
    // keep preview alive when hovering preview itself
    pv.onmouseenter = () => { const t = pv._hideTimer; if (t) clearTimeout(t); };
    pv.onmouseleave = () => { setTimeout(() => hideOrbPreview(), 220); };
    pv.onclick = async () => {
      const vid = pv.getAttribute("data-vid") || pv.dataset.vid;
      if (!vid || vid==="unknown") return;
      hideOrbDropdown(); hideOrbPreview();
      try {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter(k=>k.includes(vid));
        let cached = null;
        for (const k of keys) if (all[k]?.pages) { cached = all[k]; break; }
        if (cached && cached.pages) {
          lastMarkdown = cached.summary || cached.pages.join("\n\n---\n\n");
          lastPages = cached.pages;
          lastMeta = cached.meta;
          lastVideoId = cached.videoId || vid;
          lastCurrentPage = 0;
          showSummary(lastMarkdown, lastMeta, lastPages, false, null);
        }
      } catch {}
    };
    // position to right of dropdown — tiny gap to feel connected as natural extension of pill
    try {
      const orbRect = orb.getBoundingClientRect();
      const dd = document.getElementById("yt-sum-orb-dropdown");
      const ddRect = dd ? dd.getBoundingClientRect() : orbRect;
      // Prefer right side of dropdown
      let left = ddRect.right + 6;
      let top = ddRect.top;
      const pvWidth = 340;
      const pvHeight = 360;
      // If not enough space on right, place below dropdown
      if (left + pvWidth > window.innerWidth - 12) {
        left = Math.max(12, ddRect.left);
        top = ddRect.bottom + 10;
        // if still off-screen bottom, clamp
        if (top + pvHeight > window.innerHeight - 12) top = Math.max(12, window.innerHeight - pvHeight - 12);
      }
      pv.style.left = `${Math.round(left)}px`;
      pv.style.top = `${Math.round(top)}px`;
      pv.style.right = "auto";
      pv.style.bottom = "auto";
    } catch {}
  }
  function renderOrbDropdown(entries) {
    const list = document.getElementById("yt-sum-dropdown-list");
    if (!list) return;
    if (!entries || entries.length===0) {
      list.innerHTML = `<div class="yt-sum-dropdown-empty">No analyses yet.<br>Right-click a video → Summarize</div>`;
      return;
    }
    list.innerHTML = entries.map(e=>{
      const title = escapeHtml((e.meta?.title || "Untitled").slice(0,48));
      const ch = escapeHtml(e.meta?.channel || "");
      const dur = e.meta?.duration || e.meta?.durationSeconds || 0;
      const durStr = dur ? formatDuration(dur) : "";
      const pages = e.pages ? e.pages.length : 1;
      const date = e.ts ? new Date(e.ts).toLocaleDateString() : "";
      const summaryText = (e.summary || (e.pages ? e.pages.join(" ") : "")).replace(/<[^>]*>/g, "").slice(0, 500);
      const subText = `${ch ? ch+" • " : ""}${durStr ? durStr+" • " : ""}${pages} pg • ${escapeHtml(date)}`;
      return `<div class="yt-sum-dropdown-item" data-vid="${escapeHtml(e.videoId)}" data-key="${escapeHtml(e.key)}" data-summary="${escapeHtml(summaryText)}" data-title="${title}" data-sub="${subText}" role="menuitem" tabindex="0">
        <div class="yt-sum-dropdown-meta">
          <div class="yt-sum-dropdown-title">${title}</div>
          <div class="yt-sum-dropdown-sub">${subText}</div>
        </div>
      </div>`;
    }).join("");
    // attach click + hover-preview handlers — preview stays when hovering preview itself
    let _previewTimer = null;
    let _previewHideTimer = null;
    const clearPreviewTimer = () => { if (_previewTimer) { clearTimeout(_previewTimer); _previewTimer = null; } };
    const clearPreviewHideTimer = () => { if (_previewHideTimer) { clearTimeout(_previewHideTimer); _previewHideTimer = null; } };
    const scheduleHidePreview = () => {
      clearPreviewHideTimer();
      _previewHideTimer = setTimeout(() => {
        const pv = document.getElementById("yt-sum-orb-preview");
        // Don't hide if still hovering preview or any item
        if (pv && pv.matches(":hover")) return;
        const stillHoveringItem = document.querySelector(".yt-sum-dropdown-item:hover");
        const orbHover = document.querySelector("#yt-sum-siri-orb:hover");
        if (stillHoveringItem || (pv && pv.matches(":hover")) || orbHover) {
          // check again shortly
          _previewHideTimer = setTimeout(() => hideOrbPreview(), 300);
          return;
        }
        hideOrbPreview();
      }, 320);
    };
    // keep preview alive when hovering preview itself
    const _previewElKeep = document.getElementById("yt-sum-orb-preview");
    if (_previewElKeep) {
      _previewElKeep.addEventListener("mouseenter", () => { clearPreviewTimer(); clearPreviewHideTimer(); });
      _previewElKeep.addEventListener("mouseleave", scheduleHidePreview);
      _previewElKeep.addEventListener("click", async () => {
        // click preview to expand into full summary box
        const vid = _previewElKeep.getAttribute("data-vid") || _previewElKeep.dataset.vid;
        const key = _previewElKeep.getAttribute("data-key");
        hideOrbDropdown();
        hideOrbPreview();
        try {
          const all = await chrome.storage.local.get(null);
          let cached = key ? all[key] : null;
          if (!(cached && cached.pages) && vid && vid !== "unknown") {
            const keys = Object.keys(all).filter(k=>k.includes(vid));
            for (const k of keys) if (all[k]?.pages) { cached = all[k]; break; }
          }
          if (cached && cached.pages) {
            lastMarkdown = cached.summary || cached.pages.join("\n\n---\n\n");
            lastPages = cached.pages;
            lastMeta = cached.meta;
            lastVideoId = cached.videoId || vid;
            lastCurrentPage = 0;
            showSummary(lastMarkdown, lastMeta, lastPages, false, null);
          }
        } catch {}
      });
    }
    list.querySelectorAll(".yt-sum-dropdown-item").forEach(el=>{
      const vid = el.getAttribute("data-vid");
      const key = el.getAttribute("data-key");
      const entry = entries.find(x=>x.key===key) || entries.find(x=>x.videoId===vid);
      const open = async () => {
        hideOrbDropdown();
        hideOrbPreview();
        clearPreviewTimer(); clearPreviewHideTimer();
        try {
          const all = await chrome.storage.local.get(null);
          let cached = key ? all[key] : null;
          if (!(cached && cached.pages) && vid && vid !== "unknown") {
            const keys = Object.keys(all).filter(k=>k.includes(vid));
            for (const k of keys) if (all[k]?.pages) { cached = all[k]; break; }
          }
          if (cached && cached.pages) {
            lastMarkdown = cached.summary || cached.pages.join("\n\n---\n\n");
            lastPages = cached.pages;
            lastMeta = cached.meta;
            lastVideoId = cached.videoId || vid;
            lastCurrentPage = 0;
            showSummary(lastMarkdown, lastMeta, lastPages, false, null);
            return;
          }
        } catch {}
        if (vid && vid !== "unknown") {
          try { window.open(`https://www.youtube.com/watch?v=${vid}`, "_blank"); } catch {}
        }
      };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e)=>{ if(e.key==="Enter") open(); });
      // hover preview: immediate (no delay) — shows on right side as natural extension
      el.addEventListener("mouseenter", () => {
        clearPreviewTimer(); clearPreviewHideTimer();
        if (!entry) return;
        showOrbPreview(entry);
      });
      el.addEventListener("mouseleave", () => { scheduleHidePreview(); });
      el.addEventListener("focus", () => { clearPreviewTimer(); clearPreviewHideTimer(); if (entry) showOrbPreview(entry); });
      el.addEventListener("blur", () => { scheduleHidePreview(); });
    });
    // also handle leaving list area
    list.addEventListener("mouseleave", () => { clearPreviewTimer(); scheduleHidePreview(); });
    // keep preview when hovering orb itself
    const _orbForPreview = document.getElementById("yt-sum-siri-orb");
    if (_orbForPreview) {
      _orbForPreview.addEventListener("mouseleave", () => { clearPreviewTimer(); scheduleHidePreview(); });
    }
  }
  // keep old name for compat
  function ensureLoadingPill() { return ensureSiriOrb(); }

  function showLoading(text, sub) {
    const overlay = ensureContainer();
    // keep overlay hidden during loading — don't blur YouTube, let orb live alone top-left
    overlay.classList.remove("visible");
    const pag = overlay.querySelector("#yt-summarizer-pagination");
    if (pag) pag.style.display = "none";
    const stream = overlay.querySelector("#yt-sum-streaming");
    if (stream) stream.style.display = "none";

    const orb = ensureSiriOrb();
    const title = text ? escapeHtml(text) : "AI is thinking…";
    const subtitle = sub ? escapeHtml(sub) : (text ? "Fetching transcript" : "This may take a few seconds");
    // keep pill fallback hidden
    const pill = document.getElementById("yt-sum-loading-pill");
    if (pill) pill.style.display = "none";

    const textEl = orb.querySelector(".yt-sum-orb-text strong");
    const subEl = orb.querySelector(".yt-sum-orb-text span");
    if (textEl) textEl.textContent = title.replace(/&amp;|&lt;|&gt;/g, (m)=> ({'&amp;':'&','&lt;':'<','&gt;':'>'}[m]||m));
    // Use raw text for orb (already escaped, decode simple)
    if (textEl) textEl.innerHTML = escapeHtml(title);
    if (subEl) { subEl.innerHTML = escapeHtml(subtitle); subEl.style.display = subtitle ? "block" : "none"; }

    // progress ring around orb
    const progText = text && text.includes('/') ? text : sub || "";
    const fg = orb.querySelector(".yt-sum-orb-ring circle.fg");
    const ring = orb.querySelector(".yt-sum-orb-ring");
    if (fg && ring) {
      if (progText && progText.includes('/')) {
        const m = progText.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) {
          const done = parseInt(m[1],10), tot = parseInt(m[2],10);
          const pct = Math.max(0, Math.min(1, done/tot));
          const circumference = 2 * Math.PI * 13; // 81.68
          const offset = circumference * (1 - pct);
          fg.style.strokeDashoffset = String(offset);
          ring.style.opacity = "1";
        } else {
          fg.style.strokeDashoffset = "81.68";
        }
      } else if (sub && (sub.includes("k") || text)) {
        // indeterminate shimmer — keep ring faintly visible
        fg.style.strokeDashoffset = "60";
        ring.style.opacity = "0.9";
      } else {
        fg.style.strokeDashoffset = "81.68";
      }
    }

    orb.style.display = "flex";
    // Position in the horizontal gap between YouTube logo and search bar (as requested)
    const positioned = positionOrbBetweenLogoAndSearch(orb);
    if (!positioned) {
      orb.style.left = "16px";
      orb.style.top = "16px";
      orb.style.right = "auto";
      orb.style.maxWidth = "min(340px, calc(100vw - 32px))";
    }
    // subtle entrance from nothing
    orb.classList.remove("yt-sum-orb-enter");
    void orb.offsetWidth;
    orb.classList.add("yt-sum-orb-enter");
  }

  function navigatePage(dir) {
    if (!lastPages || lastPages.length <= 1) return;
    let newIdx = lastCurrentPage + dir;
    if (newIdx < 0) newIdx = 0;
    if (newIdx >= lastPages.length) newIdx = lastPages.length - 1;
    if (newIdx === lastCurrentPage) return;
    lastCurrentPage = newIdx;
    renderPage(lastCurrentPage);
  }

  function updatePaginationUI() {
    const overlay = document.getElementById("yt-summarizer-overlay");
    if (!overlay) return;
    const pag = overlay.querySelector("#yt-summarizer-pagination");
    const prevBtn = overlay.querySelector("#yt-sum-prev");
    const nextBtn = overlay.querySelector("#yt-sum-next");
    const info = overlay.querySelector("#yt-sum-pageinfo");
    if (!pag || !prevBtn || !nextBtn || !info) return;
    if (!lastPages || lastPages.length <= 1) {
      pag.style.display = "none";
      return;
    }
    pag.style.display = "flex";
    info.textContent = `${lastCurrentPage + 1} / ${lastPages.length}`;
    prevBtn.disabled = lastCurrentPage === 0;
    nextBtn.disabled = lastCurrentPage === lastPages.length - 1;
    // subtle opacity for disabled
    prevBtn.style.opacity = prevBtn.disabled ? "0.35" : "1";
    nextBtn.style.opacity = nextBtn.disabled ? "0.35" : "1";
    prevBtn.style.pointerEvents = prevBtn.disabled ? "none" : "auto";
    nextBtn.style.pointerEvents = nextBtn.disabled ? "none" : "auto";
  }

  function renderPage(idx, animatePop = false) {
    const overlay = ensureContainer();
    const content = overlay.querySelector("#yt-summarizer-content");
    const modal = overlay.querySelector("#yt-summarizer-modal");
    const meta = lastMeta;
    let header = "";
    if (meta && meta.title) {
      const dur = meta.duration ? ` • ${formatDuration(meta.duration)}` : (meta.durationSeconds ? ` • ${formatDuration(meta.durationSeconds)}` : "");
      const ch = meta.channel ? ` • ${escapeHtml(meta.channel)}` : "";
      const pageHint = lastPages.length > 1 ? ` • Page ${idx + 1}/${lastPages.length}` : "";
      header = `<div class="yt-sum-meta"><strong>${escapeHtml(meta.title)}</strong><span>${escapeHtml(dur + ch)}${escapeHtml(pageHint)}</span></div>`;
    }
    const md = lastPages[idx] || "";
    let jumpHtml = "";
    if (meta && meta.segments && meta.segments.length > 6) {
      jumpHtml = buildJumpChips(meta.segments, 14);
    }
    let html = header + jumpHtml + renderMarkdown(md);
    // Show transcript toggle: for paginated, show only on last page or if single page
    const showTranscriptBlock = meta && meta.transcript && (lastPages.length <= 1 || idx === lastPages.length - 1 || idx === 0);
    // We show on first & last to make discoverable; but to avoid duplication we show only on first and last? Simplify: show on all pages but collapsed
    // For now show on last page if paginated, else show anywhere
    const shouldShowTranscript = meta && meta.transcript && (lastPages.length <= 1 || idx === lastPages.length - 1);
    if (shouldShowTranscript) {
      const tr = escapeHtml(meta.transcript.slice(0, 3000) + (meta.transcript.length > 3000 ? " ..." : ""));
      html += `<details class="yt-sum-transcript"><summary>View transcript (auto-generated)</summary><pre class="yt-sum-code" style="white-space:pre-wrap; max-height:180px; overflow:auto;">${tr}</pre><button class="yt-sum-copy-tr" style="margin-top:8px; padding:6px 12px; border-radius:16px; border:1px solid #ddd; background:#fff; cursor:pointer; font-size:12px; font-weight:600;">Copy transcript</button></details>`;
    } else if (meta && meta.transcript && lastPages.length > 1) {
      // subtle hint on other pages
      html += `<div style="margin-top:12px; font-size:11px; color:#888; text-align:center;">Transcript available on last page • ${lastPages.length} pages total</div>`;
    }
    // Ask this video — modal
    html += `<div class="yt-sum-ask-wrap modal" style="margin-top:14px;">
      <input id="yt-sum-ask-input-modal" type="text" placeholder="Ask this video… (e.g. What is the main takeaway?)">
      <button id="yt-sum-ask-btn-modal" title="Ask">Ask</button>
    </div><div id="yt-sum-ask-answer-modal" class="yt-sum-ask-answer" style="display:none"></div>`;
    content.innerHTML = html;
    // Jump chips handler
    content.querySelectorAll(".yt-sum-jump-chip").forEach(btn=>{
      btn.addEventListener("click", () => {
        const s = parseFloat(btn.getAttribute("data-start")||"0");
        seekTo(s);
      });
    });
    const copyTrBtn = content.querySelector(".yt-sum-copy-tr");
    if (copyTrBtn) {
      copyTrBtn.onclick = () => {
        navigator.clipboard.writeText(meta.transcript).then(() => {
          const orig = copyTrBtn.textContent;
          copyTrBtn.textContent = "Copied!";
          setTimeout(() => copyTrBtn.textContent = orig, 1500);
        });
      };
    }
    // Ask handler — modal
    const askInputModal = content.querySelector("#yt-sum-ask-input-modal");
    const askBtnModal = content.querySelector("#yt-sum-ask-btn-modal");
    const askAnswerModal = content.querySelector("#yt-sum-ask-answer-modal");
    const handleAskModal = async () => {
      const q = askInputModal?.value?.trim();
      if (!q) return;
      const videoId = lastVideoId || extractVideoIdFromUrl(location.href) || "";
      if (!videoId) return;
      askAnswerModal.style.display = "block";
      askAnswerModal.innerHTML = `<div class="yt-sum-ask-answer-inner yt-sum-ask-thinking">Thinking…</div>`;
      try {
        const resp = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: "ASK_VIDEO", videoId, question: q, transcript: lastMeta?.transcript || "", title: lastMeta?.title || document.title.replace(" - YouTube","").trim(), channel: lastMeta?.channel || "" }, (res) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (res?.error) reject(new Error(res.error));
            else resolve(res);
          });
        });
        const ans = resp?.answer || "No answer";
        askAnswerModal.innerHTML = `<div class="yt-sum-ask-answer-inner">${renderMarkdown(ans)}</div>`;
        askAnswerModal.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch (e) {
        askAnswerModal.innerHTML = `<div class="yt-sum-ask-answer-inner yt-sum-ask-error">Error: ${escapeHtml(e.message||String(e))}</div>`;
      }
    };
    if (askBtnModal) askBtnModal.addEventListener("click", handleAskModal);
    if (askInputModal) askInputModal.addEventListener("keydown", (e)=>{ if(e.key==="Enter"){ e.preventDefault(); handleAskModal(); } });
    // scroll body to top for new page
    const body = overlay.querySelector("#yt-summarizer-body");
    if (body) body.scrollTop = 0;
    updatePaginationUI();
    const wasVisible = overlay.classList.contains("visible");
    overlay.classList.add("visible");
    // improved pop animation only on first show (from pill → panel), not on pagination
    if (!wasVisible && modal) {
      modal.classList.remove("yt-sum-pop");
      void modal.offsetWidth;
      modal.classList.add("yt-sum-pop");
      setTimeout(() => modal.classList.remove("yt-sum-pop"), 720);
    }
  }

  function setOrbIdle() {
    const orb = document.getElementById("yt-sum-siri-orb");
    if (!orb) return;
    const textEl = orb.querySelector(".yt-sum-orb-text strong");
    const subEl = orb.querySelector(".yt-sum-orb-text span");
    const fg = orb.querySelector(".yt-sum-orb-ring circle.fg");
    if (textEl) textEl.textContent = "AI summary";
    if (subEl) { subEl.textContent = ""; subEl.style.display = "none"; }
    if (fg) fg.style.strokeDashoffset = "56.55";
    const ring = orb.querySelector(".yt-sum-orb-ring");
    if (ring) ring.style.opacity = "0.35";
    orb.style.opacity = "";
    orb.style.transform = "";
  }

  function showSummary(markdown, meta, pagesOverride, isPartial, progress) {
    // keep Siri orb persistent — capture its position for pop origin, then revert to idle after pop
    let orbRect = null;
    const orb = document.getElementById("yt-sum-siri-orb");
    const wasOrbVisible = orb && orb.style.display !== "none" && orb.style.display !== "";
    if (orb && wasOrbVisible) {
      try { orbRect = orb.getBoundingClientRect(); } catch {}
      // subtle pulse to indicate done, but keep visible (persistent embedded)
      orb.style.transform = "scale(1.04)";
      setTimeout(() => { orb.style.transform = ""; }, 180);
    } else if (orb) {
      try { orbRect = orb.getBoundingClientRect(); } catch {}
    }
    const pill = document.getElementById("yt-sum-loading-pill");
    if (pill) pill.style.display = "none";
    // pagesOverride may be array from caller; else use global lastPages
    const overlay = ensureContainer();
    const streamingEl = overlay.querySelector("#yt-sum-streaming");
    // handle streaming banner
    if (isPartial && progress) {
      if (streamingEl) {
        streamingEl.style.display = "block";
        const loaded = progress.loaded || 1, total = progress.total || lastPages.length || "?";
        streamingEl.innerHTML = `⏳ Streaming — <strong>${loaded}/${total}</strong> parts loaded • more pages incoming… <span style="opacity:0.7; font-weight:400;">You can read while rest generates</span>`;
      }
    } else if (streamingEl) {
      streamingEl.style.display = "none";
    }
    // ensure global state synchronized
    if (Array.isArray(pagesOverride) && pagesOverride.length) {
      // for progressive, preserve current page if user already navigated; otherwise stay at 0
      const prevLen = lastPages ? lastPages.length : 0;
      const wasAtLast = lastCurrentPage === prevLen - 1;
      lastPages = pagesOverride;
      // lastMarkdown already set to full joined in message handler; if direct call, join here
      if (!lastMarkdown || lastMarkdown.length < 10 || isPartial) {
        lastMarkdown = pagesOverride.join("\n\n---\n\n");
      }
      // if progressive and new pages added, keep user on same page unless they were at end (auto-advance optional)
      if (isPartial && prevLen > 0) {
        // keep lastCurrentPage as is (don't reset to 0) so user not jolted
        if (lastCurrentPage >= lastPages.length) lastCurrentPage = lastPages.length - 1;
      }
    } else if (markdown && (!lastPages || lastPages.length === 0)) {
      // fallback single page
      if (markdown.length > 6000) {
        lastPages = paginateMarkdownClient(markdown, 6000);
        lastMarkdown = markdown;
      } else {
        lastPages = [markdown];
        lastMarkdown = markdown;
      }
      lastMeta = meta;
    }
    // clamp current page
    if (lastCurrentPage < 0) lastCurrentPage = 0;
    if (lastCurrentPage >= lastPages.length) lastCurrentPage = lastPages.length - 1;
    // make modal pop from Siri orb position (between logo and search) — compute origin towards orb
    const modalForOrigin = overlay.querySelector("#yt-summarizer-modal");
    if (modalForOrigin && wasOrbVisible) {
      try {
        const modalRect = modalForOrigin.getBoundingClientRect();
        if (orbRect) {
          const orbCX = orbRect.left + orbRect.width / 2;
          const orbCY = orbRect.top + orbRect.height / 2;
          let ox = orbCX - modalRect.left;
          let oy = orbCY - modalRect.top;
          // clamp to modal bounds with 16px inset so it stays subtle
          ox = Math.max(16, Math.min(modalRect.width - 16, ox));
          oy = Math.max(16, Math.min(modalRect.height - 16, oy));
          modalForOrigin.style.transformOrigin = `${Math.round(ox)}px ${Math.round(oy)}px`;
        } else {
          modalForOrigin.style.transformOrigin = "18px 18px";
        }
      } catch {
        modalForOrigin.style.transformOrigin = "18px 18px";
      }
      setTimeout(() => { modalForOrigin.style.transformOrigin = ""; }, 720);
    }

    if (!lastPages.length) {
      // empty case fallback
      const content = overlay.querySelector("#yt-summarizer-content");
      let header = "";
      if (meta && meta.title) {
        const dur = meta.duration ? ` • ${formatDuration(meta.duration)}` : (meta.durationSeconds ? ` • ${formatDuration(meta.durationSeconds)}` : "");
        const ch = meta.channel ? ` • ${escapeHtml(meta.channel)}` : "";
        header = `<div class="yt-sum-meta"><strong>${escapeHtml(meta.title)}</strong><span>${escapeHtml(dur + ch)}</span></div>`;
      }
      content.innerHTML = header + renderMarkdown(markdown || "");
      overlay.classList.add("visible");
      const pag = overlay.querySelector("#yt-summarizer-pagination");
      if (pag) pag.style.display = "none";
      // also pop even for empty fallback
      if (modalForOrigin && wasOrbVisible) {
        modalForOrigin.classList.remove("yt-sum-pop");
        void modalForOrigin.offsetWidth;
        modalForOrigin.classList.add("yt-sum-pop");
        setTimeout(() => modalForOrigin.classList.remove("yt-sum-pop"), 720);
      }
      setTimeout(() => setOrbIdle(), 400);
      return;
    }
    renderPage(lastCurrentPage);
    // if this was a partial streaming update, also ensure loading spinner hidden (we're now showing content)
    if (isPartial) {
      updatePaginationUI();
    } else {
      // final summary done — revert orb to idle persistent state (don't hide)
      setTimeout(() => setOrbIdle(), 400);
    }
  }

  function formatDuration(sec) {
    if (!sec) return "";
    const s = parseInt(sec,10);
    const h = Math.floor(s/3600), m=Math.floor((s%3600)/60), sec2=s%60;
    if (h>0) return `${h}:${String(m).padStart(2,"0")}:${String(sec2).padStart(2,"0")}`;
    return `${m}:${String(sec2).padStart(2,"0")}`;
  }
  function formatTimeShort(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s/3600), m=Math.floor((s%3600)/60), sec2=s%60;
    if (h>0) return `${h}:${String(m).padStart(2,"0")}:${String(sec2).padStart(2,"0")}`;
    return `${m}:${String(sec2).padStart(2,"0")}`;
  }
  function seekTo(seconds) {
    try {
      const v = document.querySelector("video");
      if (v) { v.currentTime = seconds; try { v.play(); } catch {} }
      const player = document.getElementById("movie_player");
      if (player && typeof player.seekTo === "function") { try { player.seekTo(seconds, true); } catch {} }
      // also try YouTube's player API via window
      try { const yt = window.ytplayer || window.player; if (yt && yt.seekTo) yt.seekTo(seconds, true); } catch {}
      // scroll to player if not visible
      try { document.querySelector("#movie_player")?.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
    } catch {}
  }
  function buildJumpChips(segments, maxChips = 18) {
    if (!segments || segments.length < 3) return "";
    // group into ~maxChips buckets, pick representative text
    const total = segments.length;
    const step = Math.max(1, Math.floor(total / maxChips));
    let html = `<div class="yt-sum-jump-wrap"><div class="yt-sum-jump-title">Jump to moment</div><div class="yt-sum-jump-chips">`;
    for (let i=0; i<total; i+=step) {
      const seg = segments[i];
      if (!seg || !seg.text) continue;
      const t = formatTimeShort(seg.start || 0);
      const label = seg.text.slice(0, 28).replace(/\s+/g, " ").trim();
      html += `<button class="yt-sum-jump-chip" data-start="${seg.start||0}" title="${escapeHtml(seg.text.slice(0,80))}">${escapeHtml(t)} · ${escapeHtml(label)}${seg.text.length>28?"…":""}</button>`;
      if ((i/step) >= maxChips-1) break;
    }
    html += `</div></div>`;
    return html;
  }

  function showError(error) {
    // keep orb visible but show error state briefly, then revert to idle
    const orb = document.getElementById("yt-sum-siri-orb");
    if (orb) {
      const t = orb.querySelector(".yt-sum-orb-text strong");
      const s = orb.querySelector(".yt-sum-orb-text span");
      if (t) t.textContent = "Error";
      if (s) s.textContent = error.slice(0, 32);
      setTimeout(() => setOrbIdle(), 2500);
    }
    const pill = document.getElementById("yt-sum-loading-pill");
    if (pill) pill.style.display = "none";
    const overlay = ensureContainer();
    const content = overlay.querySelector("#yt-summarizer-content");
    const pag = overlay.querySelector("#yt-summarizer-pagination");
    if (pag) pag.style.display = "none";
    const streamEl = overlay.querySelector("#yt-sum-streaming");
    if (streamEl) streamEl.style.display = "none";
    // reset pagination state so next summary starts fresh
    lastPages = [];
    lastCurrentPage = 0;
    const help = error.includes("API key") ? `<p style="margin-top:10px"><a href="#" id="yt-sum-open-options" style="color:#2a7ae2;text-decoration:underline">Open settings to set API key</a></p>` : "";
    content.innerHTML = `
      <div class="yt-sum-error">
        <div class="yt-sum-error-icon">⚠</div>
        <div>
          <strong>Failed to summarize</strong>
          <p>${escapeHtml(error)}</p>
          ${help}
        </div>
      </div>
    `;
    overlay.classList.add("visible");
    const link = content.querySelector("#yt-sum-open-options");
    if (link) {
      link.onclick = (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
      };
    }
  }

  function renderMarkdown(md) {
    if (!md) return "";
    // Handle fenced code blocks ```...``` first
    const codeBlocks = [];
    let html = md.replace(/```([\s\S]*?)```/g, (match, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(`<pre class="yt-sum-code"><code>${escapeHtml(code.trim())}</code></pre>`);
      return `__CODEBLOCK_${idx}__`;
    });

    // Split into lines, preserve empty for handling
    const lines = html.split("\n");
    let out = "";
    let inList = false;
    let listType = null; // "ul" or "ol"

    function closeList() {
      if (inList) {
        out += listType === "ol" ? "</ol>" : "</ul>";
        inList = false;
        listType = null;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      let raw = lines[i];
      let trimmed = raw.trim();

      // Code block placeholder
      if (/^__CODEBLOCK_\d+__$/.test(trimmed)) {
        closeList();
        const idx = parseInt(trimmed.match(/__CODEBLOCK_(\d+)__/)[1], 10);
        out += codeBlocks[idx];
        continue;
      }
      if (trimmed === "") {
        // empty line: close list but keep paragraph break
        // don't output extra
        continue;
      }
      // Headers
      if (/^#{1,6}\s/.test(trimmed)) {
        closeList();
        const level = trimmed.match(/^#+/)[0].length;
        const text = trimmed.replace(/^#+\s*/, "");
        const tag = level <= 2 ? `h${level}` : "h4";
        const cls = tag === "h2" ? ' class="yt-sum-h2"' : tag === "h3" ? ' class="yt-sum-h3"' : ' class="yt-sum-h4"';
        out += `<${tag}${cls}>${formatInline(text)}</${tag}>`;
        continue;
      }
      // Blockquote
      if (trimmed.startsWith("> ")) {
        closeList();
        out += `<blockquote class="yt-sum-quote">${formatInline(trimmed.slice(2))}</blockquote>`;
        continue;
      }
      // Table-like line with |
      if (trimmed.includes("|") && trimmed.split("|").length >= 3) {
        closeList();
        out += `<div class="yt-sum-table-row">${escapeHtml(trimmed)}</div>`;
        continue;
      }
      // Unordered list
      if (/^[-*•]\s+/.test(trimmed)) {
        const text = trimmed.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "");
        if (!inList || listType !== "ul") {
          closeList();
          out += '<ul class="yt-sum-list">';
          inList = true; listType = "ul";
        }
        out += `<li>${formatInline(text)}</li>`;
        continue;
      }
      // Ordered list
      if (/^\d+[.)]\s+/.test(trimmed)) {
        const text = trimmed.replace(/^\d+[.)]\s+/, "");
        if (!inList || listType !== "ol") {
          closeList();
          out += '<ol class="yt-sum-list ordered">';
          inList = true; listType = "ol";
        }
        out += `<li>${formatInline(text)}</li>`;
        continue;
      }
      // Horizontal rule
      if (/^---+$/.test(trimmed)) {
        closeList();
        out += `<hr class="yt-sum-hr"/>`;
        continue;
      }
      // Default paragraph
      closeList();
      out += `<p class="yt-sum-p">${formatInline(trimmed)}</p>`;
    }
    closeList();
    // Restore any remaining code placeholders missed
    out = out.replace(/__CODEBLOCK_(\d+)__/g, (_, idx) => codeBlocks[idx] || "");
    return out;
  }

  function formatInline(text) {
    let t = escapeHtml(text);
    t = t.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    return t;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function highlightSearchText(raw, qEsc) {
    if (!qEsc) return escapeHtml(raw);
    const re = new RegExp("(" + qEsc + ")", "gi");
    return raw.split(re).map((part, i) => i % 2 === 1 ? `<mark class="yt-sum-hl">${escapeHtml(part)}</mark>` : escapeHtml(part)).join("");
  }

  function highlightInElement(root, qEsc) {
    if (!root || !qEsc) return;
    const testRe = new RegExp(qEsc, "i");
    const splitRe = new RegExp("(" + qEsc + ")", "gi");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (testRe.test(n.nodeValue) && n.parentElement && !["SCRIPT", "STYLE", "MARK"].includes(n.parentElement.tagName)) nodes.push(n);
    }
    nodes.forEach(txt => {
      const frag = document.createDocumentFragment();
      txt.nodeValue.split(splitRe).forEach((part, i) => {
        if (i % 2 === 1) {
          const m = document.createElement("mark");
          m.className = "yt-sum-hl";
          m.textContent = part;
          frag.appendChild(m);
        } else if (part) {
          frag.appendChild(document.createTextNode(part));
        }
      });
      txt.parentNode.replaceChild(frag, txt);
    });
  }

  // ---- persistent embedded orb init (always visible, between logo and search) ----
  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => setTimeout(initPersistentOrb, 700));
    } else {
      setTimeout(initPersistentOrb, 700);
    }
    setTimeout(initPersistentOrb, 1600);
    setTimeout(initPersistentOrb, 3200);
    // YouTube SPA navigation
    window.addEventListener("yt-navigate-finish", () => setTimeout(initPersistentOrb, 600));
    // Fallback interval for late masthead
    let _tries = 0;
    const _interval = setInterval(() => {
      _tries++;
      if (document.querySelector("ytd-masthead #start") && document.getElementById("yt-sum-siri-orb")?.classList.contains("yt-sum-embedded")) {
        clearInterval(_interval);
      } else if (_tries < 10) {
        initPersistentOrb();
      } else {
        clearInterval(_interval);
      }
    }, 1500);
  } catch {}

})();
