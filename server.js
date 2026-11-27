const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { exec, execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const crypto = require('crypto');
const urlModule = require('url');

// Token map: token -> { absPath, jobDir, expires, cleanupTimer }
const downloadTokens = new Map();

function setBoundedCache(map, key, value, maxSize = 60) {
    const now = Date.now();
    for (const [k, v] of map) {
        if (v && v.expires && v.expires < now) map.delete(k);
    }
    while (map.size >= maxSize) {
        const oldestKey = map.keys().next().value;
        map.delete(oldestKey);
    }
    map.set(key, value);
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let aborted = false;
        req.on('data', chunk => {
            if (aborted) return;
            total += chunk.length;
            if (total > maxBytes) {
                aborted = true;
                const err = new Error('Payload too large');
                err.statusCode = 413;
                return reject(err);
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (aborted) return;
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) {
                const err = new Error('Invalid JSON payload');
                err.statusCode = 400;
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

// Strict static file allowlist + in-memory gzip/ETag cache (never exposes cookies.txt, server.js, .env, .git, etc.)
const STATIC_PUBLIC_FILES = new Map([
    ['/index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'application/javascript; charset=utf-8'],
    ['/style.css', 'text/css; charset=utf-8']
]);
const staticAssetCache = new Map(); // pathname -> { mtimeMs, raw, gzip, etag, contentType }

function getStaticAsset(pathname) {
    const contentType = STATIC_PUBLIC_FILES.get(pathname);
    if (!contentType) return null;
    const filePath = path.join(PUBLIC_DIR, pathname.slice(1));
    const stat = fs.statSync(filePath);
    const cached = staticAssetCache.get(pathname);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

    const raw = fs.readFileSync(filePath);
    const gzip = zlib.gzipSync(raw, { level: 6 });
    const etag = `"${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)}"`;
    const entry = { mtimeMs: stat.mtimeMs, raw, gzip, etag, contentType };
    staticAssetCache.set(pathname, entry);
    return entry;
}

let PORT = parseInt(process.env.PORT, 10) || 3005;
const PUBLIC_DIR = __dirname;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
    try {
        fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    } catch (e) {}
}

let cookiesDisabled = false;
let cookiesRejectedByYouTube = false;

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

const YTDLP_JS_RUNTIME = fs.existsSync('/usr/local/bin/deno') ? 'deno' : 'node';

function getYtdlpClientArgs(hasCookies = false) {
    // android/ios do not support cookies in yt-dlp; put mweb before tv/web_safari and avoid web EJS/SABR stalls
    const clients = hasCookies ? 'mweb,tv,web_safari' : 'android,ios,web_creator,tv';
    return ` --extractor-args "youtube:player_client=${clients}"`;
}

function injectYtdlpFlags(command, { cookiesFlag = '', isYT = false, isKick = false } = {}) {
    let out = command;
    const prefixFlags = [];

    if (!out.includes('--impersonate') && isKick) {
        prefixFlags.push('--impersonate Chrome');
    }
    if (!out.includes('--js-runtimes')) {
        prefixFlags.push(`--js-runtimes ${YTDLP_JS_RUNTIME}`);
    }
    if (cookiesFlag && !out.includes('--cookies')) {
        prefixFlags.push(cookiesFlag.trim());
    }
    if (isYT) {
        if (!out.includes('--force-ipv4')) {
            prefixFlags.push('--force-ipv4');
        }
        if (!out.includes('--user-agent')) {
            prefixFlags.push('--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"');
        }
        if (!out.includes('--concurrent-fragments')) {
            prefixFlags.push('--concurrent-fragments 5');
        }
        if (!out.includes('--extractor-args')) {
            prefixFlags.push(getYtdlpClientArgs(Boolean(cookiesFlag && !out.includes('--cookies')) || out.includes('--cookies')).trim());
        }
    }

    if (prefixFlags.length === 0) return out;
    const joined = prefixFlags.join(' ');
    // Replace only yt-dlp command invocations (not matches inside video titles)
    return out.replace(/(^|(?:&&|\|\||;)\s*)yt-dlp\b/g, `$1yt-dlp ${joined}`);
}

function getBaseYtdlpCmd(url = '') {
    const cookiesFlag = getCookiesFlag(url);
    const impersonateFlag = (url && url.toLowerCase().includes('kick.com')) ? ' --impersonate Chrome' : '';
    const isYouTube = url && (url.toLowerCase().includes('youtube.com') || url.toLowerCase().includes('youtu.be'));
    const clientOverride = isYouTube ? getYtdlpClientArgs(Boolean(cookiesFlag)) : '';
    const ytArgs = isYouTube ? ` --force-ipv4 --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"${clientOverride} --concurrent-fragments 5` : '';
    if (cookiesFlag) {
        return `yt-dlp${cookiesFlag}${impersonateFlag}${ytArgs} --js-runtimes ${YTDLP_JS_RUNTIME}`;
    }
    return `yt-dlp${impersonateFlag}${ytArgs} --js-runtimes ${YTDLP_JS_RUNTIME}`;
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

// Kick's newer UUIDv7 VODs return 404 on /api/v1/video/, but the VOD webpage embeds og:video (.m3u8), og:title, and og:image
const KICK_PAGE_META_PY = [
    'import sys, json, re, html as html_mod',
    'from curl_cffi import requests',
    'r = requests.get(sys.argv[1], impersonate="chrome", timeout=20)',
    'txt = (r.text or "").replace("\\\\/", "/").replace("\\\\u0026", "&")',
    'def og(prop):',
    '    m = re.search(rf\'<meta[^>]+property=["\\\']{prop}["\\\'][^>]+content=["\\\']([^"\\\']+)["\\\']\', txt, re.I)',
    '    if not m: m = re.search(rf\'content=["\\\']([^"\\\']+)["\\\'][^>]+property=["\\\']{prop}["\\\']\', txt, re.I)',
    '    return html_mod.unescape(m.group(1)).strip() if m else ""',
    'video = og("og:video")',
    'if not video:',
    '    hm = re.search(r"https://stream\\.kick\\.com/[^\\s\\\"\\\'<>\\\\]+\\.m3u8[^\\s\\\"\\\'<>\\\\]*", txt, re.I)',
    '    video = hm.group(0) if hm else ""',
    'title = re.sub(r"\\s*-\\s*[^-]+\\s+VOD on KICK\\s*$", "", og("og:title"), flags=re.I).strip()',
    'thumb = og("og:image")',
    'sys.stdout.write(json.dumps({"status": r.status_code, "previewUrl": video, "title": title, "thumbnail": thumb}))'
].join('\n');

function fetchKickPageMeta(pageUrl) {
    return new Promise((resolve, reject) => {
        execFile(PYTHON_BIN, ['-c', KICK_PAGE_META_PY, pageUrl], { maxBuffer: 1024 * 1024 * 10, windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
            if (error && !stdout) return reject(new Error((stderr || error.message || 'Kick page fetch failed').trim().split('\n').pop()));
            try {
                const parsed = JSON.parse(stdout);
                if (parsed.status !== 200) return reject(new Error(`Kick page responded with HTTP ${parsed.status}`));
                resolve(parsed);
            } catch (e) {
                reject(new Error('Could not parse Kick page metadata'));
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
                    setBoundedCache(clipPreviewCache, cleanSlug, { expires: Date.now() + CLIP_PREVIEW_CACHE_MS, url: directUrl }, 80);
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
        const req = client.get(targetUrl, {
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
        });
        req.on('error', reject);
        req.setTimeout(6000, () => { req.destroy(); reject(new Error('HTTP fetch timeout')); });
    });
}

const ytStoryboardCache = new Map(); // videoId -> { info, expires }
const ytCoverCache = new Map(); // videoId -> { url, qualityLabel, width, height, expires }
const ytStreamCache = new Map(); // videoId -> { url, expires }
const ytFrameResultCache = new Map(); // dedupeKey -> { data, expires } (max 8 entries)
const inFlightFrameExtractions = new Map(); // `${videoId}:${sec}:${ext}` -> Promise

function getYouTubeCookieHeader() {
    if (cookiesDisabled) return '';
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (!fs.existsSync(cookiesPath)) return '';
    try {
        const lines = fs.readFileSync(cookiesPath, 'utf8').split(/\r?\n/);
        const pairs = [];
        for (const l of lines) {
            if (!l.trim() || l.startsWith('#')) continue;
            const cols = l.split('\t');
            if (cols.length >= 7 && (cols[0].includes('youtube.com') || cols[0].includes('google.com'))) {
                pairs.push(`${cols[5]}=${cols[6].trim()}`);
            }
        }
        return pairs.join('; ');
    } catch (e) {
        return '';
    }
}

function extractYouTubeVideoId(rawUrl = '') {
    const str = String(rawUrl || '').trim();
    if (!str) return '';
    const pathMatch = str.match(/(?:youtube\.com\/(?:shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&#\/]|$)/i);
    if (pathMatch && pathMatch[1]) return pathMatch[1];
    const queryMatch = str.match(/[?&]v=([A-Za-z0-9_-]{11})(?:[&#]|$)/i);
    if (queryMatch && queryMatch[1]) return queryMatch[1];
    return '';
}

function checkImageExistsHead(imgUrl) {
    return new Promise((resolve) => {
        const req = https.request(imgUrl, { method: 'HEAD', timeout: 4000 }, res => {
            resolve(res.statusCode >= 200 && res.statusCode < 300);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

async function resolveBestYouTubeCover(videoId) {
    const cached = ytCoverCache.get(videoId);
    if (cached && cached.expires > Date.now()) return cached;

    const candidates = [
        { url: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`, qualityLabel: '1080p / 720p HD MaxRes', width: 1280, height: 720 },
        { url: `https://img.youtube.com/vi/${videoId}/hq720.jpg`, qualityLabel: '720p HD Cover', width: 1280, height: 720 },
        { url: `https://img.youtube.com/vi/${videoId}/sddefault.jpg`, qualityLabel: '480p SD Cover', width: 640, height: 480 },
        { url: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, qualityLabel: '360p HQ Fallback', width: 480, height: 360 }
    ];

    for (const c of candidates) {
        const ok = await checkImageExistsHead(c.url);
        if (ok) {
            const entry = { ...c, expires: Date.now() + 15 * 60 * 1000 };
            setBoundedCache(ytCoverCache, videoId, entry, 80);
            return entry;
        }
    }
    return { ...candidates[3], expires: Date.now() + 60 * 1000 };
}

function setBoundedStoryboardCache(videoId, sbInfo) {
    setBoundedCache(ytStoryboardCache, videoId, { info: sbInfo, expires: Date.now() + 30 * 60 * 1000 }, 30);
}

async function getYouTubeStoryboard(videoId, { skipYtdlp = false } = {}) {
    const cachedSb = ytStoryboardCache.get(videoId);
    if (cachedSb && cachedSb.expires > Date.now()) {
        return cachedSb.info;
    }

    let ytdlpErr = '';
    const ytdlpBin = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp';
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const cookiesFlag = getCookiesFlag('https://www.youtube.com');
    const hasCookies = Boolean(cookiesFlag && fs.existsSync(cookiesPath));

    if (!skipYtdlp) {
        try {
            const clients = hasCookies ? 'mweb,tv,web_safari' : 'android,ios,web_creator,tv';
            const args = [
                ...(hasCookies ? ['--cookies', cookiesPath] : []),
                '--dump-json', '--skip-download', '--force-ipv4', '--no-warnings',
                '--js-runtimes', YTDLP_JS_RUNTIME,
                '--extractor-args', `youtube:player_client=${clients}`,
                `https://www.youtube.com/watch?v=${videoId}`
            ];
            const { stdout } = await execFileAsync(ytdlpBin, args, { maxBuffer: 25 * 1024 * 1024, timeout: hasCookies ? 40000 : 12000, windowsHide: true });
            const data = JSON.parse(stdout);
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
                    setBoundedStoryboardCache(videoId, sbInfo);
                    return sbInfo;
                }
            }
        } catch (e) {
            ytdlpErr = (e.stderr ? e.stderr.toString() : e.message).slice(0, 300);
            console.warn(`[yt-dlp Storyboard Warning]: ${ytdlpErr}. Trying native https fallback...`);
        }
    } else {
        ytdlpErr = 'Skipped duplicate yt-dlp check after cloud bot gate';
    }

    let html = '';
    let fetchErr = '';
    const ytCookieHdr = getYouTubeCookieHeader();
    const consentCookie = 'CONSENT=PENDING+999; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg; PREF=hl=en';
    const combinedCookie = ytCookieHdr ? `${consentCookie}; ${ytCookieHdr}` : consentCookie;

    try {
        const resp = await fetchWithRedirects(`https://www.youtube.com/watch?v=${videoId}`, { 'Cookie': combinedCookie });
        if (resp && resp.body) html = resp.body;
    } catch (e) {
        fetchErr = e.message;
    }

    let specMatch = html.match(/"spec":\s*"([^"]+)"/);
    if (!specMatch) {
        const unescaped = html.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        specMatch = unescaped.match(/"spec":\s*"([^"]+)"/);
    }

    if (!specMatch || !specMatch[1]) {
        throw new Error(`Storyboard unavailable (ytdlp: ${ytdlpErr || 'none'}, fetch: ${fetchErr || 'no spec match'})`);
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
    setBoundedStoryboardCache(videoId, sbInfo);
    return sbInfo;
}

async function extractYouTubeTimestampFrame(videoId, targetSeconds, format = 'jpg') {
    const imgFormat = String(format || 'jpg').toLowerCase() === 'png' ? 'png' : 'jpg';
    const dedupeKey = `${videoId}:${Math.floor(targetSeconds)}:${imgFormat}`;
    const cachedFrame = ytFrameResultCache.get(dedupeKey);
    if (cachedFrame && cachedFrame.expires > Date.now()) {
        console.log(`[Frame Extract] Serving cached frame for ${dedupeKey}`);
        return cachedFrame.data;
    }
    if (inFlightFrameExtractions.has(dedupeKey)) {
        console.log(`[Frame Extract] Coalescing duplicate in-flight request for ${dedupeKey}`);
        return inFlightFrameExtractions.get(dedupeKey);
    }

    const workPromise = (async () => {
        const downloadsDir = path.join(__dirname, 'downloads');
        if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
        const outExt = imgFormat === 'png' ? 'png' : 'jpg';
        const outMime = imgFormat === 'png' ? 'image/png' : 'image/jpeg';
        const ffmpegOutArgs = imgFormat === 'png'
            ? ['-vframes', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1']
            : ['-vframes', '1', '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '2', 'pipe:1'];
        const aspectSafeScale = `scale='if(gte(iw/ih,16/9),1920,if(gte(iw/ih,1),-2,1080))':'if(gte(iw/ih,16/9),-2,if(gte(iw/ih,1),1080,1920))':flags=lanczos`;
        const outFilename = `frame_${videoId}_${targetSeconds}s.${outExt}`;

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

        let hitBotWall = false;
        let timedOutWithCookies = false;
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        const cookiesFlag = getCookiesFlag('https://www.youtube.com');
        const hasCookies = Boolean(cookiesFlag && fs.existsSync(cookiesPath));

        try {
            let streamUrl = '';
            const cachedStream = ytStreamCache.get(videoId);
            if (cachedStream && cachedStream.expires > Date.now()) {
                streamUrl = cachedStream.url;
                console.log(`[Frame Extract] Using cached stream URL for ${videoId} at ${tsFormatted}...`);
            } else {
                console.log(`[Frame Extract] Attempting async direct stream extraction for ${videoId} at ${tsFormatted}...`);
                const ytdlpBin = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp';
                const attempts = hasCookies
                    ? [{ useCookies: true, clients: 'mweb,tv,web_safari' }, { useCookies: false, clients: 'android' }]
                    : [{ useCookies: false, clients: 'android' }];

                for (const att of attempts) {
                    try {
                        const args = [
                            ...(att.useCookies ? ['--cookies', cookiesPath] : []),
                            '-g', '-f', '22/best[height<=720][acodec!=none]/18/best',
                            '--force-ipv4', '--no-warnings', '--js-runtimes', YTDLP_JS_RUNTIME,
                            '--extractor-args', `youtube:player_client=${att.clients}`,
                            `https://www.youtube.com/watch?v=${videoId}`
                        ];
                        const { stdout } = await execFileAsync(ytdlpBin, args, { timeout: att.useCookies ? 45000 : 12000, windowsHide: true });
                        const matched = (stdout || '').trim().match(/https?:\/\/[^\r\n]+/);
                        if (matched && matched[0]) {
                            streamUrl = matched[0];
                            if (att.useCookies) cookiesRejectedByYouTube = false;
                            setBoundedCache(ytStreamCache, videoId, { url: streamUrl, expires: Date.now() + 5 * 60 * 1000 }, 40);
                            break;
                        }
                    } catch (attErr) {
                        const msg = (attErr.stderr ? attErr.stderr.toString() : attErr.message) || '';
                        const firstErrLine = msg.split(/[\r\n]+/).filter(Boolean).slice(-1)[0] || msg.slice(0, 220);
                        console.warn(`[Frame Extract Attempt Failed] (${att.useCookies ? 'with-cookies' : 'cookieless'}: ${att.clients}): ${firstErrLine}`);
                        if (/not a bot|Sign in to confirm|cookies are no longer valid/i.test(msg)) {
                            hitBotWall = true;
                            if (att.useCookies) cookiesRejectedByYouTube = true;
                        } else if (att.useCookies && (attErr.killed || attErr.signal === 'SIGTERM')) {
                            timedOutWithCookies = true;
                            break;
                        }
                    }
                }
            }

            if (streamUrl && streamUrl.startsWith('http')) {
                console.log(`[Frame Extract] Extracting ${outExt.toUpperCase()} frame at ${tsFormatted}...`);
                const ffArgs = [
                    '-y', '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    '-ss', tsFormatted, '-i', streamUrl,
                    '-vf', `${aspectSafeScale},unsharp=5:5:0.8:5:5:0.0`,
                    ...ffmpegOutArgs
                ];
                const { stdout: frameBuf } = await execFileAsync('ffmpeg', ffArgs, { encoding: 'buffer', maxBuffer: 25 * 1024 * 1024, timeout: 25000, windowsHide: true });

                if (frameBuf && frameBuf.length > 1000) {
                    console.log(`[Frame Extract Success] Direct frame generated (${outExt.toUpperCase()}): ${frameBuf.length} bytes`);
                    return {
                        filename: outFilename,
                        base64Url: `data:${outMime};base64,${frameBuf.toString('base64')}`,
                        source: 'direct-stream',
                        qualityLabel: `Direct Video Stream (${outExt.toUpperCase()})`,
                        ext: outExt
                    };
                }
            }
        } catch (streamErr) {
            ytStreamCache.delete(videoId);
            console.warn(`[Frame Extract Notice]: Direct stream extraction failed (${streamErr.message}). Trying storyboard fallback...`);
        }

        const sb = await getYouTubeStoryboard(videoId, { skipYtdlp: hitBotWall || timedOutWithCookies });

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

            const sheetName = (sb.template || 'default').replace('$M', sheetIndex);
            sheetUrl = sb.baseUrl.replace('$L', sb.levelIndex).replace('$N', sheetName);
            if (sheetUrl.includes('$M')) sheetUrl = sheetUrl.replace('$M', sheetIndex);
            if (sb.sigh) sheetUrl += (sheetUrl.includes('?') ? '&' : '?') + `sigh=${sb.sigh}`;
        }

        const tempSheet = path.join(downloadsDir, `temp_sb_${videoId}_${Date.now()}.tmp`);
        try {
            const sheetData = await new Promise((resolve, reject) => {
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
                        const isWebp = buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
                        const isJpeg = buf.length > 2 && buf[0] === 0xFF && buf[1] === 0xD8;
                        if (!isWebp && !isJpeg) {
                            return reject(new Error(`Storyboard file is not a valid image format (received ${buf.slice(0, 16).toString()})`));
                        }
                        resolve({ buf, isWebp });
                    });
                });
                req.on('error', reject);
                req.setTimeout(10000, () => { req.destroy(); reject(new Error('Storyboard download timeout')); });
            });

            const sheetFile = `${tempSheet}${sheetData.isWebp ? '.webp' : '.jpg'}`;
            fs.writeFileSync(sheetFile, sheetData.buf);

            const ffArgs = ['-y', '-i', sheetFile, '-vf', `crop=${cellW}:${cellH}:${cropX}:${cropY},${aspectSafeScale}`, ...ffmpegOutArgs];
            const { stdout: frameBuf } = await execFileAsync('ffmpeg', ffArgs, { encoding: 'buffer', maxBuffer: 25 * 1024 * 1024, timeout: 10000, windowsHide: true });

            if (!frameBuf || frameBuf.length < 500) {
                throw new Error('FFmpeg generated invalid or empty image buffer');
            }

            return {
                filename: outFilename,
                base64Url: `data:${outMime};base64,${frameBuf.toString('base64')}`,
                source: 'storyboard',
                qualityLabel: `Storyboard Frame (${cellW}x${cellH} -> Full HD ${outExt.toUpperCase()})`,
                ext: outExt
            };
        } finally {
            try {
                const files = fs.readdirSync(downloadsDir);
                for (const f of files) {
                    if (f.startsWith(`temp_sb_${videoId}_`)) {
                        try { fs.unlinkSync(path.join(downloadsDir, f)); } catch (e) {}
                    }
                }
            } catch (e) {}
        }
    })();

    inFlightFrameExtractions.set(dedupeKey, workPromise);
    try {
        const result = await workPromise;
        if (result && result.base64Url) {
            setBoundedCache(ytFrameResultCache, dedupeKey, { data: result, expires: Date.now() + 2 * 60 * 1000 }, 8);
        }
        return result;
    } finally {
        inFlightFrameExtractions.delete(dedupeKey);
    }
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

    // API Health Check
    if (pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'ok',
            server: 'ULTDownloader Backend',
            uptime: process.uptime(),
            groqConfigured: Boolean(process.env.GROQ_API_KEY)
        }));
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
                setBoundedCache(channelVideosCache, cacheKey, { expires: Date.now() + CHANNEL_CACHE_MS, data }, 40);
            }
            sendJson(200, data);
        }).catch(err => {
            console.error(`[Server Channel Browser Error]: ${err.message}`);
            sendJson(200, { success: false, platform, username, type, range, error: err.message });
        });
        return;
    }

    // API Direct Clip / VOD Preview (HTML5 MP4 / HLS Stream URL for Twitch Clips & Kick VODs/Clips)
    if (pathname === '/api/clip-preview' && req.method === 'GET') {
        const slug = (parsedUrl.searchParams.get('slug') || '').trim();
        const vodId = (parsedUrl.searchParams.get('vodId') || '').trim();
        const platform = (parsedUrl.searchParams.get('platform') || 'twitch').toLowerCase();

        if (!slug && !vodId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Slug or vodId parameter is required' }));
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

        if (platform === 'kick') {
            const rawUrl = (parsedUrl.searchParams.get('url') || '').trim();
            const channelParam = (parsedUrl.searchParams.get('channel') || '').trim();
            (async () => {
                try {
                    const cacheKey = `kick:${vodId || slug}`;
                    const cached = clipPreviewCache.get(cacheKey);
                    if (cached && cached.expires > Date.now() && cached.payload) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify(cached.payload));
                    }

                    if (vodId) {
                        // 1. Try Kick legacy v1 JSON API
                        try {
                            const data = await fetchKickJson(`https://kick.com/api/v1/video/${encodeURIComponent(vodId)}`);
                            const previewUrl = data?.source || data?.livestream?.source || '';
                            if (previewUrl) {
                                const payload = { success: true, platform, vodId, previewUrl, title: data?.livestream?.session_title || data?.session_title || '' };
                                setBoundedCache(clipPreviewCache, cacheKey, { payload, expires: Date.now() + 10 * 60 * 1000 }, 80);
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                return res.end(JSON.stringify(payload));
                            }
                        } catch (e) {}

                        // 2. Fallback to Kick VOD webpage og:video (.m3u8) for newer UUIDv7 VODs
                        const candidatePages = [];
                        if (rawUrl && /^https?:\/\/(?:www\.)?kick\.com\//i.test(rawUrl)) candidatePages.push(rawUrl);
                        if (channelParam) candidatePages.push(`https://kick.com/${encodeURIComponent(channelParam)}/videos/${encodeURIComponent(vodId)}`);
                        candidatePages.push(`https://kick.com/video/${encodeURIComponent(vodId)}`);
                        for (const pageUrl of [...new Set(candidatePages)]) {
                            try {
                                const meta = await fetchKickPageMeta(pageUrl);
                                if (meta && meta.previewUrl) {
                                    const payload = { success: true, platform, vodId, previewUrl: meta.previewUrl, title: meta.title || '', thumbnail: meta.thumbnail || '' };
                                    setBoundedCache(clipPreviewCache, cacheKey, { payload, expires: Date.now() + 10 * 60 * 1000 }, 80);
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    return res.end(JSON.stringify(payload));
                                }
                            } catch (e) {}
                        }
                    }
                    if (slug) {
                        const data = await fetchKickJson(`https://kick.com/api/v2/clips/${encodeURIComponent(slug)}`);
                        const clipObj = data?.clip || data;
                        const previewUrl = clipObj?.clip_url || clipObj?.video_url || '';
                        if (previewUrl) {
                            const payload = { success: true, platform, slug, previewUrl, title: clipObj?.title || '' };
                            setBoundedCache(clipPreviewCache, cacheKey, { payload, expires: Date.now() + 10 * 60 * 1000 }, 80);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            return res.end(JSON.stringify(payload));
                        }
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Kick stream source not found' }));
                } catch (err) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: err.message }));
                }
            })();
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Platform not supported for direct preview' }));
        return;
    }

    // API Command Execution Endpoint (Chunked Real-Time Progress Stream)
    if (pathname === '/api/execute' && req.method === 'POST') {
        readJsonBody(req).then(({ command, tabId, cropMode }) => {
            if (!command) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Command required' }));
            }

                const singleFileTabs = new Set(['tab-quick-download', 'tab-section-clipper', 'tab-silence-cutter', 'tab-file-converter']);
                const isolateJob = singleFileTabs.has(tabId) || (!tabId && !command.includes('robocopy') && !command.includes('/shorts') && !command.includes('/yt-sections'));
                let jobDir = null;
                let baseCommand = command;

                if (isolateJob) {
                    const jobId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
                    jobDir = path.join(DOWNLOADS_DIR, `.job_${jobId}`);
                    if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
                    // Redirect relative downloads/ output targets into this job's isolated directory (preserving ffmpeg -i input paths)
                    baseCommand = baseCommand
                        .replace(/(-o|--output)\s+"downloads[\/\\]/gi, `$1 "downloads/.job_${jobId}/`)
                        .replace(/auto-editor\s+"downloads[\/\\]/gi, `auto-editor "downloads/.job_${jobId}/`);
                    if (baseCommand.trimStart().startsWith('ffmpeg')) {
                        baseCommand = baseCommand.replace(/(?<!-i\s+)"downloads[\/\\]/gi, `"downloads/.job_${jobId}/`);
                    }
                }

                const cookiesFlag = getCookiesFlag(baseCommand);
                const isYT = baseCommand.toLowerCase().includes('youtube.com') || baseCommand.toLowerCase().includes('youtu.be');
                const isKick = baseCommand.toLowerCase().includes('kick.com');

                let finalCommand = baseCommand;
                if (/\byt-dlp\b/.test(finalCommand)) {
                    finalCommand = injectYtdlpFlags(finalCommand, { cookiesFlag, isYT, isKick });
                }

                // Parse target section duration for accurate live percentage calculation on long clips
                let sectionDurationSec = 0;
                const sectionMatch = finalCommand.match(/--download-sections\s+["']?\*?([0-9:]+(?:\.[0-9]+)?)-([0-9:]+(?:\.[0-9]+)?)/i);
                if (sectionMatch) {
                    const sStart = parseTimestampToSeconds(sectionMatch[1]);
                    const sEnd = parseTimestampToSeconds(sectionMatch[2]);
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

                res.write(JSON.stringify({
                    text: '[Download Initiated] Connecting to stream & buffering media segments...',
                    type: 'system',
                    percent: 0.1,
                    speed: '--',
                    eta: '--'
                }) + '\n');

                let clientAborted = false;
                let activeChild = null;
                res.on('close', () => {
                    if (!res.writableFinished) {
                        clientAborted = true;
                        if (activeChild && !activeChild.killed) {
                            try { activeChild.kill('SIGTERM'); } catch (e) {}
                        }
                    }
                });

                const cleanupJobDir = () => {
                    if (jobDir && fs.existsSync(jobDir)) {
                        try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {}
                    }
                };

                const runExecAttempt = (cmdToRun, { allowCookieRetry = false } = {}) => {
                    const child = exec(cmdToRun, { maxBuffer: 1024 * 1024 * 50, windowsHide: true });
                    activeChild = child;

                    let hasInvalidCookies = false;
                    let sawBotOrFormatError = false;
                    let currentPhase = 'video';

                    const handleOutput = (data, defaultType = 'info') => {
                        if (clientAborted || res.writableEnded) return;
                        const text = data.toString();
                        if (text.includes('cookies are no longer valid')) {
                            hasInvalidCookies = true;
                        }
                        if (text.includes('Sign in to confirm you') || text.includes('not a bot') || text.includes('Requested format is not available')) {
                            sawBotOrFormatError = true;
                        }
                        const lines = text.split(/[\r\n]+/);

                        lines.forEach(line => {
                            const trimmed = line.trim();
                            if (!trimmed) return;

                            if (trimmed.startsWith('[hls @') && (trimmed.includes('Skip') || trimmed.includes('#EXT-X-'))) {
                                return;
                            }

                            let percentMatch = trimmed.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
                            let speedMatch = trimmed.match(/at\s+([0-9\.]+\s*[KMGk]?i?B\/s)/i) || trimmed.match(/speed=\s*([0-9\.]+\s*x)/i);
                            let etaMatch = trimmed.match(/ETA\s+([0-9:]+)/i);

                            if (trimmed.includes('[download] Destination:')) {
                                if (/\.(m4a|webm|opus|mp3|aac)$/i.test(trimmed) || trimmed.includes('.f140') || trimmed.includes('.f251')) {
                                    currentPhase = 'audio';
                                }
                            } else if (trimmed.includes('[Merger]') || trimmed.includes('[Fixup')) {
                                percentMatch = [null, '99.0'];
                                speedMatch = speedMatch || [null, 'Merging MP4...'];
                            } else if (trimmed.includes('[ExtractAudio]')) {
                                percentMatch = [null, '98.5'];
                                speedMatch = speedMatch || [null, 'Extracting Audio...'];
                            }

                            if (trimmed.includes('time=') && (trimmed.includes('frame=') || trimmed.includes('size='))) {
                                const timeMatch = trimmed.match(/time=\s*([0-9:]+(?:\.[0-9]+)?)/i);
                                const ffmpegSpeedMatch = trimmed.match(/speed=\s*([0-9\.]+)x/i);

                                if (timeMatch) {
                                    const curSec = parseTimestampToSeconds(timeMatch[1]);
                                    if (sectionDurationSec > 0) {
                                        const calcPercent = Math.min(99.5, Math.max(0.1, (curSec / sectionDurationSec) * 100));
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

                            let mappedPercent = percentMatch ? parseFloat(percentMatch[1]) : null;
                            if (mappedPercent !== null && currentPhase === 'audio' && trimmed.startsWith('[download]')) {
                                // Smooth transition for second audio stream: map 0-100% -> 88-98%
                                mappedPercent = parseFloat((88 + mappedPercent * 0.1).toFixed(1));
                            }

                            const payload = {
                                text: trimmed,
                                type: logType,
                                percent: mappedPercent,
                                speed: speedMatch ? speedMatch[1] : null,
                                eta: etaMatch ? etaMatch[1] : null
                            };

                            res.write(JSON.stringify(payload) + '\n');
                        });
                    };

                    if (child.stdout) child.stdout.on('data', d => handleOutput(d, 'info'));
                    if (child.stderr) child.stderr.on('data', d => handleOutput(d, 'system'));

                    child.on('close', (code) => {
                        if (clientAborted || res.writableEnded) {
                            cleanupJobDir();
                            return;
                        }

                        if (hasInvalidCookies) {
                            cookiesRejectedByYouTube = true;
                            try {
                                const cookiesPath = path.join(__dirname, 'cookies.txt');
                                if (fs.existsSync(cookiesPath)) {
                                    fs.unlinkSync(cookiesPath);
                                    console.log('[Cookies] Auto-deleted expired cookies.txt file.');
                                }
                            } catch (e) {}
                        }

                        // Auto-retry once without cookies (using android/ios client) if cookie-authenticated YT attempt hit bot/cookie rejection
                        if (code !== 0 && allowCookieRetry && isYT && cmdToRun.includes('--cookies') && (hasInvalidCookies || sawBotOrFormatError)) {
                            cookiesRejectedByYouTube = true;
                            cleanupJobDir();
                            if (jobDir && !fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
                            const cookielessCmd = injectYtdlpFlags(baseCommand, { cookiesFlag: '', isYT, isKick });
                            res.write(JSON.stringify({
                                text: '[Anti-Bot Auto-Retry] Cookies expired or rejected by YouTube client. Retrying cleanly with cookieless Android/iOS client...',
                                type: 'system',
                                percent: 1,
                                speed: 'Retrying...',
                                eta: '--'
                            }) + '\n');
                            return runExecAttempt(cookielessCmd, { allowCookieRetry: false });
                        }

                        // Auto-retry Kick UUIDv7 VODs via webpage og:video .m3u8 when yt-dlp's legacy Kick v1 API returns 404
                        const kickVodUrlMatch = isKick && cmdToRun.match(/https?:\/\/(?:www\.)?kick\.com\/[^\s"']+\/videos?\/[A-Za-z0-9_-]+/i);
                        if (code !== 0 && allowCookieRetry && kickVodUrlMatch) {
                            const kickPageUrl = kickVodUrlMatch[0];
                            res.write(JSON.stringify({
                                text: '[Kick VOD Resolver] Resolving direct Kick HLS stream from VOD page...',
                                type: 'system',
                                percent: 2,
                                speed: 'Resolving...',
                                eta: '--'
                            }) + '\n');
                            return fetchKickPageMeta(kickPageUrl).then(meta => {
                                if (clientAborted || res.writableEnded) return cleanupJobDir();
                                if (meta && meta.previewUrl) {
                                    cleanupJobDir();
                                    if (jobDir && !fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
                                    const directCmd = cmdToRun.replace(kickPageUrl, meta.previewUrl);
                                    res.write(JSON.stringify({
                                        text: '[Kick VOD Resolver] Direct HLS stream found — starting download!',
                                        type: 'info',
                                        percent: 5,
                                        speed: 'Connecting...',
                                        eta: '--'
                                    }) + '\n');
                                    return runExecAttempt(directCmd, { allowCookieRetry: false });
                                }
                                finishResponse(code);
                            }).catch(() => finishResponse(code));
                        }

                        const scanDirRecursive = (dir, minMtimeMs = 0) => {
                            const found = [];
                            if (!fs.existsSync(dir)) return found;
                            const entries = fs.readdirSync(dir, { withFileTypes: true });
                            for (const e of entries) {
                                const full = path.join(dir, e.name);
                                if (e.isDirectory()) {
                                    // Skip internal job directories unless explicitly scanning a jobDir
                                    if (!jobDir && e.name.startsWith('.job_')) continue;
                                    found.push(...scanDirRecursive(full, minMtimeMs));
                                } else {
                                    if (e.name.endsWith('.part') || e.name.endsWith('.ytdl') || e.name.endsWith('.temp') || e.name.startsWith('temp_sb_')) continue;
                                    const stat = fs.statSync(full);
                                    if (stat.size > 0 && stat.mtimeMs >= minMtimeMs) {
                                        found.push({ p: full, t: stat.mtimeMs, s: stat.size });
                                    }
                                }
                            }
                            return found;
                        };

                        const finishResponse = (finalCode) => {
                            if (finalCode === 0 && isYT && cmdToRun.includes('--cookies')) {
                                cookiesRejectedByYouTube = false;
                            }
                            let outputFile = null;
                            if (finalCode === 0) {
                                try {
                                    const searchRoot = jobDir || path.join(__dirname, 'downloads');
                                    const minTime = jobDir ? 0 : (Date.now() - 120000);
                                    const allFiles = scanDirRecursive(searchRoot, minTime);
                                    if (allFiles.length > 0) {
                                        allFiles.sort((a, b) => b.t - a.t || b.s - a.s);
                                        outputFile = path.relative(__dirname, allFiles[0].p).replace(/\\/g, '/');
                                    }
                                } catch (e) {}
                            }

                            let downloadToken = null;
                            let fileName = null;
                            if (finalCode === 0 && outputFile) {
                                const absFilePath = path.join(__dirname, outputFile);
                                console.log(`[Server] Output file: ${absFilePath}, exists: ${fs.existsSync(absFilePath)}`);
                                if (fs.existsSync(absFilePath)) {
                                    downloadToken = crypto.randomBytes(16).toString('hex');
                                    fileName = path.basename(absFilePath);
                                    downloadTokens.set(downloadToken, { absPath: absFilePath, jobDir, expires: Date.now() + 600000 });
                                    console.log(`[Server] Token created: ${downloadToken} for file: ${fileName}`);
                                    for (const [k, v] of downloadTokens) {
                                        if (v.expires < Date.now()) {
                                            if (v.cleanupTimer) clearTimeout(v.cleanupTimer);
                                            if (v.jobDir) {
                                                try { fs.rmSync(v.jobDir, { recursive: true, force: true }); } catch (e) {}
                                            }
                                            downloadTokens.delete(k);
                                        }
                                    }
                                }
                            } else if (finalCode !== 0 || !outputFile) {
                                cleanupJobDir();
                            }

                            res.write(JSON.stringify({ done: true, exitCode: finalCode, outputFile, downloadToken, fileName }) + '\n');
                            res.end();
                        };

                        // Optional Step 2: 9:16 Vertical Framing / Crop for TikTok / Shorts / Reels
                        const needsVerticalCrop = code === 0 && (cropMode === 'vertical_crop' || cropMode === 'vertical_blur') && jobDir;
                        if (needsVerticalCrop) {
                            const jobFiles = scanDirRecursive(jobDir, 0).filter(f => /\.(mp4|mkv|webm|mov)$/i.test(f.p));
                            if (jobFiles.length > 0) {
                                jobFiles.sort((a, b) => b.s - a.s);
                                const rawFile = jobFiles[0].p;
                                const parsedRaw = path.parse(rawFile);
                                const finalBaseName = parsedRaw.name.endsWith('_9x16') ? parsedRaw.name : `${parsedRaw.name}_9x16`;
                                const tempCroppedFile = path.join(parsedRaw.dir, `.tmp_9x16_${parsedRaw.name}.mp4`);
                                const finalCroppedFile = path.join(parsedRaw.dir, `${finalBaseName}.mp4`);
                                const vfFilter = cropMode === 'vertical_blur'
                                    ? `-filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=bilinear,crop=1080:1920:(iw-1080)/2:(ih-1920)/2,boxblur=25:2[bg];[0:v]scale=1080:-2:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1"`
                                    : `-vf "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920:(iw-1080)/2:(ih-1920)/2,setsar=1"`;
                                const ffmpegCropCmd = `ffmpeg -y -i "${rawFile}" ${vfFilter} -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "${tempCroppedFile}"`;

                                res.write(JSON.stringify({
                                    text: `[Vertical 9:16 Render] Formatting clip (${cropMode === 'vertical_blur' ? '9:16 Blurred Backdrop' : '9:16 Center Crop'})...`,
                                    type: 'system',
                                    percent: 90,
                                    speed: 'FFmpeg 9:16',
                                    eta: 'Rendering...'
                                }) + '\n');

                                const cropChild = exec(ffmpegCropCmd, { maxBuffer: 1024 * 1024 * 25, windowsHide: true });
                                activeChild = cropChild;
                                if (cropChild.stderr) {
                                    cropChild.stderr.on('data', d => {
                                        if (clientAborted || res.writableEnded) return;
                                        const t = d.toString();
                                        const m = t.match(/time=\s*([0-9:]+(?:\.[0-9]+)?)/i);
                                        if (m && sectionDurationSec > 0) {
                                            const sec = parseTimestampToSeconds(m[1]);
                                            const pct = Math.min(99.5, 90 + (sec / sectionDurationSec) * 9.5);
                                            res.write(JSON.stringify({ percent: parseFloat(pct.toFixed(1)), speed: 'FFmpeg 9:16', eta: 'Encoding' }) + '\n');
                                        }
                                    });
                                }
                                cropChild.on('close', (cropCode) => {
                                    if (cropCode === 0 && fs.existsSync(tempCroppedFile)) {
                                        try { fs.unlinkSync(rawFile); } catch (e) {}
                                        try { fs.renameSync(tempCroppedFile, finalCroppedFile); } catch (e) {}
                                        res.write(JSON.stringify({ text: '[Vertical 9:16 Render] Ready for Shorts / TikTok / Reels!', type: 'success', percent: 100 }) + '\n');
                                        return finishResponse(0);
                                    }
                                    try { if (fs.existsSync(tempCroppedFile)) fs.unlinkSync(tempCroppedFile); } catch (e) {}
                                    res.write(JSON.stringify({ text: '[Vertical 9:16 Warning] Crop encode failed; falling back to original cut.', type: 'system' }) + '\n');
                                    finishResponse(0);
                                });
                                return;
                            }
                        }

                        finishResponse(code);
                    });

                    child.on('error', (err) => {
                        cleanupJobDir();
                        if (!res.writableEnded) {
                            res.write(JSON.stringify({ text: `Execution Error: ${err.message}`, type: 'error', done: true }) + '\n');
                            res.end();
                        }
                    });
                };

                runExecAttempt(finalCommand, { allowCookieRetry: true });
        }).catch(err => {
            if (!res.headersSent) {
                res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message || 'Invalid payload' }));
            }
        });
        return;
    }

    // API Download File to Browser Endpoint (token-based, Safari Range + multi-tap safe)
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
        if (!entry || entry.expires < Date.now()) {
            if (entry) downloadTokens.delete(token);
            console.log(`[DownloadFile] 404: token not found or expired. Known tokens: ${[...downloadTokens.keys()].join(', ')}`);
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Token not found or expired');
        }
        const absPath = entry.absPath;
        const entryJobDir = entry.jobDir;
        console.log(`[DownloadFile] Serving: ${absPath}`);
        if (!absPath.startsWith(path.join(__dirname, 'downloads'))) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            return res.end('Forbidden');
        }
        if (!fs.existsSync(absPath)) {
            downloadTokens.delete(token);
            if (entryJobDir) try { fs.rmSync(entryJobDir, { recursive: true, force: true }); } catch (e) {}
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('File not found on disk');
        }

        const stat = fs.statSync(absPath);
        const totalSize = stat.size;
        const ext = path.extname(absPath).toLowerCase();
        const mimeMap = { '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.m4a': 'audio/m4a', '.wav': 'audio/wav', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
        const mime = mimeMap[ext] || 'application/octet-stream';
        const safeFilename = path.basename(absPath).replace(/[";\\]/g, '_');
        const asciiFilename = safeFilename.replace(/[^\x20-\x7E]/g, '_');
        const dispHeader = `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`;

        const scheduleCleanupAfterGrace = () => {
            if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
            entry.expires = Math.min(entry.expires, Date.now() + 90000);
            entry.cleanupTimer = setTimeout(() => {
                downloadTokens.delete(token);
                if (entryJobDir && fs.existsSync(entryJobDir)) {
                    fs.rm(entryJobDir, { recursive: true, force: true }, (err) => {
                        if (!err) console.log(`[Server] Cleaned job folder: ${path.basename(entryJobDir)}`);
                    });
                } else if (fs.existsSync(absPath)) {
                    fs.unlink(absPath, (err) => {
                        if (!err) console.log(`[Server] Deleted from disk: ${path.basename(absPath)}`);
                        else console.log(`[Server] Delete failed: ${err.message}`);
                    });
                }
            }, 90000);
        };

        const rangeHeader = req.headers.range;
        let stream;
        if (rangeHeader && /^bytes=\d*-\d*$/i.test(rangeHeader.trim())) {
            const [sStr, eStr] = rangeHeader.trim().replace(/^bytes=/i, '').split('-');
            const start = sStr ? parseInt(sStr, 10) : 0;
            const end = eStr ? Math.min(totalSize - 1, parseInt(eStr, 10)) : (totalSize - 1);
            if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) {
                res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
                return res.end();
            }
            res.writeHead(206, {
                'Content-Type': mime,
                'Content-Disposition': dispHeader,
                'Accept-Ranges': 'bytes',
                'Content-Range': `bytes ${start}-${end}/${totalSize}`,
                'Content-Length': (end - start) + 1,
                'Cache-Control': 'no-store'
            });
            stream = fs.createReadStream(absPath, { start, end });
            if (end >= totalSize - 1) {
                stream.on('end', scheduleCleanupAfterGrace);
            }
        } else {
            res.writeHead(200, {
                'Content-Type': mime,
                'Content-Disposition': dispHeader,
                'Accept-Ranges': 'bytes',
                'Content-Length': totalSize,
                'Cache-Control': 'no-store'
            });
            stream = fs.createReadStream(absPath);
            stream.on('end', scheduleCleanupAfterGrace);
        }

        stream.pipe(res);
        res.on('close', () => {
            if (!res.writableFinished) stream.destroy();
        });
        return;
    }

    // API Check File Existence Endpoint
    if (pathname === '/api/check-file' && req.method === 'POST') {
        readJsonBody(req).then(({ filePath }) => {
            if (!filePath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'filePath required' }));
            }

            let targetPath = String(filePath);
            if (targetPath.startsWith('%USERPROFILE%')) {
                targetPath = targetPath.replace('%USERPROFILE%', process.env.USERPROFILE || '');
            }
            const resolvedPath = path.resolve(path.isAbsolute(targetPath) ? targetPath : path.join(PUBLIC_DIR, targetPath));
            // On Linux/cloud hosts, only allow checking files inside downloads/
            if (process.platform !== 'win32' && !resolvedPath.startsWith(DOWNLOADS_DIR + path.sep)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, exists: false, fileName: path.basename(resolvedPath) }));
            }

            const exists = fs.existsSync(resolvedPath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, exists, fileName: path.basename(resolvedPath) }));
        }).catch(err => {
            res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message || 'Invalid payload' }));
        });
        return;
    }

    // API Fast Thumbnail Fetching Endpoint (YouTube direct / storyboard, Twitch GQL, Kick API - No Python!)
    if (pathname === '/api/fetch-thumbnail' && req.method === 'POST') {
        readJsonBody(req).then(async ({ url, timestamp, title, format }) => {
            if (!url) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: 'URL required' }));
            }

                const outExt = String(format || 'jpg').toLowerCase() === 'png' ? 'png' : 'jpg';
                console.log(`[Server Fetching Thumbnail]: ${url} (timestamp: ${timestamp || 'default cover'}, format: ${outExt})`);
                const isYouTube = url.toLowerCase().includes('youtube.com') || url.toLowerCase().includes('youtu.be');
                const isTwitch = url.toLowerCase().includes('twitch.tv');
                const isKick = url.toLowerCase().includes('kick.com');

                // 1. YouTube: Resolved highest existing cover OR exact timestamp frame extraction
                if (isYouTube) {
                    const ytId = extractYouTubeVideoId(url);
                    if (!ytId) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'Could not parse YouTube video ID' }));
                    }

                    const sec = parseTimestampToSeconds(timestamp);
                    const cleanTitle = title ? title.replace(/[^A-Za-z0-9_$-]+/g, '_').replace(/\$/g, '_') : ytId;

                    if (sec > 0) {
                        try {
                            const frameData = await extractYouTubeTimestampFrame(ytId, sec, outExt);
                            if (frameData && frameData.base64Url) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                return res.end(JSON.stringify({
                                    success: true,
                                    platform: 'youtube',
                                    id: ytId,
                                    isFrame: true,
                                    source: frameData.source,
                                    qualityLabel: frameData.qualityLabel,
                                    ext: frameData.ext,
                                    thumbnailUrl: frameData.base64Url,
                                    downloadUrl: frameData.base64Url,
                                    timestamp: timestamp,
                                    filename: `${cleanTitle}_frame_${String(timestamp).replace(/:/g, '-')}.${frameData.ext}`
                                }));
                            }
                        } catch (err) {
                            console.error(`[Server Storyboard Extract Error]: ${err.message}. Falling back to best official cover.`);
                            const isBotBlock = /not a bot|Sign in to confirm|cookies are no longer valid|Skipped duplicate yt-dlp/i.test(err.message);
                            const hasCookies = Boolean(getCookiesFlag('https://www.youtube.com'));
                            const bestCover = await resolveBestYouTubeCover(ytId);
                            const friendlyMsg = isBotBlock
                                ? (hasCookies
                                    ? `YouTube rejected the loaded cookies on this cloud IP ("Sign in to confirm you're not a bot"). Click Cookies (top right) to upload fresh cookies (or update YOUTUBE_COOKIES in Render for restarts). Showing ${bestCover.qualityLabel}.`
                                    : `YouTube blocked this cloud IP ("Sign in to confirm you're not a bot"). Click Cookies (top right) to upload fresh cookies, then try again. Showing ${bestCover.qualityLabel}.`)
                                : `Timeline frame extraction error: ${err.message}. Loaded ${bestCover.qualityLabel}.`;
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            return res.end(JSON.stringify({
                                success: true,
                                platform: 'youtube',
                                id: ytId,
                                isFrame: false,
                                botBlocked: isBotBlock,
                                source: 'cover',
                                qualityLabel: bestCover.qualityLabel,
                                thumbnailUrl: bestCover.url,
                                downloadUrl: bestCover.url,
                                fallbackUrl: `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`,
                                timestamp: '00:00:00',
                                filename: `${cleanTitle}_default_cover.jpg`,
                                errorNotice: friendlyMsg
                            }));
                        }
                    }

                    // Default official video cover thumbnail (verified highest existing resolution)
                    const bestCover = await resolveBestYouTubeCover(ytId);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        success: true,
                        platform: 'youtube',
                        id: ytId,
                        isFrame: false,
                        source: 'cover',
                        qualityLabel: bestCover.qualityLabel,
                        thumbnailUrl: bestCover.url,
                        downloadUrl: bestCover.url,
                        fallbackUrl: `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`,
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

                // 3. Kick: Direct JSON API & VOD webpage og:image resolver
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
                    const vodMatch = url.match(/kick\.com\/[^\/]+\/videos?\/([A-Za-z0-9_-]+)|kick\.com\/videos?\/([A-Za-z0-9_-]+)/i);
                    if (vodMatch && (vodMatch[1] || vodMatch[2])) {
                        const vodId = vodMatch[1] || vodMatch[2];
                        try {
                            const meta = await fetchKickPageMeta(url);
                            if (meta && meta.thumbnail) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                return res.end(JSON.stringify({
                                    success: true,
                                    platform: 'kick',
                                    thumbnailUrl: meta.thumbnail,
                                    title: meta.title || `kick_vod_${vodId.slice(0, 8)}`,
                                    timestamp: timestamp || '00:00:00',
                                    filename: `kick_vod_${vodId.slice(0, 8)}_thumb.jpg`
                                }));
                            }
                        } catch (e) {}
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Could not fetch thumbnail for this URL' }));
        }).catch(err => {
            if (!res.headersSent) {
                res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message || 'Invalid payload' }));
            }
        });
        return;
    }

    // API Full Metadata & Tags Fetching Endpoint
    if (pathname === '/api/fetch-metadata' && req.method === 'POST') {
        readJsonBody(req).then(({ url }) => {
            if (!url) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'URL required' }));
            }

                console.log(`[Server Fetching Full Metadata & Tags]: ${url}`);
                const isYouTube = url.toLowerCase().includes('youtube.com') || url.toLowerCase().includes('youtu.be');
                const cleanUrl = url.replace(/"/g, '\\"');
                const cmd = `${getBaseYtdlpCmd(url)} --ignore-no-formats-error -j --no-warnings "${cleanUrl}"`;

                exec(cmd, { maxBuffer: 1024 * 1024 * 10, windowsHide: true, timeout: 55000 }, (error, stdout, stderr) => {
                    if (error || !stdout || !stdout.trim()) {
                        const errDetail = (stderr || error?.message || 'No metadata returned').trim();
                        if (cmd.includes('--cookies') && /not a bot|Sign in to confirm|cookies are no longer valid/i.test(errDetail)) {
                            cookiesRejectedByYouTube = true;
                        }
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
        }).catch(err => {
            if (!res.headersSent) {
                res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message || 'Invalid payload' }));
            }
        });
        return;
    }

    // API Subtitle & AI Speech Transcript Endpoint (Whisper AI + Voice Speaker Detection across YouTube/Twitch/Kick + Fast YouTube Captions)
    if (pathname === '/api/fetch-transcript' && req.method === 'POST') {
        readJsonBody(req).then(({ url, start, end, full, engine, detectSpeakers, language, title }) => {
            if (!url) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'URL required' }));
            }

            const lowerUrl = String(url).toLowerCase();
            const isYouTube = lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be');
            const isTwitch = lowerUrl.includes('twitch.tv');
            const isKick = lowerUrl.includes('kick.com');
            const platform = isYouTube
                ? 'youtube'
                : (isTwitch
                    ? ((lowerUrl.includes('clips.twitch.tv/') || lowerUrl.includes('/clip/')) ? 'twitch_clip' : (/twitch\.tv\/videos\/\d+/i.test(url) ? 'twitch_vod' : 'twitch'))
                    : (isKick
                        ? ((lowerUrl.includes('/clips/') || lowerUrl.includes('clip=')) ? 'kick_clip' : ((lowerUrl.includes('/video/') || lowerUrl.includes('/videos/') || lowerUrl.includes('video=')) ? 'kick_vod' : 'kick'))
                        : 'other'));

            const chosenEngine = (engine === 'captions' && isYouTube) ? 'captions' : 'whisper';
            const wantSpeakers = detectSpeakers !== false;
            const chosenLang = (language === 'auto') ? 'auto' : 'en';

            console.log(`[Server Transcript Request]: ${url} (Platform: ${platform}, Engine: ${chosenEngine}, Speakers: ${wantSpeakers}, Lang: ${chosenLang}, Range: ${start || '00:00:00'} - ${end || (full ? 'Full' : 'Default')})`);

            const rangeStartSec = start ? parseTimestampToSeconds(start) : 0;
            const rangeEndSec = (end && String(end).toLowerCase() !== 'full') ? parseTimestampToSeconds(end) : 0;
            const hasRange = Boolean(!full && rangeEndSec > rangeStartSec);

            let clientAborted = false;
            let activeChild = null;
            let headersSent = false;

            const ensureNdjsonHeaders = () => {
                if (!headersSent && !res.headersSent) {
                    headersSent = true;
                    res.writeHead(200, {
                        'Content-Type': 'application/x-ndjson; charset=utf-8',
                        'Cache-Control': 'no-cache, no-transform',
                        'Connection': 'keep-alive',
                        'X-Accel-Buffering': 'no'
                    });
                }
            };

            const writeEvent = (obj) => {
                if (clientAborted || res.writableEnded) return;
                ensureNdjsonHeaders();
                res.write(JSON.stringify(obj) + '\n');
            };

            const finishStream = (obj) => {
                if (clientAborted || res.writableEnded) return;
                if (obj) writeEvent(obj);
                res.end();
            };

            res.on('close', () => {
                if (!res.writableFinished) {
                    clientAborted = true;
                    if (activeChild && !activeChild.killed) {
                        try { activeChild.kill('SIGTERM'); } catch (e) {}
                    }
                }
            });

            const parseYouTubeVtt = (subOut) => {
                const fmtVttSec = (s) => {
                    const tot = Math.max(0, Math.floor(s));
                    const h = Math.floor(tot / 3600);
                    const m = Math.floor((tot % 3600) / 60);
                    const sec = tot % 60;
                    return h > 0
                        ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
                        : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
                };
                const decodeEntities = (str) => str
                    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');

                const rawCues = [];
                const recentLines = []; // rolling window of last 3 lines (avoids dropping repeated words later in the video!)
                const blocks = subOut.split(/\r?\n\r?\n+/);

                for (const blk of blocks) {
                    const blkLines = blk.split(/\r?\n/);
                    const timeLineIdx = blkLines.findIndex(l => l.includes('-->'));
                    if (timeLineIdx === -1) continue;
                    const tm = blkLines[timeLineIdx].match(/([0-9:.]+)\s+-->\s+([0-9:.]+)/);
                    if (!tm) continue;
                    const sSec = parseTimestampToSeconds(tm[1].split('.')[0]);
                    const eSec = parseTimestampToSeconds(tm[2].split('.')[0]);
                    const rawDur = parseFloat(tm[2].split(':').pop()) - parseFloat(tm[1].split(':').pop());
                    if (eSec === sSec && Math.abs(rawDur) < 0.05) continue; // skip 10ms VTT scroll snapshots
                    if (hasRange && (eSec < rangeStartSec || sSec > rangeEndSec)) continue;

                    const freshParts = [];
                    for (const rawLine of blkLines.slice(timeLineIdx + 1)) {
                        const cleanLine = decodeEntities(rawLine.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
                        if (!cleanLine) continue;
                        if (recentLines.includes(cleanLine)) continue;
                        recentLines.push(cleanLine);
                        if (recentLines.length > 3) recentLines.shift();
                        freshParts.push(cleanLine);
                    }

                    const cueText = freshParts.join(' ').trim();
                    if (cueText) {
                        rawCues.push({ startSec: sSec, endSec: Math.max(sSec, eSec), text: cueText });
                    }
                }

                // Parse speaker turns from >> markers, dialogue dashes (- ), and explicit Name: prefixes
                let activeSpeaker = 1;
                let hadSpeakerCues = false;
                const namedSpeakerMap = new Map();
                const idToLabel = new Map([[1, 'Speaker 1']]);
                let nextNamedId = 1;

                const parsedTurns = [];
                for (const cue of rawCues) {
                    let txt = cue.text;
                    let explicitSwitch = false;

                    // Check explicit "NAME: dialogue" or "[Name]: dialogue"
                    const namedMatch = txt.match(/^(?:\[([A-Za-z][A-Za-z0-9 .'-]{1,22})\]|([A-Z][A-Za-z0-9 .'-]{1,20})):\s+(.+)$/);
                    if (namedMatch) {
                        const rawName = (namedMatch[1] || namedMatch[2] || '').trim();
                        const bodyTxt = namedMatch[3].trim();
                        if (rawName && bodyTxt && !/^(https?|note|music|sfx)$/i.test(rawName)) {
                            const key = rawName.toLowerCase();
                            if (!namedSpeakerMap.has(key)) {
                                const assigned = Math.min(6, nextNamedId++);
                                namedSpeakerMap.set(key, assigned);
                                idToLabel.set(assigned, rawName);
                            }
                            activeSpeaker = namedSpeakerMap.get(key);
                            txt = bodyTxt;
                            hadSpeakerCues = true;
                            explicitSwitch = true;
                        }
                    } else if (/^>>+\s*/.test(txt) || /^-\s+/.test(txt)) {
                        txt = txt.replace(/^(?:>>+|-)\s*/, '').trim();
                        if (parsedTurns.length > 0 && wantSpeakers) {
                            activeSpeaker = activeSpeaker === 1 ? 2 : 1;
                            idToLabel.set(activeSpeaker, `Speaker ${activeSpeaker}`);
                            hadSpeakerCues = true;
                            explicitSwitch = true;
                        }
                    } else if (/\s>>+\s/.test(txt) && wantSpeakers) {
                        // Split mid-cue YouTube >> speaker switch into two turns
                        const splitParts = txt.split(/\s*>>+\s*/).map(p => p.trim()).filter(Boolean);
                        splitParts.forEach((part, idx) => {
                            if (idx > 0) {
                                activeSpeaker = activeSpeaker === 1 ? 2 : 1;
                                idToLabel.set(activeSpeaker, `Speaker ${activeSpeaker}`);
                                hadSpeakerCues = true;
                            }
                            parsedTurns.push({
                                startSec: cue.startSec,
                                endSec: cue.endSec,
                                speaker: activeSpeaker,
                                speakerLabel: idToLabel.get(activeSpeaker) || `Speaker ${activeSpeaker}`,
                                text: part,
                                forceBreak: idx > 0
                            });
                        });
                        continue;
                    }

                    if (!txt) continue;
                    parsedTurns.push({
                        startSec: cue.startSec,
                        endSec: cue.endSec,
                        speaker: wantSpeakers ? activeSpeaker : 1,
                        speakerLabel: wantSpeakers ? (idToLabel.get(activeSpeaker) || `Speaker ${activeSpeaker}`) : 'Speaker 1',
                        text: txt,
                        forceBreak: explicitSwitch
                    });
                }

                // Merge tiny rolling same-speaker fragments into readable sentence rows
                const merged = [];
                for (const turn of parsedTurns) {
                    const prev = merged[merged.length - 1];
                    const gap = prev ? (turn.startSec - prev.endSec) : 99;
                    const combDur = prev ? (turn.endSec - prev.startSec) : 99;
                    const combLen = prev ? (prev.text.length + 1 + turn.text.length) : 999;
                    if (prev && !turn.forceBreak && prev.speaker === turn.speaker && gap <= 1.0 && combDur <= 7.5 && combLen <= 210) {
                        prev.endSec = Math.max(prev.endSec, turn.endSec);
                        prev.text = `${prev.text} ${turn.text}`.trim();
                    } else {
                        merged.push({ ...turn });
                    }
                }

                const speakerStats = new Map();
                const segments = [];
                const cleanLines = [];

                for (const m of merged) {
                    const sStr = fmtVttSec(m.startSec);
                    const eStr = fmtVttSec(Math.max(m.startSec, m.endSec));
                    const dur = Math.max(0.5, m.endSec - m.startSec);
                    const spk = m.speaker || 1;
                    const label = m.speakerLabel || `Speaker ${spk}`;

                    if (!speakerStats.has(spk)) {
                        speakerStats.set(spk, { id: spk, label, count: 0, durationSec: 0 });
                    }
                    const st = speakerStats.get(spk);
                    st.count += 1;
                    st.durationSec += dur;

                    segments.push({
                        start: sStr,
                        end: eStr,
                        startSec: m.startSec,
                        endSec: m.endSec,
                        speaker: spk,
                        speakerLabel: label,
                        text: m.text
                    });
                    cleanLines.push(wantSpeakers ? `[${sStr} - ${eStr}] [${label}] ${m.text}` : `[${sStr} - ${eStr}] ${m.text}`);
                }

                const totalDur = Array.from(speakerStats.values()).reduce((acc, v) => acc + v.durationSec, 0) || 1;
                const speakers = Array.from(speakerStats.values())
                    .sort((a, b) => a.id - b.id)
                    .map(v => ({
                        id: v.id,
                        label: v.label,
                        count: v.count,
                        durationSec: Number(v.durationSec.toFixed(1)),
                        share: Math.round((v.durationSec / totalDur) * 100)
                    }));

                return {
                    transcript: cleanLines.join('\n'),
                    segments,
                    speakers,
                    speakerCount: speakers.length,
                    hadSpeakerCues
                };
            };

            const extractYouTubeCaptions = ({ fallbackToWhisper = false, fallbackNotice = null } = {}) => {
                writeEvent({
                    type: 'progress',
                    percent: 15,
                    status: 'Fetching YouTube timed captions...',
                    speed: 'Instant Subs',
                    eta: '~2s'
                });

                const cleanUrl = url.replace(/"/g, '\\"');
                const subDir = path.join(DOWNLOADS_DIR, `.sub_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
                fs.mkdirSync(subDir, { recursive: true });
                const subOutTpl = path.join(subDir, 'sub').replace(/\\/g, '/');
                const subLangFlag = chosenLang === 'auto' ? 'all' : 'en.*,en';
                const cmd = `${getBaseYtdlpCmd(url)} --write-sub --write-auto-sub --sub-format vtt --sub-lang "${subLangFlag}" --skip-download -o "${subOutTpl}" "${cleanUrl}"`;

                activeChild = exec(cmd, { maxBuffer: 1024 * 1024 * 15, windowsHide: true, timeout: 45000 }, (error, stdout, stderr) => {
                    activeChild = null;
                    let subOut = '';
                    try {
                        if (fs.existsSync(subDir)) {
                            const vttFiles = fs.readdirSync(subDir).filter(f => f.toLowerCase().endsWith('.vtt')).sort((a, b) => a.length - b.length);
                            if (vttFiles.length > 0) {
                                subOut = fs.readFileSync(path.join(subDir, vttFiles[0]), 'utf8').trim();
                            }
                        }
                    } catch (e) {
                    } finally {
                        try { fs.rmSync(subDir, { recursive: true, force: true }); } catch (e) {}
                    }

                    if (clientAborted || res.writableEnded) return;

                    const errOut = (stderr || '').trim();
                    const hasSubtitleCues = subOut.includes('-->') || subOut.startsWith('WEBVTT');

                    if (hasSubtitleCues) {
                        const parsed = parseYouTubeVtt(subOut);
                        if (parsed.segments.length > 0) {
                            if (cmd.includes('--cookies')) cookiesRejectedByYouTube = false;
                            console.log(`[Server YouTube Captions Extracted]: ${parsed.segments.length} lines (${parsed.speakerCount} speakers, cues=${parsed.hadSpeakerCues})`);
                            writeEvent({
                                type: 'progress',
                                percent: 100,
                                status: 'Subtitles Extracted',
                                speed: 'Instant',
                                eta: '0s'
                            });
                            let notice = fallbackNotice;
                            if (!notice && wantSpeakers && !parsed.hadSpeakerCues) {
                                notice = 'Instant YouTube captions do not contain voice audio — switch engine to "Whisper AI + Speakers" to separate speakers by voice.';
                            }
                            return finishStream({
                                type: 'result',
                                success: true,
                                transcript: parsed.transcript,
                                segments: parsed.segments,
                                speakers: parsed.speakers,
                                speakerCount: parsed.speakerCount,
                                platform: 'youtube',
                                source: 'youtube-autosub',
                                notice
                            });
                        }
                    }

                    if (!hasSubtitleCues && /not a bot|Sign in to confirm|cookies are no longer valid/i.test(errOut)) {
                        if (cmd.includes('--cookies')) cookiesRejectedByYouTube = true;
                        const lastErrLine = errOut.split(/[\r\n]+/).filter(Boolean).slice(-1)[0] || errOut.slice(0, 220);
                        console.warn(`[Server Transcript Bot Gate]: ${lastErrLine}`);
                        if (!fallbackToWhisper) {
                            return finishStream({
                                type: 'result',
                                success: false,
                                error: 'YouTube blocked this cloud IP ("Sign in to confirm you\'re not a bot"). Click Cookies (top right) to upload fresh YouTube cookies, then retry.'
                            });
                        }
                    }

                    if (fallbackToWhisper) {
                        runWhisperTranscription({ fallbackToCaptions: false });
                    } else {
                        finishStream({
                            type: 'result',
                            success: false,
                            error: 'No captions or audio stream could be extracted for this video.'
                        });
                    }
                });
            };

            function runWhisperTranscription({ fallbackToCaptions = false } = {}) {
                console.log(`[Server Running Local Whisper AI]: ${url} (platform=${platform}, speakers=${wantSpeakers}, lang=${chosenLang})`);
                const pyArgs = [path.join(__dirname, 'transcribe_whisper.py'), url, '--language', chosenLang];
                if (start) pyArgs.push('--start', start);
                if (end) pyArgs.push('--end', end);
                if (full) pyArgs.push('--full');
                if (!wantSpeakers) pyArgs.push('--no-speakers');
                if (title && String(title).trim()) pyArgs.push('--title', String(title).trim().slice(0, 140));

                writeEvent({
                    type: 'progress',
                    percent: 5,
                    status: 'Connecting to media stream...',
                    speed: 'Connecting...',
                    eta: '--'
                });

                const child = spawn(PYTHON_BIN, pyArgs, { windowsHide: true });
                activeChild = child;
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
                            writeEvent({
                                type: 'progress',
                                percent,
                                status,
                                speed: percent >= 88 ? 'Speaker AI' : 'Whisper AI',
                                eta: `${Math.max(1, Math.round(100 - percent))}% left`
                            });
                        }
                    }
                });

                child.stdout.on('data', data => {
                    stdoutData += data.toString();
                });

                child.on('close', () => {
                    activeChild = null;
                    if (clientAborted || res.writableEnded) return;

                    if (stdoutData.trim()) {
                        try {
                            const result = JSON.parse(stdoutData.trim());
                            if (result.cookiesRejected) cookiesRejectedByYouTube = true;
                            if (result.success) {
                                if (isYouTube && !result.cookiesRejected && getCookiesFlag(url)) {
                                    cookiesRejectedByYouTube = false;
                                }
                                console.log(`[Server Whisper Success]: ${result.segments?.length || 0} turns, ${result.speakerCount || 1} speaker(s), model=${result.model || 'whisper'}, lang=${result.language || 'en'}`);
                                return finishStream({
                                    type: 'result',
                                    success: true,
                                    transcript: result.transcript,
                                    segments: result.segments || [],
                                    speakers: result.speakers || [],
                                    speakerCount: typeof result.speakerCount === 'number' ? result.speakerCount : 0,
                                    language: result.language,
                                    model: result.model,
                                    platform: result.platform || platform,
                                    source: result.source || 'whisper-ai',
                                    notice: result.notice
                                });
                            } else if (result.error) {
                                console.error(`[Server Whisper Reported Error]: ${result.error}`);
                                if (fallbackToCaptions && isYouTube) {
                                    writeEvent({
                                        type: 'progress',
                                        percent: 12,
                                        status: 'Audio stream restricted — falling back to YouTube captions...',
                                        speed: 'Fallback',
                                        eta: '~2s'
                                    });
                                    return extractYouTubeCaptions({
                                        fallbackToWhisper: false,
                                        fallbackNotice: 'YouTube audio stream was restricted; loaded YouTube timed captions instead.'
                                    });
                                }
                                return finishStream({ type: 'result', success: false, error: result.error });
                            }
                        } catch (e) {
                            // Fall through to standard error handler
                        }
                    }

                    const errMsg = (stderrData || 'Whisper transcription failed').trim();
                    console.error(`[Server Whisper Error]: ${errMsg}`);
                    if (fallbackToCaptions && isYouTube) {
                        return extractYouTubeCaptions({
                            fallbackToWhisper: false,
                            fallbackNotice: 'Loaded YouTube timed captions (Whisper audio fallback).'
                        });
                    }
                    finishStream({ type: 'result', success: false, error: errMsg });
                });

                child.on('error', err => {
                    activeChild = null;
                    console.error(`[Server Whisper Spawn Error]: ${err.message}`);
                    finishStream({ type: 'result', success: false, error: err.message });
                });
            }

            if (chosenEngine === 'captions') {
                extractYouTubeCaptions({ fallbackToWhisper: true });
            } else {
                runWhisperTranscription({ fallbackToCaptions: isYouTube });
            }
        }).catch(err => {
            if (!res.headersSent) {
                res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message || 'Invalid payload' }));
            }
        });
        return;
    }

    // API Title Fetching Endpoint
    if (pathname === '/api/fetch-title' && req.method === 'POST') {
        readJsonBody(req).then(({ url }) => {
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
                            if (url.toLowerCase().includes('kick.com') && /\/videos?\//i.test(url)) {
                                return fetchKickPageMeta(url).then(meta => {
                                    if (meta && meta.title) {
                                        console.log(`[Server Kick VOD Title Fetched via Page]: "${meta.title}"`);
                                        res.writeHead(200, { 'Content-Type': 'application/json' });
                                        return res.end(JSON.stringify({ success: true, title: meta.title }));
                                    }
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ success: false, error: errDetail }));
                                }).catch(() => {
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ success: false, error: errDetail }));
                                });
                            }
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
        }).catch(err => {
            if (!res.headersSent) {
                res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message || 'Invalid payload' }));
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
            rejected: cookiesRejectedByYouTube,
            hasEnv: Boolean(process.env.YOUTUBE_COOKIES)
        }));
    }

    // API Upload / Update Cookies Endpoint (Save new cookies or clear expired ones)
    if (pathname === '/api/upload-cookies' && req.method === 'POST') {
        readJsonBody(req).then(({ cookies, action }) => {
            const cookiesPath = path.join(__dirname, 'cookies.txt');
            const resetYouTubeCookieCaches = () => {
                cookiesRejectedByYouTube = false;
                ytStreamCache.clear();
                ytStoryboardCache.clear();
                ytFrameResultCache.clear();
            };

            if (action === 'clear') {
                cookiesDisabled = true;
                resetYouTubeCookieCaches();
                if (fs.existsSync(cookiesPath)) {
                    try { fs.unlinkSync(cookiesPath); } catch (e) {}
                }
                console.log('[Cookies] Cleared & disabled cookies via web UI');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, message: 'Cookies cleared & disabled' }));
            }

            if (action === 'toggle') {
                cookiesDisabled = !cookiesDisabled;
                resetYouTubeCookieCaches();
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
            resetYouTubeCookieCaches();
            console.log(`[Cookies] Saved new cookies.txt (${cleanCookies.length} bytes) via web UI`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Successfully saved cookies (${cleanCookies.length} bytes)` }));
        }).catch(err => {
            res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message || 'Invalid payload' }));
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

    // Serve Static Files (strict allowlist + in-memory gzip & ETag cache; never serves cookies.txt, server.js, .env, .git, etc.)
    if (pathname === '/') pathname = '/index.html';
    try {
        const asset = getStaticAsset(pathname);
        if (!asset) {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end('<h1>404 Not Found</h1>');
        }

        const headers = {
            'Content-Type': asset.contentType,
            'ETag': asset.etag,
            'Vary': 'Accept-Encoding',
            'Cache-Control': 'no-cache, must-revalidate'
        };

        if (req.headers['if-none-match'] === asset.etag) {
            res.writeHead(304, headers);
            return res.end();
        }

        const acceptEnc = String(req.headers['accept-encoding'] || '');
        if (acceptEnc.includes('gzip')) {
            headers['Content-Encoding'] = 'gzip';
            headers['Content-Length'] = asset.gzip.length;
            res.writeHead(200, headers);
            return res.end(asset.gzip);
        }

        headers['Content-Length'] = asset.raw.length;
        res.writeHead(200, headers);
        res.end(asset.raw);
    } catch (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(err.code === 'ENOENT' ? 'Not Found' : `Server Error: ${err.code || 'READ_FAILED'}`);
    }
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
