const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec, execFile, spawn, execSync } = require('child_process');
const crypto = require('crypto');
const urlModule = require('url');

// Token map: token -> { absPath, expires }
const downloadTokens = new Map();

let PORT = parseInt(process.env.PORT, 10) || 3005;
const PUBLIC_DIR = __dirname;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
    try {
        fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    } catch (e) {}
}

let cookiesDisabled = false;

// Initialize cookies on startup once from environment variable if cookies.txt does not exist
const initialCookiesPath = path.join(__dirname, 'cookies.txt');
if (process.env.YOUTUBE_COOKIES && !fs.existsSync(initialCookiesPath)) {
    try {
        let cookieText = process.env.YOUTUBE_COOKIES.trim();
        if (cookieText.startsWith('"') && cookieText.endsWith('"')) cookieText = cookieText.slice(1, -1).trim();
        if (cookieText.startsWith("'") && cookieText.endsWith("'")) cookieText = cookieText.slice(1, -1).trim();
        if (cookieText.includes('\\n')) cookieText = cookieText.replace(/\\n/g, '\n');
        if (cookieText.includes('\\t')) cookieText = cookieText.replace(/\\t/g, '\t');
        if (cookieText.length > 10) {
            fs.writeFileSync(initialCookiesPath, cookieText, 'utf8');
            console.log(`[Cookies] Loaded initial YOUTUBE_COOKIES into cookies.txt (${cookieText.length} bytes)`);
        }
    } catch (e) {
        console.error(`[Cookies Error]: Failed writing initial YOUTUBE_COOKIES: ${e.message}`);
    }
}

function getCookiesFlag(url = '') {
    if (cookiesDisabled) return '';
    // ONLY apply YouTube cookies for YouTube links! (Prevents breaking Twitch, Kick, TikTok, etc.)
    if (url && !url.toLowerCase().includes('youtube.com') && !url.toLowerCase().includes('youtu.be')) {
        return '';
    }

    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesPath)) {
        try {
            const stat = fs.statSync(cookiesPath);
            if (stat.size > 10) {
                return ` --cookies "${cookiesPath}"`;
            }
        } catch (e) {}
    }
    return '';
}

function getBaseYtdlpCmd(url = '') {
    const cookiesFlag = getCookiesFlag(url);
    const impersonateFlag = (url && url.toLowerCase().includes('kick.com')) ? ' --impersonate Chrome' : '';
    const isYouTube = url && (url.toLowerCase().includes('youtube.com') || url.toLowerCase().includes('youtu.be'));
    const clientOverride = isYouTube ? ' --extractor-args "youtube:player_client=ios,android,web_embedded"' : '';
    const ytArgs = isYouTube ? ` --force-ipv4 --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"${clientOverride} --concurrent-fragments 5` : '';
    if (cookiesFlag) {
        return `yt-dlp${cookiesFlag}${impersonateFlag}${ytArgs} --js-runtimes node`;
    }
    return `yt-dlp${impersonateFlag}${ytArgs} --js-runtimes node`;
}

// --- Channel VOD / Highlight / Clip Browser (Twitch + Kick) ---
const channelVideosCache = new Map(); // key -> { expires, data }
const CHANNEL_CACHE_MS = 3 * 60 * 1000;
const PYTHON_BIN = process.platform === 'win32' ? 'python' : 'python3';

// Kick's API sits behind a bot filter that rejects plain Node fetch, so we reuse the
// curl_cffi Chrome impersonation that yt-dlp's --impersonate flag already depends on.
const KICK_FETCH_PY = [
    'import sys, json',
    'from curl_cffi import requests',
    'r = requests.get(sys.argv[1], impersonate="chrome", timeout=20, headers={"Accept": "application/json"})',
    'sys.stdout.write(json.dumps({"status": r.status_code, "body": r.text}))'
].join('\n');

function fetchKickJson(apiUrl) {
    return new Promise((resolve, reject) => {
        execFile(PYTHON_BIN, ['-c', KICK_FETCH_PY, apiUrl], { maxBuffer: 1024 * 1024 * 20, windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
            if (error && !stdout) return reject(new Error((stderr || error.message || 'Kick request failed').trim().split('\n').pop()));
            try {
                const { status, body } = JSON.parse(stdout);
                if (status === 404) return reject(new Error('Kick channel not found.'));
                if (status !== 200) return reject(new Error(`Kick API responded with HTTP ${status}`));
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('Could not parse Kick API response'));
            }
        });
    });
}

async function fetchKickChannelVideos(username, type, range = 'all', cursor = null) {
    const slug = username.toLowerCase().replace(/_/g, '-');
    if (type === 'clips' || type === 'highlights') {
        let kickTime = 'all';
        if (range === '24h' || range === '24hr') kickTime = 'day';
        else if (range === '7d' || range === 'week') kickTime = 'week';
        else if (range === '30d' || range === 'month') kickTime = 'month';
        else if (range === 'all' || range === 'featured') kickTime = 'all';

        let apiUrl = `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/clips?sort=view&time=${kickTime}`;
        if (cursor) {
            apiUrl += `&cursor=${encodeURIComponent(cursor)}`;
        }
        const data = await fetchKickJson(apiUrl);
        const rawClips = Array.isArray(data?.clips) ? data.clips : [];
        let clips = rawClips;

        // If 'featured' filter requested on Kick, prioritize top-viewed/liked clips
        if (range === 'featured') {
            clips = rawClips.filter(c => (c.views ?? c.view_count ?? 0) >= 100 || c.likes > 10);
            if (!clips.length) clips = rawClips.slice(0, 15);
        }

        const videos = clips.map((c, idx) => ({
            id: c.id,
            title: c.title || c.id,
            url: `https://kick.com/${c.channel?.slug || slug}/clips/${c.id}`,
            thumbnail: c.thumbnail_url || '',
            clip_url: c.clip_url || c.video_url || '',
            duration: Number(c.duration) || 0,
            views: c.views ?? c.view_count ?? null,
            date: c.created_at || null,
            isFeatured: range === 'featured' || (c.views ?? c.view_count ?? 0) >= 500 || idx < 3
        }));
        return {
            videos,
            nextCursor: data?.nextCursor ? (typeof data.nextCursor === 'object' ? JSON.stringify(data.nextCursor) : String(data.nextCursor)) : null,
            hasMore: !!data?.nextCursor
        };
    }
    const data = await fetchKickJson(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/videos`);
    const list = Array.isArray(data) ? data : [];
    const videos = list
        .filter(v => v && v.video && v.video.uuid && !v.is_live)
        .map(v => ({
            id: v.video.uuid,
            title: v.session_title || `Kick VOD ${v.video.uuid}`,
            url: `https://kick.com/${slug}/videos/${v.video.uuid}`,
            thumbnail: v.thumbnail?.src || '',
            duration: Math.round((Number(v.duration) || 0) / 1000), // Kick returns ms
            views: v.views ?? v.video.views ?? null,
            date: v.start_time || v.created_at || null
        }));
    return {
        videos,
        hasMore: false
    };
}

let twitchIntegrityCache = null;
let twitchIntegrityPromise = null;

function getTwitchIntegrityHeaders() {
    if (twitchIntegrityCache && twitchIntegrityCache.expires > Date.now()) {
        return Promise.resolve(twitchIntegrityCache.headers);
    }
    if (twitchIntegrityPromise) {
        return twitchIntegrityPromise;
    }

    twitchIntegrityPromise = new Promise((resolve) => {
        const deviceId = crypto.randomBytes(16).toString('hex');
        const fallbackHeaders = {
            'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
            'X-Device-Id': deviceId,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };

        const req = https.request('https://gql.twitch.tv/integrity', {
            method: 'POST',
            headers: {
                'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
                'X-Device-Id': deviceId,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 5000
        }, res => {
            let b = '';
            res.on('data', d => b += d);
            res.on('end', () => {
                try {
                    const data = JSON.parse(b);
                    if (data && data.token) {
                        const headers = {
                            'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
                            'Client-Integrity': data.token,
                            'X-Device-Id': deviceId,
                            'Content-Type': 'application/json',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        };
                        const expires = (data.expiration && data.expiration > Date.now())
                            ? data.expiration - 60000
                            : Date.now() + 3600000;
                        twitchIntegrityCache = { headers, expires };
                        return resolve(headers);
                    }
                } catch (e) {}
                resolve(fallbackHeaders);
            });
        });

        req.on('error', () => resolve(fallbackHeaders));
        req.on('timeout', () => { req.destroy(); resolve(fallbackHeaders); });
        req.end();
    }).finally(() => {
        twitchIntegrityPromise = null;
    });

    return twitchIntegrityPromise;
}

async function fetchTwitchChannelVideos(username, type, range = 'all', page = 1) {
    const cleanUser = String(username || '').toLowerCase().trim().replace(/^@/, '');
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = 30;

    const headers = await getTwitchIntegrityHeaders();

    return new Promise((resolve, reject) => {
        function runGqlQuery(queryBody) {
            return new Promise((resGql, rejGql) => {
                const payload = JSON.stringify({ query: queryBody });
                const req = https.request('https://gql.twitch.tv/gql', {
                    method: 'POST',
                    headers: Object.assign({}, headers, {
                        'Content-Length': Buffer.byteLength(payload)
                    }),
                    timeout: 10000
                }, res => {
                    let b = '';
                    res.on('data', d => b += d);
                    res.on('end', () => {
                        if (res.statusCode !== 200) return rejGql(new Error(`Twitch GQL HTTP ${res.statusCode}`));
                        try {
                            const data = JSON.parse(b);
                            resGql(data);
                        } catch (err) {
                            rejGql(err);
                        }
                    });
                });
                req.on('error', rejGql);
                req.on('timeout', () => { req.destroy(); rejGql(new Error('Twitch GQL timeout')); });
                req.write(payload);
                req.end();
            });
        }

        async function executeGql() {
            if (type === 'clips') {
                let criteriaObj = '{ filter: ALL_TIME }';
                if (range === '24h' || range === '24hr') criteriaObj = '{ filter: LAST_DAY }';
                else if (range === '7d' || range === 'week') criteriaObj = '{ filter: LAST_WEEK }';
                else if (range === '30d' || range === 'month') criteriaObj = '{ filter: LAST_MONTH }';
                else if (range === 'featured') criteriaObj = '{ filter: ALL_TIME, isFeatured: true }';

                const query = `query {
                  user(login: "${cleanUser}") {
                    id login displayName
                    clips(first: 60, criteria: ${criteriaObj}) {
                      edges {
                        node { id slug title durationSeconds viewCount createdAt thumbnailURL url isFeatured }
                      }
                      pageInfo { hasNextPage }
                    }
                  }
                }`;
                const data = await runGqlQuery(query);
                if (data.errors && (!data.data?.user || !data.data.user.clips)) {
                    throw new Error('Twitch clips integrity failure');
                }
                const user = data.data?.user;
                if (!user) throw new Error(`Streamer "${username}" was not found on Twitch`);

                let edges = user.clips?.edges || [];

                // If user selected 'featured' and 0 clips returned from isFeatured: true filter,
                // fallback to ALL_TIME and filter/sort by isFeatured or top views so user always gets content
                if (range === 'featured' && edges.length === 0) {
                    try {
                        const fallbackData = await runGqlQuery(`query {
                          user(login: "${cleanUser}") {
                            clips(first: 60, criteria: { filter: ALL_TIME }) {
                              edges {
                                node { id slug title durationSeconds viewCount createdAt thumbnailURL url isFeatured }
                              }
                            }
                          }
                        }`);
                        const allEdges = fallbackData?.data?.user?.clips?.edges || [];
                        const featEdges = allEdges.filter(e => e.node?.isFeatured);
                        edges = featEdges.length > 0 ? featEdges : allEdges.slice(0, 15);
                    } catch (fbErr) {}
                }

                const videos = edges.map(e => ({
                    id: e.node.slug || e.node.id,
                    title: e.node.title || 'Untitled Clip',
                    url: e.node.url || `https://clips.twitch.tv/${e.node.slug}`,
                    thumbnail: e.node.thumbnailURL || '',
                    duration: Number(e.node.durationSeconds) || 0,
                    views: e.node.viewCount ?? null,
                    date: e.node.createdAt || null,
                    isFeatured: !!e.node.isFeatured
                }));
                return { videos, page: pageNum, hasMore: !!user.clips?.pageInfo?.hasNextPage };
            }

            // VODs (ARCHIVE) or Highlights (HIGHLIGHT)
            const videoType = type === 'highlights' ? 'HIGHLIGHT' : 'ARCHIVE';
            const query = `query {
              user(login: "${cleanUser}") {
                id login displayName
                videos(first: 60, type: ${videoType}) {
                  totalCount
                  edges {
                    node { id title lengthSeconds viewCount createdAt previewThumbnailURL(width: 320, height: 180) }
                  }
                  pageInfo { hasNextPage }
                }
              }
            }`;
            const data = await runGqlQuery(query);

            if (data.errors && (!data.data?.user || !data.data.user.videos)) {
                throw new Error('Twitch videos integrity failure');
            }
            const user = data.data?.user;
            if (!user) throw new Error(`Streamer "${username}" was not found on Twitch`);

            let edges = user.videos?.edges || [];

            // If VODs (ARCHIVE) returned 0 videos, check if the streamer has any general uploaded videos or broadcasts
            if (type === 'vods' && edges.length === 0) {
                try {
                    const fallbackQuery = `query {
                      user(login: "${cleanUser}") {
                        videos(first: 60) {
                          edges {
                            node { id title lengthSeconds viewCount createdAt previewThumbnailURL(width: 320, height: 180) }
                          }
                          pageInfo { hasNextPage }
                        }
                      }
                    }`;
                    const fbData = await runGqlQuery(fallbackQuery);
                    if (fbData?.data?.user?.videos?.edges?.length) {
                        edges = fbData.data.user.videos.edges;
                    }
                } catch (fbErr) {}
            }

            const videos = edges.map(e => ({
                id: String(e.node.id),
                title: e.node.title || `VOD ${e.node.id}`,
                url: `https://www.twitch.tv/videos/${e.node.id}`,
                thumbnail: e.node.previewThumbnailURL || '',
                duration: Number(e.node.lengthSeconds) || 0,
                views: e.node.viewCount ?? null,
                date: e.node.createdAt || null
            }));

            return { videos, page: pageNum, hasMore: !!user.videos?.pageInfo?.hasNextPage };
        }

        executeGql().then(resolve).catch(err => {
            console.log(`[Twitch GQL Warning]: ${err.message}. Falling back to yt-dlp for ${username}...`);
            fallbackYtDlp();
        });

        function fallbackYtDlp() {
            let listUrl;
            if (type === 'clips') {
                const twitchRange = (range === '24h' || range === '24hr') ? '24hr' : (range === '30d' ? '30d' : (range === '7d' ? '7d' : 'all'));
                listUrl = `https://www.twitch.tv/${username}/clips?filter=clips&range=${twitchRange}`;
            } else {
                listUrl = `https://www.twitch.tv/${username}/videos?filter=${type === 'highlights' ? 'highlights' : 'archives'}&sort=time`;
            }

            const startIdx = (pageNum - 1) * pageSize + 1;
            const endIdx = pageNum * pageSize;

            execFile('yt-dlp', ['--flat-playlist', '-J', '-I', `${startIdx}:${endIdx}`, '--no-warnings', listUrl],
                { maxBuffer: 1024 * 1024 * 20, windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
                    if (error || !stdout || !stdout.trim()) {
                        return reject(new Error((stderr || error?.message || `No data returned from Twitch for ${username}`).trim().split('\n').pop()));
                    }
                    try {
                        const info = JSON.parse(stdout);
                        const entries = Array.isArray(info.entries) ? info.entries : [];
                        const videos = entries.filter(e => e && e.url).map(e => ({
                            id: String(e.id || '').replace(/^v/, ''),
                            title: e.title || e.id,
                            url: e.url,
                            thumbnail: e.thumbnail || '',
                            duration: Number(e.duration) || 0,
                            views: e.view_count ?? null,
                            date: e.timestamp ? new Date(e.timestamp * 1000).toISOString() : null
                        }));
                        resolve({
                            videos,
                            page: pageNum,
                            hasMore: videos.length === pageSize
                        });
                    } catch (e) {
                        reject(new Error('Could not parse Twitch channel listing'));
                    }
                });
        }
    });
}

// --- Direct Clip Video Stream Preview Cache ---
const clipPreviewCache = new Map(); // slug -> { expires, url }
const CLIP_PREVIEW_CACHE_MS = 30 * 60 * 1000;

async function fetchTwitchClipPreviewUrl(slug) {
    const cleanSlug = String(slug || '').trim().replace(/^.*\/clip\//, '').replace(/\?.*$/, '');
    if (!cleanSlug) throw new Error('Clip slug required');
    const cached = clipPreviewCache.get(cleanSlug);
    if (cached && cached.expires > Date.now()) return cached.url;

    const deviceId = crypto.randomBytes(16).toString('hex');
    const payload = JSON.stringify({
        query: `query {
          clip(slug: "${cleanSlug.replace(/"/g, '')}") {
            playbackAccessToken(params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) {
              value
              signature
            }
            videoQualities {
              quality
              sourceURL
            }
          }
        }`
    });

    return new Promise((resolve, reject) => {
        const req = https.request('https://gql.twitch.tv/gql', {
            method: 'POST',
            headers: {
                'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
                'X-Device-Id': deviceId,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 7000
        }, res => {
            let b = '';
            res.on('data', c => b += c);
            res.on('end', () => {
                try {
                    const data = JSON.parse(b);
                    const clip = data.data?.clip;
                    if (!clip || !clip.playbackAccessToken || !clip.videoQualities?.length) {
                        return reject(new Error('Clip playback stream not found'));
                    }
                    const token = encodeURIComponent(clip.playbackAccessToken.value);
                    const sig = clip.playbackAccessToken.signature;
                    // Prefer 480 or 360 for high-performance instant thumbnail hover preview
                    const q = clip.videoQualities.find(v => v.quality === '480') ||
                              clip.videoQualities.find(v => v.quality === '360') ||
                              clip.videoQualities[clip.videoQualities.length - 1];
                    const directUrl = `${q.sourceURL}?sig=${sig}&token=${token}`;
                    clipPreviewCache.set(cleanSlug, { expires: Date.now() + CLIP_PREVIEW_CACHE_MS, url: directUrl });
                    resolve(directUrl);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Twitch clip preview timeout')); });
        req.write(payload);
        req.end();
    });
}

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function processLogs(rawText, defaultType = 'info') {
    if (!rawText) return [];
    const rawLines = rawText.split(/[\r\n]+/);
    const logs = [];
    let lastProgressIndex = -1;

    for (let line of rawLines) {
        line = line.trim();
        if (!line) continue;

        // Filter and update progress lines to prevent thousands of duplicate DOM lines
        if (line.startsWith('[download]') && line.includes('%')) {
            if (lastProgressIndex !== -1) {
                logs[lastProgressIndex] = { text: line, type: 'info', isProgress: true };
            } else {
                lastProgressIndex = logs.length;
                logs.push({ text: line, type: 'info', isProgress: true });
            }
        } else {
            lastProgressIndex = -1;
            logs.push({ text: line, type: defaultType });
        }
    }
    return logs;
}

const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = parsedUrl.pathname;

    // SEO Robots.txt for Google Indexing
    if (pathname === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end("User-agent: *\nAllow: /\nSitemap: https://ultdownloader.onrender.com/sitemap.xml");
    }

    // Dynamic SEO XML Sitemap
    if (pathname === '/sitemap.xml') {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://ultdownloader.onrender.com/</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`);
    }

    // API Downloads List
    if (pathname === '/api/downloads' && req.method === 'GET') {
        try {
            const downloadsDir = path.join(__dirname, 'downloads');
            if (!fs.existsSync(downloadsDir)) {
                fs.mkdirSync(downloadsDir, { recursive: true });
            }

            const files = [];

            const scanDir = (dirPath) => {
                const items = fs.readdirSync(dirPath, { withFileTypes: true });
                for (const item of items) {
                    const fullPath = path.join(dirPath, item.name);
                    if (item.isDirectory()) {
                        scanDir(fullPath);
                    } else if (item.isFile()) {
                        if (item.name.endsWith('.part') || item.name.endsWith('.ytdl') || item.name.startsWith('.')) continue;

                        const stats = fs.statSync(fullPath);
                        const relPath = path.relative(downloadsDir, fullPath).replace(/\\/g, '/');

                        files.push({
                            name: item.name,
                            relPath: relPath,
                            size: stats.size,
                            mtime: stats.mtimeMs
                        });
                    }
                }
            };

            scanDir(downloadsDir);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ totalFiles: files.length, files }, null, 2));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    // API Health Check
    if (pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', server: 'ULTDownloader Backend', uptime: process.uptime() }));
    }

    // API Channel Video Browser: list a streamer's VODs / highlights / clips on Twitch or Kick
    if (pathname === '/api/channel-videos' && req.method === 'GET') {
        const platform = (parsedUrl.searchParams.get('platform') || '').toLowerCase();
        const username = (parsedUrl.searchParams.get('username') || '').trim().replace(/^@/, '');
        const type = (parsedUrl.searchParams.get('type') || 'vods').toLowerCase();
        const range = (parsedUrl.searchParams.get('range') || 'all').toLowerCase();
        const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10) || 1;
        const cursor = parsedUrl.searchParams.get('cursor') || null;

        const sendJson = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
        };

        if (!['twitch', 'kick'].includes(platform)) return sendJson(400, { success: false, error: 'platform must be twitch or kick' });
        if (!['vods', 'highlights', 'clips'].includes(type)) return sendJson(400, { success: false, error: 'type must be vods, highlights or clips' });
        if (!/^[A-Za-z0-9_-]{2,30}$/.test(username)) return sendJson(400, { success: false, error: 'Invalid username' });

        const cacheKey = `${platform}:${username.toLowerCase()}:${type}:${range}:${page}:${cursor || ''}`;
        const cached = channelVideosCache.get(cacheKey);
        if (cached && cached.expires > Date.now()) return sendJson(200, cached.data);

        console.log(`[Server Channel Browser]: ${platform} / ${username} / ${type} / range=${range} / page=${page}`);
        const loader = platform === 'kick'
            ? fetchKickChannelVideos(username, type, range, cursor)
            : fetchTwitchChannelVideos(username, type, range, page);

        loader.then(result => {
            const data = {
                success: true,
                platform,
                username,
                type,
                range,
                videos: result.videos || [],
                hasMore: !!result.hasMore,
                page: result.page || page,
                nextCursor: result.nextCursor || null
            };
            if (data.videos && data.videos.length > 0) {
                channelVideosCache.set(cacheKey, { expires: Date.now() + CHANNEL_CACHE_MS, data });
            }
            for (const [k, v] of channelVideosCache) if (v.expires < Date.now()) channelVideosCache.delete(k);
            sendJson(200, data);
        }).catch(err => {
            console.error(`[Server Channel Browser Error]: ${err.message}`);
            sendJson(200, { success: false, platform, username, type, range, error: err.message });
        });
        return;
    }

    // API Direct Clip Preview (High-Performance HTML5 MP4 Stream URL)
    if (pathname === '/api/clip-preview' && req.method === 'GET') {
        const slug = (parsedUrl.searchParams.get('slug') || '').trim();
        const platform = (parsedUrl.searchParams.get('platform') || 'twitch').toLowerCase();

        if (!slug) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Slug parameter is required' }));
        }

        if (platform === 'twitch') {
            fetchTwitchClipPreviewUrl(slug).then(previewUrl => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, platform, slug, previewUrl }));
            }).catch(err => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            });
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Platform not supported for direct preview' }));
        return;
    }

    // API Command Execution Endpoint (Chunked Real-Time Progress Stream)
    if (pathname === '/api/execute' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { command } = JSON.parse(body);
                if (!command) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Command required' }));
                }

                let finalCommand = command;
                if (finalCommand.includes('yt-dlp')) {
                    const isYT = finalCommand.toLowerCase().includes('youtube.com') || finalCommand.toLowerCase().includes('youtu.be');
                    if (!finalCommand.includes('--impersonate') && finalCommand.toLowerCase().includes('kick.com')) {
                        finalCommand = finalCommand.replace(/\byt-dlp\b/g, 'yt-dlp --impersonate Chrome');
                    }
                    if (!finalCommand.includes('--js-runtimes')) {
                        finalCommand = finalCommand.replace(/\byt-dlp\b/g, 'yt-dlp --js-runtimes node');
                    }
                    const cookiesFlag = getCookiesFlag(finalCommand);
                    if (cookiesFlag && !finalCommand.includes('--cookies')) {
                        finalCommand = finalCommand.replace(/\byt-dlp\b/g, `yt-dlp${cookiesFlag}`);
                    }
                    if (isYT) {
                        if (!finalCommand.includes('--force-ipv4')) {
                            finalCommand = finalCommand.replace(/\byt-dlp\b/g, 'yt-dlp --force-ipv4');
                        }
                        if (!finalCommand.includes('--user-agent')) {
                            finalCommand = finalCommand.replace(/\byt-dlp\b/g, 'yt-dlp --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"');
                        }
                        if (!finalCommand.includes('--concurrent-fragments')) {
                            finalCommand = finalCommand.replace(/\byt-dlp\b/g, 'yt-dlp --concurrent-fragments 5');
                        }
                        if (!finalCommand.includes('--extractor-args')) {
                            finalCommand = finalCommand.replace(/\byt-dlp\b/g, 'yt-dlp --extractor-args "youtube:player_client=ios,android,web_embedded"');
                        }
                    }
                }

                // Parse target section duration for accurate live percentage calculation on long clips
                let sectionDurationSec = 0;
                const sectionMatch = finalCommand.match(/--download-sections\s+["']?\*?([0-9:]+(?:\.[0-9]+)?)-([0-9:]+(?:\.[0-9]+)?)/i);
                if (sectionMatch) {
                    const parseTimeToSec = (tStr) => {
                        const parts = (tStr || '').trim().split(':').map(Number);
                        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
                        if (parts.length === 2) return parts[0] * 60 + parts[1];
                        return parseFloat(tStr) || 0;
                    };
                    const sStart = parseTimeToSec(sectionMatch[1]);
                    const sEnd = parseTimeToSec(sectionMatch[2]);
                    if (sEnd > sStart) {
                        sectionDurationSec = sEnd - sStart;
                        console.log(`[Server] Detected clip target duration: ${sectionDurationSec}s (${sectionMatch[1]} to ${sectionMatch[2]})`);
                    }
                }

                console.log(`[Server Executing Command Stream]: ${finalCommand}`);

                res.writeHead(200, {
                    'Content-Type': 'application/x-ndjson; charset=utf-8',
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });

                // Send immediate feedback so user sees activity instantly
                res.write(JSON.stringify({
                    text: '[Download Initiated] Connecting to stream & buffering media segments...',
                    type: 'system',
                    percent: 0.1,
                    speed: '--',
                    eta: '--'
                }) + '\n');

                const child = exec(finalCommand, { maxBuffer: 1024 * 1024 * 50, windowsHide: true });

                let hasInvalidCookies = false;

                const handleOutput = (data, defaultType = 'info') => {
                    const text = data.toString();
                    if (text.includes('cookies are no longer valid')) {
                        hasInvalidCookies = true;
                    }
                    const lines = text.split(/[\r\n]+/);
                    
                    lines.forEach(line => {
                        const trimmed = line.trim();
                        if (!trimmed) return;

                        // Filter out repetitive HLS manifest skip spam (can be 2,000+ lines on long VODs)
                        if (trimmed.startsWith('[hls @') && (trimmed.includes('Skip') || trimmed.includes('#EXT-X-'))) {
                            return;
                        }

                        let percentMatch = trimmed.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
                        let speedMatch = trimmed.match(/at\s+([0-9\.]+\s*[KMGk]?i?B\/s)/i) || trimmed.match(/speed=\s*([0-9\.]+\s*x)/i);
                        let etaMatch = trimmed.match(/ETA\s+([0-9:]+)/i);

                        // If downloading section via ffmpeg (Twitch/Kick HLS chunk downloader)
                        // ffmpeg outputs: frame=  525 fps=340 q=-1.0 size= 6656KiB time=00:00:02.49 bitrate=... speed=1.62x
                        if (trimmed.includes('time=') && (trimmed.includes('frame=') || trimmed.includes('size='))) {
                            const timeMatch = trimmed.match(/time=\s*([0-9:]+(?:\.[0-9]+)?)/i);
                            const ffmpegSpeedMatch = trimmed.match(/speed=\s*([0-9\.]+)x/i);

                            if (timeMatch) {
                                const parseTimeToSec = (tStr) => {
                                    const parts = (tStr || '').trim().split(':').map(Number);
                                    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
                                    if (parts.length === 2) return parts[0] * 60 + parts[1];
                                    return parseFloat(tStr) || 0;
                                };
                                const curSec = parseTimeToSec(timeMatch[1]);
                                if (sectionDurationSec > 0) {
                                    const calcPercent = Math.min(99.9, Math.max(0.1, (curSec / sectionDurationSec) * 100));
                                    percentMatch = [null, calcPercent.toFixed(1)];

                                    if (ffmpegSpeedMatch) {
                                        const speedMultiplier = parseFloat(ffmpegSpeedMatch[1]) || 1;
                                        speedMatch = [null, `${ffmpegSpeedMatch[1]}x`];
                                        if (speedMultiplier > 0) {
                                            const remainingSec = Math.max(0, sectionDurationSec - curSec);
                                            const etaSeconds = Math.round(remainingSec / speedMultiplier);
                                            const m = Math.floor(etaSeconds / 60).toString().padStart(2, '0');
                                            const s = (etaSeconds % 60).toString().padStart(2, '0');
                                            etaMatch = [null, `${m}:${s}`];
                                        }
                                    }
                                } else {
                                    percentMatch = [null, Math.min(99, Math.floor(curSec)).toString()];
                                }
                            }
                        }

                        let logType = defaultType;
                        if (trimmed.includes('[Ready]') || trimmed.includes('100%')) logType = 'success';
                        else if (trimmed.includes('[Error]') || trimmed.includes('ERROR:')) logType = 'error';

                        const payload = {
                            text: trimmed,
                            type: logType,
                            percent: percentMatch ? parseFloat(percentMatch[1]) : null,
                            speed: speedMatch ? speedMatch[1] : null,
                            eta: etaMatch ? etaMatch[1] : null
                        };

                        res.write(JSON.stringify(payload) + '\n');
                    });
                };

                if (child.stdout) child.stdout.on('data', d => handleOutput(d, 'info'));
                if (child.stderr) child.stderr.on('data', d => handleOutput(d, 'system'));

                child.on('close', (code) => {
                    if (hasInvalidCookies) {
                        try {
                            const cookiesPath = path.join(__dirname, 'cookies.txt');
                            if (fs.existsSync(cookiesPath)) {
                                fs.unlinkSync(cookiesPath);
                                console.log('[Cookies] Auto-deleted expired cookies.txt file.');
                            }
                        } catch (e) {}
                    }
                    // Detect the output file that was written to downloads/
                    let outputFile = null;
                    if (code === 0) {
                        try {
                            const downloadsDir = path.join(__dirname, 'downloads');
                            const allFiles = [];
                            function scanDir(dir) {
                                const entries = fs.readdirSync(dir, { withFileTypes: true });
                                entries.forEach(e => {
                                    const full = path.join(dir, e.name);
                                    if (e.isDirectory()) scanDir(full);
                                    else {
                                        const stat = fs.statSync(full);
                                        if (stat.mtimeMs > Date.now() - 120000) { // modified in last 2 minutes
                                            allFiles.push({ p: full, t: stat.mtimeMs });
                                        }
                                    }
                                });
                            }
                            if (fs.existsSync(downloadsDir)) scanDir(downloadsDir);
                            if (allFiles.length > 0) {
                                allFiles.sort((a, b) => b.t - a.t);
                                outputFile = allFiles[0].p.replace(__dirname + path.sep, '').replace(/\\/g, '/');
                            }
                        } catch (e) {}
                    }
                    // Combine done + token into a SINGLE packet to avoid client missing it
                    let downloadToken = null;
                    let fileName = null;
                    if (code === 0 && outputFile) {
                        const absFilePath = path.join(__dirname, outputFile);
                        console.log(`[Server] Output file: ${absFilePath}, exists: ${fs.existsSync(absFilePath)}`);
                        if (fs.existsSync(absFilePath)) {
                            downloadToken = crypto.randomBytes(16).toString('hex');
                            fileName = path.basename(absFilePath);
                            downloadTokens.set(downloadToken, { absPath: absFilePath, expires: Date.now() + 300000 });
                            console.log(`[Server] Token created: ${downloadToken} for file: ${fileName}`);
                            // Clean up expired tokens
                            for (const [k, v] of downloadTokens) {
                                if (v.expires < Date.now()) downloadTokens.delete(k);
                            }
                        }
                    }
                    res.write(JSON.stringify({ done: true, exitCode: code, outputFile, downloadToken, fileName }) + '\n');
                    res.end();
                });

                child.on('error', (err) => {
                    res.write(JSON.stringify({ text: `Execution Error: ${err.message}`, type: 'error', done: true }) + '\n');
                    res.end();
                });

            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid payload' }));
            }
        });
        return;
    }

    // API Download File to Browser Endpoint (token-based, avoids filename encoding issues)
    if (pathname === '/api/download-file' && req.method === 'GET') {
        const query = urlModule.parse(req.url, true).query;
        const token = query.token || '';
        console.log(`[DownloadFile] req.url=${req.url} token=${token} mapSize=${downloadTokens.size}`);
        if (!token) {
            console.log('[DownloadFile] 400: no token in request');
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Missing token');
        }
        const entry = downloadTokens.get(token);
        if (!entry) {
            console.log(`[DownloadFile] 404: token not found. Known tokens: ${[...downloadTokens.keys()].join(', ')}`);
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Token not found or expired');
        }
        const absPath = entry.absPath;
        console.log(`[DownloadFile] Serving: ${absPath}`);
        if (!absPath.startsWith(path.join(__dirname, 'downloads'))) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            return res.end('Forbidden');
        }
        if (!fs.existsSync(absPath)) {
            downloadTokens.delete(token);
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('File not found on disk');
        }
        downloadTokens.delete(token); // one-time use
        const stat = fs.statSync(absPath);
        const ext = path.extname(absPath).toLowerCase();
        const mimeMap = { '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.m4a': 'audio/m4a', '.wav': 'audio/wav' };
        const mime = mimeMap[ext] || 'application/octet-stream';
        const safeFilename = path.basename(absPath).replace(/[";\\]/g, '_');
        res.writeHead(200, {
            'Content-Type': mime,
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
            'Content-Length': stat.size
        });
        const stream = fs.createReadStream(absPath);
        stream.pipe(res);
        // Delete file from Render disk after fully sent
        stream.on('end', () => {
            fs.unlink(absPath, (err) => {
                if (!err) console.log(`[Server] Deleted from disk: ${path.basename(absPath)}`);
                else console.log(`[Server] Delete failed: ${err.message}`);
            });
        });
        return;
    }

    // API Check File Existence Endpoint
    if (pathname === '/api/check-file' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { filePath } = JSON.parse(body);
                if (!filePath) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'filePath required' }));
                }

                let targetPath = filePath;
                if (targetPath.startsWith('%USERPROFILE%')) {
                    targetPath = targetPath.replace('%USERPROFILE%', process.env.USERPROFILE || '');
                }
                const resolvedPath = path.isAbsolute(targetPath) ? targetPath : path.join(PUBLIC_DIR, targetPath);

                const exists = fs.existsSync(resolvedPath);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, exists, fileName: path.basename(resolvedPath) }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid payload' }));
            }
        });
        return;
    }

function parseTimestampToSeconds(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return Math.max(0, ts);
    const str = String(ts).trim();
    if (!str) return 0;
    const parts = str.split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    } else if (parts.length === 1) {
        return parts[0];
    }
    return 0;
}

function fetchWithRedirects(targetUrl, headers = {}, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

        const client = targetUrl.startsWith('https') ? https : http;
        client.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cookie': 'CONSENT=PENDING+999; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg; PREF=hl=en',
                ...headers
            }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let redirectUrl = res.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    const u = new URL(targetUrl);
                    redirectUrl = `${u.protocol}//${u.host}${redirectUrl}`;
                }
                return resolve(fetchWithRedirects(redirectUrl, headers, maxRedirects - 1));
            }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        }).on('error', reject);
    });
}

const ytStoryboardCache = new Map();

function getYouTubeStoryboard(videoId) {
    if (ytStoryboardCache.has(videoId)) {
        return ytStoryboardCache.get(videoId);
    }

    let ytdlpErr = '';
    // 1. Try yt-dlp ios,android,web_embedded client (extracts full storyboard specs without bot challenges)
    try {
        const ytdlpBin = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp';
        const cookiesFlag = getCookiesFlag('https://www.youtube.com');
        const cmd = `${ytdlpBin}${cookiesFlag} --dump-json --skip-download --force-ipv4 --no-warnings --extractor-args "youtube:player_client=ios,android,web_embedded" "https://www.youtube.com/watch?v=${videoId}"`;
        const out = execSync(cmd, { maxBuffer: 25 * 1024 * 1024, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        const data = JSON.parse(out);
        const storyboards = (data.formats || []).filter(f => f.format_note === 'storyboard');
        if (storyboards && storyboards.length > 0) {
            storyboards.sort((a, b) => (b.width || 0) - (a.width || 0));
            const best = storyboards[0];
            if (best && best.fragments && best.fragments.length > 0) {
                const sbInfo = {
                    type: 'fragments',
                    width: best.width || 320,
                    height: best.height || 180,
                    rows: best.rows || 3,
                    columns: best.columns || 3,
                    fragments: best.fragments
                };
                ytStoryboardCache.set(videoId, sbInfo);
                return sbInfo;
            }
        }
    } catch (e) {
        ytdlpErr = (e.stderr ? e.stderr.toString() : e.message).slice(0, 300);
        console.warn(`[yt-dlp Storyboard Warning]: ${ytdlpErr}. Trying fallback...`);
    }

    // 2. Fallback: Parse watch page HTML
    let html = '';
    let curlErr = '';
    try {
        const curlCmd = `curl -sL -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -b "CONSENT=PENDING+999; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg" "https://www.youtube.com/watch?v=${videoId}"`;
        html = execSync(curlCmd, { maxBuffer: 15 * 1024 * 1024, encoding: 'utf8' });
    } catch (err) {
        curlErr = err.message;
        console.error(`[Storyboard Curl Error]: ${curlErr}`);
    }

    const specMatch = html.match(/"spec":\s*"([^"]+)"/);
    if (!specMatch) {
        throw new Error(`Storyboard unavailable (ytdlp: ${ytdlpErr || 'none'}, curl: ${curlErr || 'no spec match'})`);
    }

    const rawSpec = specMatch[1];
    const parts = rawSpec.split('|');
    const baseUrl = parts[0];

    let bestLevel = null;
    let bestWidth = 0;

    for (let i = 1; i < parts.length; i++) {
        const segs = parts[i].split('#');
        if (segs.length < 8) continue;
        const width = parseInt(segs[0], 10);
        const height = parseInt(segs[1], 10);
        const count = parseInt(segs[2], 10);
        const cols = parseInt(segs[3], 10);
        const rows = parseInt(segs[4], 10);
        const interval = parseInt(segs[5], 10);
        const template = segs[6];
        const sigh = segs[7];

        if (width > bestWidth) {
            bestWidth = width;
            bestLevel = { width, height, count, cols, rows, interval, template, sigh, levelIndex: i - 1, baseUrl };
        }
    }

    if (!bestLevel) throw new Error('Could not parse storyboard spec levels');
    const sbInfo = { type: 'spec', ...bestLevel };
    ytStoryboardCache.set(videoId, sbInfo);
    return sbInfo;
}

async function extractYouTubeTimestampFrame(videoId, targetSeconds) {
    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
    const outFilename = `frame_${videoId}_${targetSeconds}s.jpg`;
    const outFilePath = path.join(downloadsDir, outFilename);

    const formatSeconds = (sec) => {
        const s = Math.max(0, Math.floor(sec || 0));
        const hrs = Math.floor(s / 3600);
        const mins = Math.floor((s % 3600) / 60);
        const secs = s % 60;
        return [
            String(hrs).padStart(2, '0'),
            String(mins).padStart(2, '0'),
            String(secs).padStart(2, '0')
        ].join(':');
    };
    const tsFormatted = formatSeconds(targetSeconds);

    // METHOD 1: Direct stream URL extraction via Android client + FFmpeg
    // Android client is not blocked by datacenter IPs and ffmpeg captures the 100% exact video frame
    let streamErrDetail = '';
    try {
        console.log(`[Frame Extract] Attempting direct stream extraction for ${videoId} at ${tsFormatted}...`);
        const ytdlpBin = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp';
        const cookiesFlag = getCookiesFlag('https://www.youtube.com');
        
        let streamUrl = '';
        // Try first with cookies (if available), then without cookies
        const attempts = [cookiesFlag, ''];
        for (const cFlag of attempts) {
            try {
                const streamCmd = `${ytdlpBin}${cFlag} -g -f "18/best[height<=720]/best" --force-ipv4 --no-warnings --extractor-args "youtube:player_client=android" "https://www.youtube.com/watch?v=${videoId}"`;
                const streamUrlRaw = execSync(streamCmd, { encoding: 'utf8', timeout: 25000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
                const matched = streamUrlRaw.match(/https?:\/\/[^\r\n]+/);
                if (matched && matched[0]) {
                    streamUrl = matched[0];
                    break;
                }
            } catch (attErr) {
                streamErrDetail = attErr.message;
            }
        }

        if (streamUrl && streamUrl.startsWith('http')) {
            console.log(`[Frame Extract] Stream URL acquired, extracting exact frame with FFmpeg at ${tsFormatted}...`);
            const ffmpegCmd = `ffmpeg -y -user_agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" -ss ${tsFormatted} -i "${streamUrl}" -vframes 1 -vf "scale=1280:720:flags=lanczos,unsharp=5:5:0.8:5:5:0.0" -q:v 2 -update 1 "${outFilePath}"`;
            execSync(ffmpegCmd, { timeout: 25000, stdio: ['pipe', 'pipe', 'pipe'] });

            if (fs.existsSync(outFilePath) && fs.statSync(outFilePath).size > 1000) {
                console.log(`[Frame Extract Success] Exact direct frame generated: ${fs.statSync(outFilePath).size} bytes`);
                const base64Data = fs.readFileSync(outFilePath).toString('base64');
                return {
                    filename: outFilename,
                    base64Url: `data:image/jpeg;base64,${base64Data}`,
                    width: 1280,
                    height: 720
                };
            }
        }
    } catch (streamErr) {
        streamErrDetail = streamErr.message;
        console.warn(`[Frame Extract Notice]: Direct stream extraction failed (${streamErr.message}). Trying storyboard fallback...`);
    }

    // METHOD 2: Storyboard sheet extraction fallback
    const sb = getYouTubeStoryboard(videoId);

    let sheetUrl = '';
    let cropX = 0;
    let cropY = 0;
    let cellW = 320;
    let cellH = 180;

    if (sb.type === 'fragments') {
        cellW = sb.width || 320;
        cellH = sb.height || 180;
        let accumulated = 0;
        let targetFrag = sb.fragments[0];

        for (let i = 0; i < sb.fragments.length; i++) {
            const f = sb.fragments[i];
            if (accumulated + f.duration >= targetSeconds || i === sb.fragments.length - 1) {
                targetFrag = f;
                break;
            }
            accumulated += f.duration;
        }

        const timeInFrag = Math.max(0, targetSeconds - accumulated);
        const framesPerSheet = sb.rows * sb.columns;
        const frameDuration = targetFrag.duration / framesPerSheet;
        const frameIndexInSheet = Math.min(Math.floor(timeInFrag / (frameDuration || 1)), framesPerSheet - 1);
        const col = frameIndexInSheet % sb.columns;
        const row = Math.floor(frameIndexInSheet / sb.columns);

        cropX = col * cellW;
        cropY = row * cellH;
        sheetUrl = targetFrag.url;
    } else {
        cellW = sb.width || 320;
        cellH = sb.height || 180;
        const frameDurationSec = sb.interval > 0 ? (sb.interval / 1000) : 1.0;
        const frameIndex = Math.min(Math.floor(targetSeconds / frameDurationSec), Math.max(0, sb.count - 1));
        const framesPerSheet = sb.cols * sb.rows;
        const sheetIndex = Math.floor(frameIndex / framesPerSheet);
        const frameInSheet = frameIndex % framesPerSheet;
        const col = frameInSheet % sb.cols;
        const row = Math.floor(frameInSheet / sb.cols);

        cropX = col * cellW;
        cropY = row * cellH;

        const sheetName = sb.template === 'default' ? 'default' : `M${sheetIndex}`;
        sheetUrl = sb.baseUrl.replace('$L', sb.levelIndex).replace('$N', sheetName);
        if (sheetUrl.includes('$M')) sheetUrl = sheetUrl.replace('$M', sheetIndex);
        if (sb.sigh) sheetUrl += (sheetUrl.includes('?') ? '&' : '?') + `sigh=${sb.sigh}`;
    }

    const tempSheet = path.join(downloadsDir, `temp_sb_${videoId}_${Date.now()}.jpg`);

    try {
        // Download storyboard sheet via native https (prevents shell $ variable expansion corruption in sigh signature)
        const sheetBuf = await new Promise((resolve, reject) => {
            const req = https.get(sheetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
                }
            }, res => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`Storyboard CDN returned HTTP ${res.statusCode}`));
                }
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    if (buf.length < 500) {
                        return reject(new Error('Storyboard sheet download too small'));
                    }
                    // Validate JPEG header: 0xFF 0xD8
                    if (buf[0] !== 0xFF || buf[1] !== 0xD8) {
                        return reject(new Error(`Storyboard file is not a valid JPEG (received ${buf.slice(0, 30).toString()})`));
                    }
                    resolve(buf);
                });
            });
            req.on('error', reject);
            req.setTimeout(12000, () => { req.destroy(); reject(new Error('Storyboard download timeout')); });
        });

        fs.writeFileSync(tempSheet, sheetBuf);

        // Crop exact frame and upscale with Lanczos interpolation + unsharp edge filter to crisp 1280x720 HD
        const cmd = `ffmpeg -y -i "${tempSheet}" -vf "crop=${cellW}:${cellH}:${cropX}:${cropY},scale=1280:720:flags=lanczos,unsharp=5:5:0.8:5:5:0.0" -q:v 2 -frames:v 1 -update 1 "${outFilePath}"`;
        execSync(cmd, { stdio: 'pipe' });

        if (!fs.existsSync(outFilePath)) {
            throw new Error('ffmpeg failed to generate output frame file');
        }

        const base64Data = fs.readFileSync(outFilePath).toString('base64');
        return {
            filename: outFilename,
            base64Url: `data:image/jpeg;base64,${base64Data}`,
            width: 1280,
            height: 720
        };
    } finally {
        try { if (fs.existsSync(tempSheet)) fs.unlinkSync(tempSheet); } catch (e) {}
    }
}

    // API Fast Thumbnail Fetching Endpoint (YouTube direct / storyboard, Twitch GQL, Kick API - No Python!)
    if ((pathname === '/api/extract-thumbnail' || pathname === '/api/fetch-thumbnail') && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { url, timestamp, title } = JSON.parse(body);
                if (!url) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'URL required' }));
                }

                console.log(`[Server Fetching Thumbnail]: ${url} (timestamp: ${timestamp || 'default cover'})`);
                const isYouTube = url.toLowerCase().includes('youtube.com') || url.toLowerCase().includes('youtu.be');
                const isTwitch = url.toLowerCase().includes('twitch.tv');
                const isKick = url.toLowerCase().includes('kick.com');

                // 1. YouTube: Instant direct public CDN image or exact timestamp storyboard extraction
                if (isYouTube) {
                    const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
                    const ytId = ytMatch ? ytMatch[1] : '';
                    if (!ytId) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'Could not parse YouTube video ID' }));
                    }

                    const sec = parseTimestampToSeconds(timestamp);
                    const cleanTitle = title ? title.replace(/[^A-Za-z0-9_-]+/g, '_') : ytId;

                    // If a specific timestamp is requested (> 0 seconds), extract the exact video frame from YouTube storyboard
                    if (sec > 0) {
                        try {
                            const frameData = await extractYouTubeTimestampFrame(ytId, sec);
                            if (frameData && frameData.base64Url) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                return res.end(JSON.stringify({
                                    success: true,
                                    platform: 'youtube',
                                    id: ytId,
                                    isFrame: true,
                                    thumbnailUrl: frameData.base64Url,
                                    downloadUrl: frameData.base64Url,
                                    timestamp: timestamp,
                                    filename: `${cleanTitle}_frame_${String(timestamp).replace(/:/g, '-')}.jpg`
                                }));
                            }
                        } catch (err) {
                            console.error(`[Server Storyboard Extract Error]: ${err.message}. Falling back to official 1080p cover.`);
                            const maxRes = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
                            const hqRes = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            return res.end(JSON.stringify({
                                success: true,
                                platform: 'youtube',
                                id: ytId,
                                isFrame: false,
                                thumbnailUrl: maxRes,
                                downloadUrl: maxRes,
                                fallbackUrl: hqRes,
                                timestamp: '00:00:00',
                                filename: `${cleanTitle}_default_cover_1080p.jpg`,
                                errorNotice: `Timeline frame extraction error: ${err.message}. Loaded official 1080p HD default cover.`
                            }));
                        }
                    }

                    // Default official video cover thumbnail (Full HD/4K)
                    const maxRes = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
                    const hqRes = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        success: true,
                        platform: 'youtube',
                        id: ytId,
                        isFrame: false,
                        thumbnailUrl: maxRes,
                        downloadUrl: maxRes,
                        fallbackUrl: hqRes,
                        timestamp: '00:00:00',
                        filename: `${cleanTitle}_default_cover.jpg`
                    }));
                }

                // 2. Twitch: Instant GQL query without python (25ms)
                if (isTwitch) {
                    const vodMatch = url.match(/twitch\.tv\/videos\/(\d+)/i);
                    const clipMatch = url.match(/(?:clips\.twitch\.tv\/|twitch\.tv\/[^\/]+\/clip\/)([A-Za-z0-9_-]+)/i);

                    if (vodMatch && vodMatch[1]) {
                        const vodId = vodMatch[1];
                        const payload = JSON.stringify({
                            query: `query { video(id: "${vodId}") { title, lengthSeconds, previewThumbnailURL(width: 1280, height: 720) } }`
                        });
                        const reqGql = https.request('https://gql.twitch.tv/gql', {
                            method: 'POST',
                            headers: {
                                'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(payload)
                            },
                            timeout: 6000
                        }, gqlRes => {
                            let dataStr = '';
                            gqlRes.on('data', chunk => dataStr += chunk);
                            gqlRes.on('end', () => {
                                try {
                                    const parsed = JSON.parse(dataStr);
                                    const video = parsed?.data?.video;
                                    let thumbUrl = video?.previewThumbnailURL || '';
                                    const sec = parseTimestampToSeconds(timestamp);
                                    if (video && sec > 0 && thumbUrl) {
                                        const duration = video.lengthSeconds || 1;
                                        const ratio = Math.min(1, Math.max(0, sec / duration));
                                        const thumbIdx = Math.min(3, Math.floor(ratio * 4));
                                        thumbUrl = thumbUrl.replace(/thumb\d+/i, `thumb${thumbIdx}`);
                                    }
                                    if (thumbUrl) {
                                        res.writeHead(200, { 'Content-Type': 'application/json' });
                                        return res.end(JSON.stringify({
                                            success: true,
                                            platform: 'twitch',
                                            thumbnailUrl: thumbUrl,
                                            isFrame: sec > 0,
                                            title: video?.title || 'twitch_vod',
                                            timestamp: timestamp || '00:00:00',
                                            filename: `twitch_${vodId}_${timestamp ? String(timestamp).replace(/:/g, '-') : 'thumb'}.jpg`
                                        }));
                                    }
                                } catch (e) {}
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: false, error: 'Could not fetch Twitch VOD thumbnail' }));
                            });
                        });
                        reqGql.on('error', () => {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, error: 'Twitch connection error' }));
                        });
                        reqGql.write(payload);
                        return reqGql.end();
                    }

                    if (clipMatch && clipMatch[1]) {
                        const clipSlug = clipMatch[1];
                        const payload = JSON.stringify({
                            query: `query { clip(slug: "${clipSlug}") { title, thumbnailURL } }`
                        });
                        const reqGql = https.request('https://gql.twitch.tv/gql', {
                            method: 'POST',
                            headers: {
                                'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(payload)
                            },
                            timeout: 6000
                        }, gqlRes => {
                            let dataStr = '';
                            gqlRes.on('data', chunk => dataStr += chunk);
                            gqlRes.on('end', () => {
                                try {
                                    const parsed = JSON.parse(dataStr);
                                    let thumbUrl = parsed?.data?.clip?.thumbnailURL || '';
                                    if (thumbUrl) {
                                        res.writeHead(200, { 'Content-Type': 'application/json' });
                                        return res.end(JSON.stringify({
                                            success: true,
                                            platform: 'twitch',
                                            thumbnailUrl: thumbUrl,
                                            title: parsed?.data?.clip?.title || 'twitch_clip',
                                            timestamp: timestamp || '00:00:00',
                                            filename: `twitch_clip_${clipSlug}_thumb.jpg`
                                        }));
                                    }
                                } catch (e) {}
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: false, error: 'Could not fetch Twitch clip thumbnail' }));
                            });
                        });
                        reqGql.on('error', () => {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, error: 'Twitch connection error' }));
                        });
                        reqGql.write(payload);
                        return reqGql.end();
                    }
                }

                // 3. Kick: Direct public JSON API without python
                if (isKick) {
                    const clipMatch = url.match(/(?:kick\.com\/[^\/]+\/clips\/|kick\.com\/clips\/|[?&]clip=)([A-Za-z0-9_-]+)/i);
                    if (clipMatch && clipMatch[1]) {
                        try {
                            const clipData = await fetchKickJson(`https://kick.com/api/v2/clips/${encodeURIComponent(clipMatch[1])}`);
                            const thumb = clipData?.thumbnail_url || clipData?.clip?.thumbnail_url;
                            if (thumb) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                return res.end(JSON.stringify({
                                    success: true,
                                    platform: 'kick',
                                    thumbnailUrl: thumb,
                                    title: clipData?.title || 'kick_clip',
                                    timestamp: timestamp || '00:00:00',
                                    filename: `kick_clip_${clipMatch[1]}_thumb.jpg`
                                }));
                            }
                        } catch (e) {}
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Could not fetch thumbnail for this URL' }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid payload' }));
            }
        });
        return;
    }

    // API Full Metadata & Tags Fetching Endpoint
    if (pathname === '/api/fetch-metadata' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { url } = JSON.parse(body);
                if (!url) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'URL required' }));
                }

                console.log(`[Server Fetching Full Metadata & Tags]: ${url}`);
                const isYouTube = url.toLowerCase().includes('youtube.com') || url.toLowerCase().includes('youtu.be');
                const cleanUrl = url.replace(/"/g, '\\"');
                const cmd = `${getBaseYtdlpCmd(url)} -j --no-warnings "${cleanUrl}"`;

                exec(cmd, { maxBuffer: 1024 * 1024 * 10, windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
                    if (error || !stdout || !stdout.trim()) {
                        const errDetail = (stderr || error?.message || 'No metadata returned').trim();
                        console.error(`[Server Metadata Fetch Error]: ${errDetail}`);
                        if (isYouTube) {
                            console.log(`[Server Metadata Fallback]: Querying public oEmbed for ${url}`);
                            const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
                            return fetchWithRedirects(oembedUrl)
                                .then(resp => {
                                    let title = '';
                                    let author = '';
                                    if (resp.statusCode === 200 && resp.body) {
                                        try {
                                            const parsed = JSON.parse(resp.body);
                                            title = parsed.title || '';
                                            author = parsed.author_name || '';
                                        } catch (e) {}
                                    }
                                    const metadata = {
                                        title: title || 'YouTube Video',
                                        description: `YouTube video by ${author || 'creator'}.`,
                                        video_tags: [],
                                        channel_tags: author ? [author] : [],
                                        channel: author || 'YouTube',
                                        view_count: null,
                                        duration_string: ''
                                    };
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ success: true, metadata, fallback: true }));
                                })
                                .catch(() => {
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ success: false, error: errDetail }));
                                });
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: errDetail }));
                    }
                    try {
                        const info = JSON.parse(stdout.trim().split('\n')[0]);
                        const channelTags = [];
                        if (info.categories && Array.isArray(info.categories)) {
                            channelTags.push(...info.categories);
                        }
                        if (info.uploader) channelTags.push(info.uploader);
                        if (info.channel && info.channel !== info.uploader) channelTags.push(info.channel);

                        const metadata = {
                            title: info.title || '',
                            description: info.description || 'No description provided.',
                            video_tags: info.tags || [],
                            channel_tags: Array.from(new Set(channelTags)).filter(Boolean),
                            channel: info.uploader || info.channel || '',
                            view_count: info.view_count || null,
                            duration_string: info.duration_string || ''
                        };
                        console.log(`[Server Metadata Fetched]: "${metadata.title}" (${metadata.video_tags.length} video tags, ${metadata.channel_tags.length} channel tags)`);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, metadata }));
                    } catch (e) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Failed to parse video JSON' }));
                    }
                });
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid payload' }));
            }
        });
        return;
    }

    // API Subtitle & Transcript Fetching Endpoint (YouTube Instant + Local Whisper AI for Twitch/Kick)
    if (pathname === '/api/fetch-transcript' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { url, start, end, full } = JSON.parse(body);
                if (!url) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'URL required' }));
                }

                console.log(`[Server Transcript Request]: ${url} (Range: ${start || '00:00:00'} - ${end || (full ? 'Full' : 'Default')})`);

                const isYouTube = url.toLowerCase().includes('youtube.com') || url.toLowerCase().includes('youtu.be');
                const hasRange = Boolean(start && end);

                // If YouTube and NO specific range requested, try instant auto-sub extraction first (takes 100ms!)
                if (isYouTube && !hasRange) {
                    const cleanUrl = url.replace(/"/g, '\\"');
                    const cmd = `${getBaseYtdlpCmd(url)} --write-sub --write-auto-sub --sub-lang "en.*,en" --skip-download -o "-" "${cleanUrl}"`;

                    exec(cmd, { maxBuffer: 1024 * 1024 * 15, windowsHide: true, timeout: 25000 }, (error, stdout, stderr) => {
                        const rawOutput = (stdout || '') + (stderr || '');
                        const lines = rawOutput.split(/[\r\n]+/);
                        const cleanLines = [];
                        const seen = new Set();

                        lines.forEach(line => {
                            const trimmed = line.replace(/<[^>]*>/g, '').trim();
                            if (!trimmed) return;
                            if (trimmed.startsWith('WEBVTT') || trimmed.startsWith('Kind:') || trimmed.startsWith('Language:') || trimmed.includes('-->')) return;
                            if (/^\d+$/.test(trimmed)) return;
                            if (seen.has(trimmed)) return;

                            seen.add(trimmed);
                            cleanLines.push(trimmed);
                        });

                        if (cleanLines.length > 5) {
                            console.log(`[Server YouTube Auto-Sub Extracted]: ${cleanLines.length} subtitle lines`);
                            res.writeHead(200, {
                                'Content-Type': 'application/x-ndjson; charset=utf-8',
                                'Cache-Control': 'no-cache, no-transform',
                                'Connection': 'keep-alive',
                                'X-Accel-Buffering': 'no'
                            });
                            res.write(JSON.stringify({
                                type: 'progress',
                                percent: 100,
                                status: 'Subtitles Extracted',
                                speed: 'Instant',
                                eta: '0s'
                            }) + '\n');
                            res.write(JSON.stringify({
                                type: 'result',
                                success: true,
                                transcript: cleanLines.join('\n'),
                                source: 'youtube-autosub'
                            }) + '\n');
                            return res.end();
                        }

                        // Fallback to local Whisper AI if YouTube had no subtitles
                        runWhisperTranscription();
                    });
                } else {
                    // Twitch, Kick, or YouTube range selections: Run local offline Whisper AI!
                    runWhisperTranscription();
                }

                function runWhisperTranscription() {
                    console.log(`[Server Running Local Whisper AI]: ${url}`);
                    const pyArgs = [path.join(__dirname, 'transcribe_whisper.py'), url];
                    if (start) pyArgs.push('--start', start);
                    if (end) pyArgs.push('--end', end);
                    if (full) pyArgs.push('--full');

                    res.writeHead(200, {
                        'Content-Type': 'application/x-ndjson; charset=utf-8',
                        'Cache-Control': 'no-cache, no-transform',
                        'Connection': 'keep-alive',
                        'X-Accel-Buffering': 'no'
                    });

                    // Send initial progress tick immediately
                    res.write(JSON.stringify({
                        type: 'progress',
                        percent: 5,
                        status: 'Connecting to media stream...',
                        speed: 'Connecting...',
                        eta: '--'
                    }) + '\n');

                    const child = spawn(PYTHON_BIN, pyArgs, { windowsHide: true });
                    let stdoutData = '';
                    let stderrData = '';

                    child.stderr.on('data', data => {
                        const text = data.toString();
                        stderrData += text;
                        const lines = text.split(/[\r\n]+/);
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed) continue;
                            const match = trimmed.match(/\[WHISPER_PROGRESS:\s*([0-9.]+)%\s*\|\s*(.*?)\]/);
                            if (match) {
                                const percent = parseFloat(match[1]);
                                const status = match[2];
                                res.write(JSON.stringify({
                                    type: 'progress',
                                    percent: percent,
                                    status: status,
                                    speed: 'Whisper AI',
                                    eta: `${Math.max(1, Math.round(100 - percent))}% left`
                                }) + '\n');
                            }
                        }
                    });

                    child.stdout.on('data', data => {
                        stdoutData += data.toString();
                    });

                    child.on('close', code => {
                        if (stdoutData.trim()) {
                            try {
                                const result = JSON.parse(stdoutData.trim());
                                if (result.success) {
                                    console.log(`[Server Whisper Success]: Generated speech-to-text transcript (${result.language || 'en'})`);
                                    res.write(JSON.stringify({
                                        type: 'result',
                                        success: true,
                                        transcript: result.transcript,
                                        language: result.language,
                                        notice: result.notice
                                    }) + '\n');
                                    return res.end();
                                } else if (result.error) {
                                    console.error(`[Server Whisper Reported Error]: ${result.error}`);
                                    res.write(JSON.stringify({ type: 'result', success: false, error: result.error }) + '\n');
                                    return res.end();
                                }
                            } catch (e) {
                                // Fall through to standard error handler
                            }
                        }

                        const errMsg = (stderrData || 'Whisper transcription failed').trim();
                        console.error(`[Server Whisper Error]: ${errMsg}`);
                        res.write(JSON.stringify({ type: 'result', success: false, error: errMsg }) + '\n');
                        res.end();
                    });

                    child.on('error', err => {
                        console.error(`[Server Whisper Spawn Error]: ${err.message}`);
                        res.write(JSON.stringify({ type: 'result', success: false, error: err.message }) + '\n');
                        res.end();
                    });
                }
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid payload' }));
            }
        });
        return;
    }

    // API Title Fetching Endpoint
    if (pathname === '/api/fetch-title' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { url } = JSON.parse(body);
                if (!url) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'URL required' }));
                }

                console.log(`[Server Fetching Title]: ${url}`);
                const isYouTube = url.toLowerCase().includes('youtube.com') || url.toLowerCase().includes('youtu.be');

                // For YouTube, use public oEmbed API first - instantaneous (20ms) and NEVER blocked by bot checks
                if (isYouTube) {
                    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
                    fetchWithRedirects(oembedUrl)
                        .then(resp => {
                            if (resp.statusCode === 200 && resp.body) {
                                try {
                                    const parsed = JSON.parse(resp.body);
                                    if (parsed.title) {
                                        console.log(`[Server Title Fetched via oEmbed]: "${parsed.title}"`);
                                        res.writeHead(200, { 'Content-Type': 'application/json' });
                                        return res.end(JSON.stringify({ success: true, title: parsed.title, author: parsed.author_name }));
                                    }
                                } catch (e) {}
                            }
                            runYtdlpTitleFetch();
                        })
                        .catch(() => runYtdlpTitleFetch());
                    return;
                }

                runYtdlpTitleFetch();

                function runYtdlpTitleFetch() {
                    const cleanUrl = url.replace(/"/g, '\\"');
                    const cmd = `${getBaseYtdlpCmd(url)} --no-playlist --print title --no-warnings "${cleanUrl}"`;
                    
                    exec(cmd, { maxBuffer: 1024 * 1024 * 5, windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
                        if (error || !stdout || !stdout.trim()) {
                            const errDetail = (stderr || error?.message || 'No title returned').trim();
                            console.error(`[Server Fetch Title Error]: ${errDetail}`);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            return res.end(JSON.stringify({ success: false, error: errDetail }));
                        }
                        const title = stdout.trim().split(/[\r\n]+/)[0].trim();
                        console.log(`[Server Title Fetched]: "${title}"`);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, title }));
                    });
                }
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid payload' }));
            }
        });
        return;
    }

    // API Cookies Status Endpoint
    if (pathname === '/api/cookies-status' && req.method === 'GET') {
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        const exists = fs.existsSync(cookiesPath);
        let size = 0;
        let lineCount = 0;
        if (exists) {
            try {
                const stat = fs.statSync(cookiesPath);
                size = stat.size;
                const txt = fs.readFileSync(cookiesPath, 'utf8');
                lineCount = txt.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
            } catch (e) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            success: true,
            hasCookies: exists && size > 10,
            size,
            lineCount,
            disabled: cookiesDisabled,
            hasEnv: Boolean(process.env.YOUTUBE_COOKIES)
        }));
    }

    // API Upload / Update Cookies Endpoint (Save new cookies or clear expired ones)
    if (pathname === '/api/upload-cookies' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { cookies, action } = JSON.parse(body);
                const cookiesPath = path.join(__dirname, 'cookies.txt');

                if (action === 'clear') {
                    cookiesDisabled = true;
                    if (fs.existsSync(cookiesPath)) {
                        try { fs.unlinkSync(cookiesPath); } catch (e) {}
                    }
                    console.log('[Cookies] Cleared & disabled cookies via web UI');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, message: 'Cookies cleared & disabled' }));
                }

                if (action === 'toggle') {
                    cookiesDisabled = !cookiesDisabled;
                    console.log(`[Cookies] Toggled cookies: ${cookiesDisabled ? 'DISABLED' : 'ENABLED'}`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, disabled: cookiesDisabled }));
                }

                if (!cookies || typeof cookies !== 'string' || cookies.trim().length < 10) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Valid cookies text required' }));
                }

                const cleanCookies = cookies.trim();
                fs.writeFileSync(cookiesPath, cleanCookies, 'utf8');
                cookiesDisabled = false;
                console.log(`[Cookies] Saved new cookies.txt (${cleanCookies.length} bytes) via web UI`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: `Successfully saved cookies (${cleanCookies.length} bytes)` }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid payload' }));
            }
        });
        return;
    }

    // API Select Folder Endpoint (Opens Native Windows Folder Dialog Box on Windows)
    if (pathname === '/api/select-folder' && req.method === 'POST') {
        if (process.platform !== 'win32') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, isCloud: true, error: 'Cloud server mode' }));
        }

        console.log('[Server Opening Windows Folder Dialog...]');
        const psCommand = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Output Destination Folder'; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }"`;
        
        exec(psCommand, { maxBuffer: 1024 * 1024 * 2, windowsHide: false, timeout: 60000 }, (error, stdout, stderr) => {
            if (error || !stdout || !stdout.trim()) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: 'Folder selection canceled or unavailable' }));
            }
            const selectedPath = stdout.trim().split(/[\r\n]+/)[0].trim();
            console.log(`[Server Folder Selected]: "${selectedPath}"`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, folderPath: selectedPath }));
        });
        return;
    }

    // API Select File Endpoint (Opens Native Windows File Dialog Box on Windows)
    if (pathname === '/api/select-file' && req.method === 'POST') {
        if (process.platform !== 'win32') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, isCloud: true, error: 'Cloud server mode' }));
        }

        console.log('[Server Opening Windows File Dialog...]');
        const psCommand = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'Media Files (*.mkv;*.mov;*.avi;*.webm;*.flv;*.mp4;*.wmv)|*.mkv;*.mov;*.avi;*.webm;*.flv;*.mp4;*.wmv|All Files (*.*)|*.*'; $f.Title = 'Select Video File to Convert'; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.FileName }"`;

        exec(psCommand, { maxBuffer: 1024 * 1024 * 2, windowsHide: false, timeout: 60000 }, (error, stdout, stderr) => {
            if (error || !stdout || !stdout.trim()) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: 'File selection canceled or unavailable' }));
            }
            const selectedPath = stdout.trim().split(/[\r\n]+/)[0].trim();
            console.log(`[Server File Selected]: "${selectedPath}"`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, filePath: selectedPath }));
        });
        return;
    }

    // Serve Static Files
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.join(PUBLIC_DIR, pathname);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 Not Found</h1>');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${err.code}`);
            }
        } else {
            // Prevent browser caching for application code so deployments on Render reflect immediately
            const isCodeAsset = ext === '.js' || ext === '.css' || ext === '.html';
            const headers = { 'Content-Type': contentType };
            if (isCodeAsset) {
                headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
                headers['Pragma'] = 'no-cache';
                headers['Expires'] = '0';
            }
            res.writeHead(200, headers);
            res.end(content, 'utf-8');
        }
    });
});

function startServer(portToUse) {
    server.removeAllListeners('error');
    server.removeAllListeners('listening');

    server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${portToUse} in use, attempting port ${portToUse + 1}...`);
            startServer(portToUse + 1);
        } else {
            console.error('Server error:', err);
        }
    });

    server.once('listening', () => {
        console.log(`\n==================================================`);
        console.log(` ⚡ Ultra Downloader Studio Server is Running!`);
        console.log(` 🌐 Access UI in browser at: http://localhost:${portToUse}`);
        console.log(`==================================================\n`);
    });

    server.listen(portToUse);
}

startServer(PORT);
