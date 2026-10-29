<div align="center">

# 🧍 ABxAG

### Your private 3D AI desktop companion

[![Website](https://img.shields.io/badge/🌐_Website-abxag.absup.dev-8b5cf6?style=for-the-badge)](https://abxag.absup.dev)
[![Download](https://img.shields.io/badge/⬇_Download-Windows-22d3ee?style=for-the-badge)](https://abxag.absup.dev/DownLoad/)
[![Roadmap](https://img.shields.io/badge/🗺_Roadmap-Live-f472b6?style=for-the-badge)](https://abxag.absup.dev/RoadMap/)
[![Releases](https://img.shields.io/badge/📦_Releases-Latest-34d399?style=for-the-badge)](https://github.com/ABxAG/ABxAG/releases)

[![Version](https://img.shields.io/badge/version-v1.1.29-blue?style=flat-square)](https://github.com/ABxAG/ABxAG/releases/tag/v1.1.29)
[![License](https://img.shields.io/badge/license-Private-red?style=flat-square)]()
[![Platform](https://img.shields.io/badge/platform-Windows_10%2F11-0078D6?style=flat-square&logo=windows)]()
[![Gemini](https://img.shields.io/badge/AI-Gemini_Live-1C7DFF?style=flat-square&logo=google)]()

</div>

---

## ✨ What is ABxAG?

ABxAG is a **private 3D AI desktop companion** for Windows. She's not just a chatbot — she's a real desktop companion that:

| | Feature | Description |
|---|---------|-------------|
| 🎙 | **Voice Conversation** | Talk naturally with Gemini Live. "Hey AB" wake word, reminders & alarms, quiet hours |
| 👁 | **Screen Vision** | With your permission, sees and understands your screen — OCR, vision, screen analysis |
| 🖐 | **Real PC Control** | 96 local tools (apps, files, mouse & keyboard, browser, clipboard) with confirmations & emergency stop |
| 🧠 | **Memory & Mind** | Episodic memory, goals, learned skills, curiosity & presence — all processed locally |
| 🧍 | **Body** | 3D character engine — import any `.pmx / .vrm / .glb / .fbx / .obj` model, `.zip` or folder |
| 🖱 | **Reliable Hands** | Drives your physical mouse with exact text labels, pauses when you touch the PC |
| 🔄 | **Auto-Update** | Hybrid updater: differential installs, version switching, mirror-feed fallback |

## 🛠 Tech Stack

<div align="center">

| Layer | Technology |
|-------|-----------|
| **UI** | React 19 · Vite 6 · Tailwind 4 · Three.js (MMD/PMX) |
| **Backend** | Node + Express + WebSocket · Google GenAI Live bridge |
| **Shell** | Electron 43 · Tray · Crash recovery · Auto-update |
| **Agent** | Python FastAPI desktop tool server (UI Automation, input, files, apps) |
| **Brain** | Local event-driven cognition runtime (memory, goals, skills, presence) |
| **Site** | Static pages → Cloudflare Pages |

</div>

## 📦 Download

<div align="center">

| Platform | Build | Status |
|----------|-------|--------|
| Windows 10/11 64-bit | **Setup** (installer + auto-updates) | ✅ Recommended |
| Windows 10/11 64-bit | **Portable** (single file) | ✅ Available |
| Linux x64 | **AppImage** (experimental, no PC control) | 🧪 Experimental |
| macOS | — | 🔜 Planned |

**→ [Download ABxAG](https://abxag.absup.dev/DownLoad/)**

</div>

## 🔒 Privacy & Safety

- 🔐 Your Gemini key is encrypted with **Windows DPAPI** — never reaches the web page
- 🏠 All AI calls go through your **local backend**
- ✅ High-risk actions ask for **confirmation**
- 🛡️ Websites, documents & screen text are treated as **untrusted data**
- 🚨 Emergency stop shortcut (default `Ctrl+Alt+Shift+S`)
- 📦 **No API key, no character model, no personal data** shipped in the repo

## 🗺 Roadmap

**6 eras shipped:** Voice → Eyes → Hands → Memory & Mind → Body → Co-pilot (dual-cursor + HUD overlay)

**Next:** Full-isolation mode · Voice v2 · Skill sharing · Richer characters
**Exploring:** Phone remote · Beyond Windows

**→ [Full Roadmap](https://abxag.absup.dev/RoadMap/)**

## 🤝 Contributing

1. Work on the **`DEV`** branch (never commit straight to it — open a PR)
2. Branch naming: `feat/<x>`, `fix/<x>` or `chore/<x>`; merge only when **CI is green**
3. Definition of done: `npm run lint` clean, relevant tests green, website changes verified
4. Bigger features get a PRD in `PRD/` + a conductor track in `conductor/tracks/<id>/`

## 📊 Stats

<div align="center">

| Metric | Value |
|--------|-------|
| PC tools built in | **96** |
| Your mouse stays yours | **100%** |
| Cloud accounts needed | **0** |
| Subscriptions required | **0** |

</div>

## 🔗 Links

<div align="center">

[🌐 Website](https://abxag.absup.dev) · [⬇ Download](https://abxag.absup.dev/DownLoad/) · [🗺 Roadmap](https://abxag.absup.dev/RoadMap/) · [📦 Releases](https://github.com/ABxAG/ABxAG/releases) · [👤 Creator](https://github.com/ABsUP)

</div>

---

<div align="center">

*Built with ❤️ by [@ABsUP](https://github.com/ABsUP) · ABxAG is a private 3D AI desktop companion powered by your own Gemini API key.*

</div>