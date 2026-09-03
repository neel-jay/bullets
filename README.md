# YouTube Summarizer — DeepSeek (Chrome Extension)

Right-click any YouTube video → **Summarize** → bullet-point summary via DeepSeek `deepseek-chat`.

## Features

- Context menu `Summarize` on `youtube.com/watch` (right-click video/page)
- Fetches transcript (manual + auto-generated captions) via YouTube timedtext API
- Calls `https://api.deepseek.com/chat/completions` with user-provided API key
- Modal overlay on YouTube page with bulleted summary, Copy button, dark-mode support
- Popup button + Options page to save/test API key (`chrome.storage.sync`)
- Truncates long transcripts to ~12k chars, handles 401/invalid key, missing captions

## File Map

```
bullets/
├── manifest.json   # MV3, contextMenus, storage, scripting, host_permissions
├── background.js   # menu create, transcript fetch, DeepSeek call, messaging
├── content.js      # modal overlay, markdown render, message listener
├── content.css     # modal/loading/error styles
├── options.html    # settings UI
├── options.js      # save/test DeepSeek key
├── popup.html      # extension popup
├── popup.js        # quick summarize + open options
└── icons/          # 16/48/128 PNGs
```

## Install (Developer Mode)

1. Open `chrome://extensions/` → toggle **Developer mode** (top-right)
2. Click **Load unpacked** → select this `bullets` folder
3. Click extension icon → **Set API Key** (or right-click icon → Options)
4. Paste DeepSeek key from https://platform.deepseek.com/api_keys → Save → **Test API key**
5. Open any `https://www.youtube.com/watch?v=...` → **right-click on video** → **Summarize**
6. If menu missing, reload YouTube tab (SPA) after install

## API Key

- Stored only in `chrome.storage.sync`, sent only to `api.deepseek.com`
- Get key: https://platform.deepseek.com/api_keys (starts with `sk-`)
- Model: `deepseek-chat`, `temperature: 0.4`, `max_tokens: 800`

## How Transcript Fetch Works

`background.js:fetchTranscript`

1. Fetch `https://www.youtube.com/watch?v=ID` HTML
2. Regex `/"captionTracks":(\[.*?\])/` → `JSON.parse` → list of `baseUrl` + `languageCode`
3. Prefer `en` / `en-*` else first track, `baseUrl.replace(\\u0026,&)`
4. Fetch `baseUrl` XML → `parseTimedTextXml` via `/<text>(.*?)<\/text>/g` + HTML entity decode
5. Fallbacks: `tryAlternativeTimedText` (`/api/timedtext?lang=en&v=ID`), `&fmt=json3` + `parseJson3`

If no `captionTracks`, throws "No captions available".

## Summarize Prompt

```
System: You are an expert YouTube summarizer...
User: Summarize transcript in 5-10 bullets, 1-2 sentences each, markdown "- " list, no intro/outro
```

Truncates transcript >12k chars.

## Permissions Justification

- `contextMenus` — add Summarize entry
- `storage` — save API key
- `activeTab` + `scripting` — inject modal overlay, ensure content script on SPA nav
- `host_permissions: youtube.com` — fetch watch page + timedtext
- `host_permissions: api.deepseek.com` — chat completions

## Troubleshooting

- **No captions**: video creator disabled captions — try another video with CC
- **401**: invalid/expired DeepSeek key → Options → Test
- **Menu not shown**: ensure URL is `youtube.com/watch?v=ID` and tab reloaded after install
- **Empty summary**: auto-captions garbled — extension infers but may truncate; try manual captions video

## Pack for Distribution

```bash
zip -r bullets.zip . -x "*.git*" "*.DS_Store*"
# Upload zip to chrome://extensions or Chrome Web Store
```
