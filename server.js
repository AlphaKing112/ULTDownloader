const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');
const urlModule = require('url');

// Token map: token -> { absPath, expires }
const downloadTokens = new Map();

let PORT = parseInt(process.env.PORT, 10) || 3005;
const PUBLIC_DIR = __dirname;

function getCookiesFlag(url = '') {
    // ONLY apply YouTube cookies for YouTube links! (Prevents breaking Twitch, Kick, TikTok, etc.)
    if (url && !url.toLowerCase().includes('youtube.com') && !url.toLowerCase().includes('youtu.be')) {
        return '';
    }

    const cookiesPath = path.join(__dirname, 'cookies.txt');

    if (process.env.YOUTUBE_COOKIES) {
        try {
            let cookieText = process.env.YOUTUBE_COOKIES.trim();
            if (cookieText.length > 20) {
                if (cookieText.includes('\\n') && !cookieText.includes('\n')) {
                    cookieText = cookieText.replace(/\\n/g, '\n');
                }
                if (cookieText.includes('\\t')) {
                    cookieText = cookieText.replace(/\\t/g, '\t');
                }
                fs.writeFileSync(cookiesPath, cookieText);
                return ` --cookies "${cookiesPath}"`;
            }
        } catch (e) {}
    }

    if (fs.existsSync(cookiesPath)) {
        try {
            const stat = fs.statSync(cookiesPath);
            if (stat.size > 20) {
                return ` --cookies "${cookiesPath}"`;
            }
        } catch (e) {}
    }

    return '';
}

function getBaseYtdlpCmd(url = '') {
    const cookiesFlag = getCookiesFlag(url);
    const impersonateFlag = (url && url.toLowerCase().includes('kick.com')) ? ' --impersonate Chrome' : '';
    if (cookiesFlag) {
        return `yt-dlp${cookiesFlag}${impersonateFlag} --js-runtimes node`;
    }
    return `yt-dlp${impersonateFlag} --js-runtimes node`;
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
                    if (!finalCommand.includes('--impersonate') && finalCommand.toLowerCase().includes('kick.com')) {
                        finalCommand = finalCommand.replace(/\byt-dlp\b/g, 'yt-dlp --impersonate Chrome');
                    }
                    if (!finalCommand.includes('--sleep-requests')) {
                        finalCommand = finalCommand.replace(/\byt-dlp\b/g, 'yt-dlp --sleep-requests 1.5');
                    }
                    if (!finalCommand.includes('--js-runtimes')) {
                        finalCommand = finalCommand.replace(/\byt-dlp\b/g, 'yt-dlp --js-runtimes node');
                    }
                    const cookiesFlag = getCookiesFlag(command);
                    if (cookiesFlag && !finalCommand.includes('--cookies')) {
                        finalCommand = finalCommand.replace(/--extractor-args\s+"[^"]*"/g, '');
                        finalCommand = finalCommand.replace(/\byt-dlp\b/g, `yt-dlp${cookiesFlag}`);
                    } else if (!cookiesFlag && !finalCommand.includes('--extractor-args')) {
                        finalCommand = finalCommand.replace(/\byt-dlp\b/g, 'yt-dlp --extractor-args "youtube:player_client=android_vr,web_creator"');
                    }
                }

                console.log(`[Server Executing Command Stream]: ${finalCommand}`);

                res.writeHead(200, {
                    'Content-Type': 'application/x-ndjson; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });

                const child = exec(finalCommand, { maxBuffer: 1024 * 1024 * 50, windowsHide: true });

                const handleOutput = (data, defaultType = 'info') => {
                    const text = data.toString();
                    const lines = text.split(/[\r\n]+/);
                    
                    lines.forEach(line => {
                        const trimmed = line.trim();
                        if (!trimmed) return;
                        
                        let percentMatch = trimmed.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
                        let speedMatch = trimmed.match(/at\s+([0-9\.]+\s*[KMGk]?i?B\/s)/i) || trimmed.match(/speed=\s*([0-9\.]+\s*x)/i);
                        let etaMatch = trimmed.match(/ETA\s+([0-9:]+)/i);

                        if (!percentMatch && trimmed.includes('frame=')) {
                            let frameMatch = trimmed.match(/frame=\s*(\d+)/i);
                            if (frameMatch) {
                                let frameNum = parseInt(frameMatch[1], 10);
                                let simPercent = Math.min(99, Math.floor((frameNum / 250) * 100));
                                percentMatch = [null, simPercent.toString()];
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
                const cleanUrl = url.replace(/"/g, '\\"');
                const cmd = `${getBaseYtdlpCmd(url)} -j --no-warnings "${cleanUrl}"`;

                exec(cmd, { maxBuffer: 1024 * 1024 * 10, windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
                    if (error || !stdout || !stdout.trim()) {
                        const errDetail = (stderr || error?.message || 'No metadata returned').trim();
                        console.error(`[Server Metadata Fetch Error]: ${errDetail}`);
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

    // API Subtitle & Transcript Fetching Endpoint (Zero Disk Storage!)
    if (pathname === '/api/fetch-transcript' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { url } = JSON.parse(body);
                if (!url) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'URL required' }));
                }

                console.log(`[Server Extracting In-Memory Transcript]: ${url}`);
                const cleanUrl = url.replace(/"/g, '\\"');
                const cmd = `${getBaseYtdlpCmd(url)} --write-auto-sub --sub-lang en --skip-download -o "-" "${cleanUrl}"`;

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

                    const transcriptText = cleanLines.length > 0 ? cleanLines.join('\n') : 'No automatic transcript subtitles found for this video.';
                    console.log(`[Server Transcript Extracted]: ${cleanLines.length} subtitle lines`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, transcript: transcriptText }));
                });
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
                const cleanUrl = url.replace(/"/g, '\\"');
                const cmd = `${getBaseYtdlpCmd(url)} --print title --no-warnings "${cleanUrl}"`;
                
                exec(cmd, { maxBuffer: 1024 * 1024 * 5, windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
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
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid payload' }));
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
            res.writeHead(200, { 'Content-Type': contentType });
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
