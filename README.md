# ⚡ Ultra Downloader Studio v3.0

> **Free, Open-Source 4K Video Downloader, VOD Section Clipper, MP4 Converter & YouTube Tags Analyzer.**

![Ultra Downloader Banner](https://img.shields.io/badge/Ultra%20Downloader-v3.0.0-7c3aed?style=for-the-badge&logo=youtube&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Render](https://img.shields.io/badge/Render-Deploy%20Free-46E3B7?style=for-the-badge&logo=render&logoColor=black)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

---

## ✨ Features

- 🎬 **Quick 4K/1080p Downloader**: Auto-fetches highest resolution video + audio streams from **YouTube**, **TikTok**, **Twitch**, and **Kick**.
- ✂️ **VOD Section Clipper**: Cut precise video segments with timestamp marking directly from an embedded interactive media player.
- 📋 **Multi-Section Batch Clipper**: Download multiple video segments simultaneously from a single long VOD.
- ⚡ **Channel Shorts Harvester**: Bulk download YouTube Shorts from any channel with duration filters and deduplication archives.
- 🎙️ **Audio Silence Cutter**: Automatically detect and remove silent audio pauses using FFmpeg and auto-editor.
- 🔄 **Media MP4 Converter**: Convert MKV, WEBM, MOV, and AVI videos into clean H.264 MP4 format.
- 🏷️ **On-Screen Tags & AI Transcript Extractor**: Instantly extract video tags, channel tags, categories, and AI subtitle transcripts with zero file bloat.

---

## 🛠️ Technology Stack

- **Frontend**: HTML5, Vanilla CSS3 (Glassmorphism & Neon Glow theme), JavaScript (ES6+), FontAwesome Icons
- **Backend**: Node.js HTTP Server (`server.js`), `child_process` execution streaming
- **Core Utilities**: `yt-dlp` (DASH & JS Runtime support), `ffmpeg` (H.264/AAC encoding)
- **Deployment**: Docker (`node:18-bullseye-slim`), Render Web Service

---

## 🚀 Local Quickstart

### Prerequisites
- [Node.js](https://nodejs.org) (v18+)
- [FFmpeg](https://ffmpeg.org)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/ultra-downloader.git

# Navigate to project folder
cd ultra-downloader

# Install Node.js dependencies
npm install

# Start development server
npm run dev
```

Open your browser and navigate to `http://localhost:3005`.

---

## 🌐 Deploy to Render.com (FREE)

This repository includes a pre-configured `Dockerfile` and `.render.yaml` ready for instant zero-config deployment on Render.

1. Fork or push this repository to your **GitHub** account.
2. Sign in to your [Render Dashboard](https://dashboard.render.com).
3. Click **New +** $\rightarrow$ **Web Service**.
4. Connect your `ultra-downloader` repository.
5. Select **Docker** environment and **Free Plan**.
6. Click **Create Web Service**! Render will deploy your live public site in 2-3 minutes.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
