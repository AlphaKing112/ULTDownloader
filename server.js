const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

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
            let cookieText = process.env.YOUTUBE_COOKIES;
            if (cookieText.includes('\\n') && !cookieText.includes('\n')) {
                cookieText = cookieText.replace(/\\n/g, '\n');
            }
            if (cookieText.includes('\\t')) {
                cookieText = cookieText.replace(/\\t/g, '\t');
            }
            fs.writeFileSync(cookiesPath, cookieText);
            return ` --cookies "${cookiesPath}"`;
        } catch (e) {}
    }

    if (fs.existsSync(cookiesPath)) {
        return ` --cookies "${cookiesPath}"`;
    }

    return '';
}

function getBaseYtdlpCmd(url = '') {
    const cookiesFlag = getCookiesFlag(url);
    if (cookiesFlag) {
        return `yt-dlp${cookiesFlag} --js-runtimes node`;
    }
    return `yt-dlp --js-runtimes node`;
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
        return res.end(`User-agent: *\nAllow: /\nSitemap: https://${req.headers.host || 'localhost'}/sitemap.xml\n`);
    }

    // SEO Sitemap.xml for Google Crawling
    if (pathname === '/sitemap.xml') {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        const host = req.headers.host || 'localhost';
        return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://${host}/</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`);
    }

    // API Direct File Download Endpoint (For Cloud Deployment)
    if (pathname.startsWith('/api/download-file')) {
        const fileParam = parsedUrl.searchParams.get('file');
        if (!fileParam) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'file param required' }));
        }

        const safeFilename = path.basename(fileParam);
        const targetPath = path.join(PUBLIC_DIR, 'downloads', safeFilename);

        if (fs.existsSync(targetPath)) {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${safeFilename}"`
            });
            fs.createReadStream(targetPath).pipe(res);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<h1>404 File Not Found</h1>');
        }
        return;
    }

    // API Health Check
    if (pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', server: 'Clip Vault Studio Backend', uptime: process.uptime() }));
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
                const cookiesFlag = getCookiesFlag(command);
                if (cookiesFlag && finalCommand.startsWith('yt-dlp')) {
                    // Remove conflicting extractor-args when cookies are active
                    finalCommand = finalCommand.replace(/--extractor-args\s+"[^"]*"/g, '');
                    finalCommand = finalCommand.replace(/^yt-dlp/, `yt-dlp${cookiesFlag}`);
                }

                console.log(`[Server Executing Command Stream]: ${finalCommand}`);

                res.writeHead(200, {
                    'Content-Type': 'application/x-ndjson; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });

                const child = exec(command, { maxBuffer: 1024 * 1024 * 50, windowsHide: true });

                const handleOutput = (data, defaultType = 'info') => {
                    const text = data.toString();
                    const lines = text.split(/[\r\n]+/);
                    
                    lines.forEach(line => {
                        const trimmed = line.trim();
                        if (!trimmed) return;
                        
                        let percentMatch = trimmed.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
                        let speedMatch = trimmed.match(/at\s+([0-9\.]+\s*[KMGk]?i?B\/s)/i);
                        let etaMatch = trimmed.match(/ETA\s+([0-9:]+)/i);

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
                    res.write(JSON.stringify({ done: true, exitCode: code }) + '\n');
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
                        console.error(`[Server Metadata Fetch Error]: ${error ? error.message : 'No metadata returned'}`);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'Could not fetch metadata' }));
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
                        console.error(`[Server Fetch Title Error]: ${error ? error.message : 'No title returned'}`);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'Could not fetch title from media link' }));
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
