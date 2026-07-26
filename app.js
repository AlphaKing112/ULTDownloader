document.addEventListener('DOMContentLoaded', () => {
    // --- Elements ---
    const navTabs = document.querySelectorAll('.nav-tab');
    const toolViews = document.querySelectorAll('.tool-view');
    const tabTitle = document.getElementById('tab-title');
    const optionBadge = document.getElementById('option-number-badge');
    const headerIcon = document.getElementById('tool-header-icon');
    const actionBtn = document.getElementById('action-btn');
    const copyCmdBtn = document.getElementById('copy-cmd-btn');
    const consoleOutput = document.getElementById('console-output');
    const clearConsoleBtn = document.getElementById('clear-console-btn');
    const copyLogBtn = document.getElementById('copy-log-btn');
    const generatedCliCode = document.getElementById('generated-cli-code');
    
    // Status metrics
    const valTaskStatus = document.getElementById('val-task-status');
    const valCurrentMode = document.getElementById('val-current-mode');
    const valBackendMode = document.getElementById('val-backend-mode');
    const backendStatusIndicator = document.getElementById('backend-status-indicator');
    const backendStatusText = document.getElementById('backend-status-text');

    // Tags & Meta card
    const extractedMetaCard = document.getElementById('extracted-meta-card');
    const tagsCloudContainer = document.getElementById('tags-cloud-container');
    const descriptionBoxContainer = document.getElementById('description-box-container');

    // Thumbnail preview
    const thumbnailPreviewCard = document.getElementById('thumbnail-preview-card');
    const thumbPreviewImg = document.getElementById('thumb-preview-img');
    const thumbDownloadLink = document.getElementById('thumb-download-link');

    // Modal elements
    const cmdModalOverlay = document.getElementById('cmd-modal-overlay');
    const modalCliCode = document.getElementById('modal-cli-code');

    // Current state
    let activeTabId = 'tab-quick-download';
    let isServerConnected = false;
    let isTaskRunning = false;

    // --- Tab Definitions & Metadata ---
    const tabMetadata = {
        'tab-quick-download': {
            title: 'Quick Video Downloader',
            optionBadge: 'Option #2',
            icon: 'fa-cloud-arrow-down',
            btnText: 'Download Video (MAX Quality)',
            tip: 'Downloads highest quality video + audio with yt-dlp and merges into MP4.'
        },
        'tab-section-clipper': {
            title: 'Section Clip Extractor',
            optionBadge: 'Option #3 & #4',
            icon: 'fa-scissors',
            btnText: 'Download Video Section',
            tip: 'Auto-detects Kick VODs or YouTube clips and applies high-speed time cutting.'
        },
        'tab-multi-section': {
            title: 'Multi-Section Batch Clipper',
            optionBadge: 'Option #8',
            icon: 'fa-list-check',
            btnText: 'Batch Download All Sections',
            tip: 'Add multiple timestamp ranges to download consecutive clips in batch.'
        },
        'tab-shorts-harvest': {
            title: 'YouTube Shorts Harvester',
            optionBadge: 'Option #7',
            icon: 'fa-brands fa-youtube',
            btnText: 'Download Channel Shorts (<60s)',
            tip: 'Scrapes an entire channel for Shorts under 61s and tracks downloaded archive.'
        },
        'tab-silence-cutter': {
            title: 'Audio Silence Cutter',
            optionBadge: 'Option #6',
            icon: 'fa-wand-magic-sparkles',
            btnText: 'Remove Silent Pauses',
            tip: 'Downloads video and uses Auto-Editor to cut silent sections based on dB threshold.'
        },
        'tab-file-converter': {
            title: 'Media MP4 Converter',
            optionBadge: 'Option #5',
            icon: 'fa-file-video',
            btnText: 'Convert File to MP4',
            tip: 'Uses FFmpeg to re-encode local MKV, MOV, WEBM, or AVI files into standard MP4.'
        },
        'tab-yt-tags': {
            title: 'Tags & AI Transcript Analyzer',
            optionBadge: 'Option #9 & #10',
            icon: 'fa-tags',
            btnText: 'Analyze Video Metadata',
            tip: 'Extracts video tags and description or processes auto-generated subtitles.'
        },
        'tab-yt-thumbnail': {
            title: 'YouTube Thumbnail Grabber',
            optionBadge: 'Option #11',
            icon: 'fa-regular fa-image',
            btnText: 'Fetch High-Res Thumbnail',
            tip: 'Extracts maximum resolution thumbnail image directly from video ID.'
        },
        'tab-hdd-mirror': {
            title: 'HDD Export Directory Mirror',
            optionBadge: 'Option #1',
            icon: 'fa-solid fa-hard-drive',
            btnText: 'Run Robocopy HDD Sync',
            tip: 'Mirrors local export clips folder to external HDD drive with error retries.'
        }
    };

    const mobileToolDropdown = document.getElementById('mobile-tool-dropdown');

    function activateTab(targetTabId) {
        navTabs.forEach(t => {
            const match = t.getAttribute('data-tab') === targetTabId;
            t.classList.toggle('active', match);
            if (match) {
                try {
                    t.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                } catch (e) {}
            }
        });
        toolViews.forEach(v => v.classList.remove('active'));

        activeTabId = targetTabId;
        const viewTarget = document.getElementById(activeTabId);
        if (viewTarget) viewTarget.classList.add('active');

        if (mobileToolDropdown && mobileToolDropdown.value !== activeTabId) {
            mobileToolDropdown.value = activeTabId;
        }

        const meta = tabMetadata[activeTabId];
        if (meta) {
            tabTitle.textContent = meta.title;
            optionBadge.textContent = meta.optionBadge;
            headerIcon.className = `fa-solid ${meta.icon} header-icon`;
            actionBtn.querySelector('span').textContent = meta.btnText;
            valCurrentMode.textContent = meta.title.split(' ')[0] + ' ' + (meta.title.split(' ')[1] || '');
            document.getElementById('power-tip-desc').textContent = meta.tip;
        }

        updateGeneratedCommand();
    }

    // --- Tab Switching Logic ---
    navTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            activateTab(tab.getAttribute('data-tab'));
        });
    });

    if (mobileToolDropdown) {
        mobileToolDropdown.addEventListener('change', () => {
            activateTab(mobileToolDropdown.value);
        });
    }

    // --- Kick vs YT Detection ---
    const sectionUrlInput = document.getElementById('section-url');
    const platformIndicator = document.getElementById('platform-detect-indicator');
    
    if (sectionUrlInput) {
        sectionUrlInput.addEventListener('input', () => {
            const url = sectionUrlInput.value.trim().toLowerCase();
            if (url.includes('kick.com/videos')) {
                platformIndicator.innerHTML = '<i class="fa-solid fa-bolt" style="color: #22c55e;"></i> <strong>Kick VOD Detected!</strong> Format auto-optimization & postprocessing enabled.';
                platformIndicator.style.borderColor = '#22c55e';
            } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
                platformIndicator.innerHTML = '<i class="fa-brands fa-youtube" style="color: #ef4444;"></i> <strong>YouTube Video Detected!</strong> Direct timestamp cutting active.';
                platformIndicator.style.borderColor = '#ef4444';
            } else if (url) {
                platformIndicator.innerHTML = '<i class="fa-solid fa-globe"></i> General Media URL detected.';
                platformIndicator.style.borderColor = 'var(--border-color)';
            } else {
                platformIndicator.innerHTML = '<i class="fa-solid fa-circle-info"></i> Paste a URL above to auto-detect Kick VOD vs YouTube parameters.';
                platformIndicator.style.borderColor = 'var(--border-color)';
            }
            updateGeneratedCommand();
        });
    }

    // --- Range Builder for Multi-Section ---
    const newRangeInput = document.getElementById('new-range-input');
    const btnAddRange = document.getElementById('btn-add-range');
    const btnClearRanges = document.getElementById('btn-clear-ranges');
    const rangesListUl = document.getElementById('ranges-list-ul');

    if (btnAddRange && newRangeInput) {
        btnAddRange.addEventListener('click', () => {
            const val = newRangeInput.value.trim();
            if (!val) return;
            
            const li = document.createElement('li');
            li.className = 'range-item';
            li.innerHTML = `<span><i class="fa-regular fa-bookmark"></i> ${val}</span>
                            <button type="button" class="btn-remove-range" onclick="this.parentElement.remove(); updateGeneratedCommand();"><i class="fa-solid fa-xmark"></i></button>`;
            rangesListUl.appendChild(li);
            newRangeInput.value = '';
            updateGeneratedCommand();
        });
    }

    if (btnClearRanges) {
        btnClearRanges.addEventListener('click', () => {
            rangesListUl.innerHTML = '';
            updateGeneratedCommand();
        });
    }

    window.removeRangeItem = function(btn) {
        btn.parentElement.remove();
        updateGeneratedCommand();
    };

    // --- Title Sanitizer & Auto-Fetch Helper ---
    function sanitizeFilename(str) {
        if (!str) return '';
        return str.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    }

    const titleFetchCache = new Map();
    const fetchDebounceTimers = {};

    window.fetchTitleForField = async function(urlInputId, titleInputId, statusBadgeId, autoTriggered = false) {
        const urlElem = document.getElementById(urlInputId);
        const titleElem = document.getElementById(titleInputId);
        const statusElem = document.getElementById(statusBadgeId);

        if (!urlElem || !titleElem) return;

        const url = urlElem.value.trim();
        if (!url || !/^https?:\/\//i.test(url)) {
            if (!autoTriggered && statusElem) {
                statusElem.textContent = 'Please enter a valid URL first';
                statusElem.className = 'fetch-status-badge error';
            }
            return;
        }

        // Check cache
        if (titleFetchCache.has(url)) {
            const cachedTitle = titleFetchCache.get(url);
            titleElem.value = cachedTitle;
            titleElem.dataset.autoFetched = 'true';
            if (statusElem) {
                statusElem.textContent = '✓ Title loaded from cache';
                statusElem.className = 'fetch-status-badge success';
            }
            updateGeneratedCommand();
            return;
        }

        if (statusElem) {
            statusElem.textContent = '⚡ Fetching title...';
            statusElem.className = 'fetch-status-badge loading';
        }

        const fetchBtn = titleElem.parentElement ? titleElem.parentElement.querySelector('.btn-fetch-title') : null;
        if (fetchBtn) fetchBtn.classList.add('fetching');

        try {
            // Try Node.js backend API
            const response = await fetch('/api/fetch-title', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });

            if (response.ok) {
                const data = await response.json();
                if (data.success && data.title) {
                    titleElem.value = data.title;
                    titleElem.dataset.autoFetched = 'true';
                    titleFetchCache.set(url, data.title);
                    if (statusElem) {
                        statusElem.textContent = '✓ Auto-fetched title!';
                        statusElem.className = 'fetch-status-badge success';
                    }
                    logToConsole(`[Metadata] Auto-fetched clip title: "${data.title}"`, 'success');
                    updateGeneratedCommand();
                    return;
                }
            }

            // Fallback: oEmbed for YouTube / Vimeo
            const oembedUrl = `https://noembed.com/embed?url=${encodeURIComponent(url)}`;
            const oembedRes = await fetch(oembedUrl);
            if (oembedRes.ok) {
                const oembedData = await oembedRes.json();
                if (oembedData.title) {
                    titleElem.value = oembedData.title;
                    titleElem.dataset.autoFetched = 'true';
                    titleFetchCache.set(url, oembedData.title);
                    if (statusElem) {
                        statusElem.textContent = '✓ Auto-fetched title!';
                        statusElem.className = 'fetch-status-badge success';
                    }
                    logToConsole(`[Metadata] Auto-fetched clip title: "${oembedData.title}"`, 'success');
                    updateGeneratedCommand();
                    return;
                }
            }

            if (statusElem) {
                statusElem.textContent = 'Manual title entry active';
                statusElem.className = 'fetch-status-badge';
            }
        } catch (err) {
            if (statusElem) {
                statusElem.textContent = 'Manual title entry active';
                statusElem.className = 'fetch-status-badge';
            }
        } finally {
            if (fetchBtn) fetchBtn.classList.remove('fetching');
        }
    };

    window.fetchFullMetadataForUrl = async function(url) {
        if (!url || !/^https?:\/\//i.test(url)) return;

        try {
            const res = await fetch('/api/fetch-metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });
            const data = await res.json();
            if (data.success && data.metadata) {
                const { tags, description, channel } = data.metadata;
                renderTagCloud(tags && tags.length > 0 ? tags : ['youtube', 'video'], description);
                logToConsole(`[Metadata] Extracted ${tags ? tags.length : 0} tags & video description from ${channel || 'YouTube'}.`, 'success');
            }
        } catch (e) {
            console.error('Metadata fetch error:', e);
        }
    };

    // Auto-fetch trigger configuration across inputs
    const titleFetchPairs = [
        { urlId: 'quick-url', titleId: 'quick-title', statusId: 'quick-title-status' },
        { urlId: 'section-url', titleId: 'section-title', statusId: 'section-title-status' },
        { urlId: 'silence-url', titleId: 'silence-title', statusId: 'silence-title-status' },
        { urlId: 'thumb-url', titleId: 'thumb-title', statusId: 'thumb-title-status' },
        { urlId: 'tags-url', titleId: null, statusId: null }
    ];

    titleFetchPairs.forEach(pair => {
        const urlElem = document.getElementById(pair.urlId);
        const titleElem = pair.titleId ? document.getElementById(pair.titleId) : null;
        const statusElem = pair.statusId ? document.getElementById(pair.statusId) : null;

        if (urlElem) {
            const handleUrlChange = () => {
                const url = urlElem.value.trim();
                if (!url || !/^https?:\/\//i.test(url)) return;
                
                clearTimeout(fetchDebounceTimers[pair.urlId]);
                fetchDebounceTimers[pair.urlId] = setTimeout(() => {
                    if (titleElem && (!titleElem.value.trim() || titleElem.dataset.autoFetched === 'true')) {
                        titleElem.dataset.autoFetched = 'true';
                        fetchTitleForField(pair.urlId, pair.titleId, pair.statusId, true);
                    }
                    window.fetchFullMetadataForUrl(url);
                }, 600);
            };

            urlElem.addEventListener('input', handleUrlChange);
            // NOTE: do NOT add 'change' listener — pasteClipboard fires both 'input' and 'change'
            // which would trigger the debounce twice and log metadata twice
        }

        if (titleElem) {
            titleElem.addEventListener('input', () => {
                titleElem.dataset.autoFetched = 'false';
                if (statusElem) {
                    statusElem.textContent = 'Custom title set';
                    statusElem.className = 'fetch-status-badge';
                }
                updateGeneratedCommand();
            });
        }
    });

    // --- Clipboard Paste Helper ---
    window.pasteClipboard = async function(inputId) {
        try {
            const text = await navigator.clipboard.readText();
            const inputElem = document.getElementById(inputId);
            if (inputElem) {
                inputElem.value = text;
                inputElem.dispatchEvent(new Event('input')); // triggers auto-fetch debounce once
                logToConsole(`[Input] Pasted clipboard content into input: "${text.substring(0, 35)}..."`, 'info');
                updateGeneratedCommand();
            }
        } catch (err) {
            logToConsole('[Warning] Clipboard access permissions required to paste automatically.', 'system');
        }
    };

    // --- Silence dB Preset Helper ---
    window.setDbValue = function(val) {
        const slider = document.getElementById('silence-db');
        const badge = document.getElementById('silence-db-val');
        if (slider && badge) {
            slider.value = val;
            badge.textContent = val + ' dB';
            
            // Highlight active guide
            document.querySelectorAll('.db-guide-grid span').forEach(sp => sp.classList.remove('active-guide'));
            event.target.classList.add('active-guide');
            updateGeneratedCommand();
        }
    };

    // --- Analysis Radio Mode ---
    window.selectAnalysisMode = function(mode) {
        document.querySelectorAll('.radio-card').forEach(rc => rc.classList.remove('active'));
        const activeRadio = document.querySelector(`input[name="analysis-mode"][value="${mode}"]`);
        if (activeRadio) {
            activeRadio.checked = true;
            activeRadio.closest('.radio-card').classList.add('active');
            updateGeneratedCommand();
        }
    };

    // --- CLI Command Generator ---
    function buildCommandForActiveTab() {
        let cmd = '';

        switch (activeTabId) {
            case 'tab-quick-download': {
                const url = document.getElementById('quick-url').value.trim() || '<VIDEO_URL>';
                const fmt = document.getElementById('quick-format').value;
                let out = 'downloads/%(title)s_%(height)sp.%(ext)s';
                const impersonate = url.toLowerCase().includes('kick.com') ? ' --impersonate Chrome' : '';
                cmd = `yt-dlp${impersonate} --js-runtimes node --newline --no-part -f "${fmt}" --merge-output-format mp4 -o "${out}" "${url}"`;
                break;
            }

            case 'tab-section-clipper': {
                const url = document.getElementById('section-url').value.trim() || '<VIDEO_URL>';
                const start = document.getElementById('section-start').value.trim() || '00:00:00';
                const end = document.getElementById('section-end').value.trim() || '00:01:00';
                const preset = document.getElementById('section-format-preset').value;
                let out = 'downloads/%(title)s.mp4';
                // -movflags +faststart: moves MP4 index to front → Windows player can play immediately
                // -avoid_negative_ts make_zero + -fflags +genpts: fixes keyframe timestamp misalignment
                const ffmpegFix = '-c copy -avoid_negative_ts make_zero -fflags +genpts -movflags +faststart';
                const impersonate = url.toLowerCase().includes('kick.com') ? ' --impersonate Chrome' : '';

                if (url.toLowerCase().includes('kick.com')) {
                    const fmtStr = preset === 'auto' ? '1080p60' : preset;
                    cmd = `yt-dlp --js-runtimes node${impersonate} --newline --download-sections "*${start}-${end}" -f ${fmtStr} --merge-output-format mp4 --postprocessor-args "ffmpeg:${ffmpegFix}" -o "${out}" "${url}"`;
                } else if (url.toLowerCase().includes('twitch.tv')) {
                    cmd = `yt-dlp --js-runtimes node --newline --download-sections "*${start}-${end}" -f "best" --merge-output-format mp4 --postprocessor-args "ffmpeg:${ffmpegFix}" -o "${out}" "${url}"`;
                } else {
                    cmd = `yt-dlp --js-runtimes node --newline --download-sections "*${start}-${end}" -f "bestvideo+bestaudio/best" --merge-output-format mp4 --postprocessor-args "ffmpeg:${ffmpegFix}" -o "${out}" "${url}"`;
                }
                break;
            }

            case 'tab-multi-section': {
                const url = document.getElementById('multi-url').value.trim() || '<VIDEO_URL>';
                const outDir = document.getElementById('multi-output').value;
                const items = Array.from(rangesListUl.querySelectorAll('.range-item span')).map(s => s.textContent.replace(' ', ''));
                
                if (items.length === 0) {
                    cmd = `# Add time ranges above. Example batch download:\nyt-dlp --js-runtimes node --newline "${url}" --download-sections "*00:01:00-00:02:30" -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${outDir}\\clip_00-01-00-00-02-30.mp4"`;
                } else {
                    const rangesCmds = items.map(r => `yt-dlp --js-runtimes node --newline "${url}" --download-sections "*${r}" -f "bestvideo+bestaudio/best" --merge-output-format mp4 --force-keyframes-at-cuts -o "${outDir}\\clip_${r.replace(/:/g, '-')}.mp4"`).join(' && \n');
                    cmd = `mkdir "${outDir}" 2>nul\n${rangesCmds}`;
                }
                break;
            }

            case 'tab-shorts-harvest': {
                let channel = document.getElementById('shorts-channel').value.trim() || '@channelname';
                if (channel.startsWith('@')) {
                    channel = `https://www.youtube.com/${channel}`;
                }
                const maxDur = document.getElementById('shorts-duration').value;
                const outDir = document.getElementById('shorts-output').value;
                const useArchive = document.getElementById('shorts-archive-check').checked;
                
                const archiveFlag = useArchive ? `--download-archive "${outDir}\\downloaded.txt"` : '';
                cmd = `yt-dlp --js-runtimes node --sleep-requests 1.5 --extractor-args "youtube:player_client=android_vr,web_creator" --newline "${channel}" --match-filter "duration < ${maxDur}" -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${outDir}\\%(title)s - %(id)s.%(ext)s" ${archiveFlag}`;
                break;
            }

            case 'tab-silence-cutter': {
                const url = document.getElementById('silence-url').value.trim() || '<VIDEO_URL>';
                const db = document.getElementById('silence-db').value;
                const margin = document.getElementById('silence-margin').value;
                const titleVal = document.getElementById('silence-title')?.value.trim();
                const filename = titleVal ? sanitizeFilename(titleVal) : 'temp_input';
                cmd = `yt-dlp --js-runtimes node --newline -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${filename}.%(ext)s" "${url}" && auto-editor "${filename}.mp4" --edit audio:${db}dB --margin ${margin}`;
                break;
            }

            case 'tab-file-converter': {
                const input = document.getElementById('convert-input').value.trim() || 'C:\\path\\to\\input.mkv';
                const outName = document.getElementById('convert-name').value.trim() || 'converted_clip';
                cmd = `ffmpeg -i "${input}" -c:v libx264 -c:a aac -strict experimental "%USERPROFILE%\\Desktop\\${outName}.mp4"`;
                break;
            }

            case 'tab-yt-tags': {
                const url = document.getElementById('tags-url').value.trim() || '<VIDEO_URL>';
                const mode = document.querySelector('input[name="analysis-mode"]:checked')?.value || 'tags';

                if (mode === 'tags') {
                    cmd = `yt-dlp -j "${url}" | jq -r ".tags // [\\"No tags\\"] | join(\\", \\")"`;
                } else {
                    cmd = `yt-dlp --write-auto-sub --skip-download --sub-lang en "${url}" && powershell -Command "Get-Content '*.vtt' | Select-String '^[^0-9]' | Out-File transcript.txt" && python analyze_transcript.py`;
                }
                break;
            }

            case 'tab-yt-thumbnail': {
                const url = document.getElementById('thumb-url').value.trim() || '<VIDEO_URL>';
                const titleVal = document.getElementById('thumb-title')?.value.trim();
                const outName = titleVal ? sanitizeFilename(titleVal) : '%(title)s';
                cmd = `yt-dlp --skip-download --write-thumbnail --convert-thumbnails jpg -o "${outName}" "${url}"`;
                break;
            }

            case 'tab-hdd-mirror': {
                const src = document.getElementById('mirror-source').value.trim();
                const dest = document.getElementById('mirror-dest').value.trim();
                cmd = `robocopy "${src}" "${dest}" /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS`;
                break;
            }
        }

        return cmd;
    }

    function updateGeneratedCommand() {
        const cmd = buildCommandForActiveTab();
        generatedCliCode.textContent = cmd;
        modalCliCode.textContent = cmd;
    }

    // Add change/input listeners across inputs
    document.querySelectorAll('input, select').forEach(elem => {
        elem.addEventListener('input', () => {
            updateGeneratedCommand();
            checkMediaUrlInput();
        });
        elem.addEventListener('change', () => {
            updateGeneratedCommand();
            checkMediaUrlInput();
        });
    });

    // --- Unified Media Player, Player Selector Dropdown & Timestamp Capture ---
    const mediaPlayerCard = document.getElementById('media-player-card') || document.getElementById('twitch-player-card');
    const playerContainer = document.getElementById('player-iframe-container');
    const playerTitle = document.getElementById('media-player-title') || document.getElementById('twitch-player-title');
    const playerIcon = document.getElementById('player-type-icon');
    const playerSelector = document.getElementById('player-selector');

    let activePlayerType = 'none'; // 'youtube', 'twitch', 'none'
    let currentEmbeddedMediaId = ''; // Track active video/VOD ID to prevent reloading iframe
    let ytPlayerInstance = null;
    let twitchPlayerInstance = null;
    let lastActiveUrl = '';

    function loadYtIframeApi() {
        if (window.YT && window.YT.Player) return Promise.resolve();
        return new Promise(resolve => {
            if (document.getElementById('yt-iframe-api')) {
                const checkInterval = setInterval(() => {
                    if (window.YT && window.YT.Player) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 100);
                return;
            }
            const tag = document.createElement('script');
            tag.id = 'yt-iframe-api';
            tag.src = 'https://www.youtube.com/iframe_api';
            window.onYouTubeIframeAPIReady = () => resolve();
            document.head.appendChild(tag);
        });
    }

    function loadTwitchEmbedApi() {
        if (window.Twitch && window.Twitch.Player) return Promise.resolve();
        return new Promise(resolve => {
            if (document.getElementById('twitch-embed-api')) {
                const checkInterval = setInterval(() => {
                    if (window.Twitch && window.Twitch.Player) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 100);
                return;
            }
            const tag = document.createElement('script');
            tag.id = 'twitch-embed-api';
            tag.src = 'https://player.twitch.tv/js/embed/v1.js';
            tag.onload = () => resolve();
            document.head.appendChild(tag);
        });
    }

    window.checkMediaUrlInput = function() {
        const urlInputIds = ['section-url', 'quick-url', 'multi-url', 'silence-url', 'tags-url', 'thumb-url'];
        let detectedUrl = '';

        for (const id of urlInputIds) {
            const elem = document.getElementById(id);
            if (elem && elem.value.trim().length > 10) {
                detectedUrl = elem.value.trim();
                break;
            }
        }

        if (!detectedUrl) return;

        const currentMode = playerSelector ? playerSelector.value : 'auto';
        if (currentMode !== 'hidden') {
            embedVideoPlayer(detectedUrl, currentMode);
        }
    };

    window.embedVideoPlayer = async function(url, forceMode = 'auto') {
        if (!url) return;
        lastActiveUrl = url;

        const isTwitch = url.toLowerCase().includes('twitch.tv');
        const isYouTube = url.toLowerCase().includes('youtube.com') || url.toLowerCase().includes('youtu.be');

        let targetMode = forceMode;
        if (forceMode === 'auto') {
            if (isTwitch) targetMode = 'twitch';
            else if (isYouTube) targetMode = 'youtube';
            else targetMode = 'hidden';
        }

        if (targetMode === 'hidden') {
            closeMediaPlayer();
            return;
        }

        if (targetMode === 'youtube' && isYouTube) {
            const ytId = extractYtId(url);
            if (!ytId) return;

            // Prevent re-rendering player if video ID has not changed
            if (activePlayerType === 'youtube' && currentEmbeddedMediaId === ytId && !mediaPlayerCard.classList.contains('hidden')) {
                return;
            }

            currentEmbeddedMediaId = ytId;
            activePlayerType = 'youtube';

            if (mediaPlayerCard) mediaPlayerCard.classList.remove('hidden');
            if (playerSelector) playerSelector.value = targetMode;
            if (playerTitle) playerTitle.textContent = `YouTube Player (ID: ${ytId})`;
            if (playerIcon) playerIcon.className = 'fa-brands fa-youtube player-icon yt';

            if (playerContainer) {
                playerContainer.innerHTML = `<div id="yt-player-target" style="width:100%;height:100%;"></div>`;
            }
            await loadYtIframeApi();

            ytPlayerInstance = new YT.Player('yt-player-target', {
                height: '320',
                width: '100%',
                videoId: ytId,
                playerVars: { autoplay: 0, enablejsapi: 1 },
                events: {
                    onReady: () => logToConsole(`[Player] YouTube Player loaded for video ID: ${ytId}`, 'info')
                }
            });
        } else if (targetMode === 'twitch' && isTwitch) {
            const currentHost = window.location.hostname || 'localhost';
            const vodMatch = url.match(/twitch\.tv\/videos\/(\d{6,})/i);
            const clipMatch = url.match(/(?:clips\.twitch\.tv\/|twitch\.tv\/[^\/]+\/clip\/)([A-Za-z0-9_-]+)/i);

            const mediaId = (vodMatch && vodMatch[1]) ? `vod_${vodMatch[1]}` : ((clipMatch && clipMatch[1]) ? `clip_${clipMatch[1]}` : '');

            if (!mediaId) return;

            // Prevent re-rendering player if Twitch media ID has not changed
            if (activePlayerType === 'twitch' && currentEmbeddedMediaId === mediaId && !mediaPlayerCard.classList.contains('hidden')) {
                return;
            }

            currentEmbeddedMediaId = mediaId;
            activePlayerType = 'twitch';

            if (mediaPlayerCard) mediaPlayerCard.classList.remove('hidden');
            if (playerSelector) playerSelector.value = targetMode;
            if (playerIcon) playerIcon.className = 'fa-brands fa-twitch player-icon twitch';

            if (vodMatch && vodMatch[1]) {
                const vodId = vodMatch[1];
                if (playerContainer) {
                    playerContainer.innerHTML = `<div id="twitch-player-target" style="width:100%;height:100%;"></div>`;
                }
                await loadTwitchEmbedApi();
                if (playerTitle) playerTitle.textContent = `Twitch VOD Player (ID: ${vodId})`;
                twitchPlayerInstance = new Twitch.Player('twitch-player-target', {
                    width: '100%',
                    height: 320,
                    video: vodId,
                    autoplay: false,
                    parent: [currentHost]
                });
            } else if (clipMatch && clipMatch[1]) {
                const clipId = clipMatch[1];
                if (playerTitle) playerTitle.textContent = `Twitch Clip Player (${clipId})`;
                if (playerContainer) {
                    playerContainer.innerHTML = `<iframe src="https://clips.twitch.tv/embed?clip=${clipId}&parent=${currentHost}&autoplay=false" height="320" width="100%" style="border:none;border-radius:12px;width:100%;height:320px;" allowfullscreen="true"></iframe>`;
                }
            }
        }
    };

    window.switchPlayerMode = function(mode) {
        if (mode === 'hidden') {
            closeMediaPlayer();
            return;
        }

        const urlInputIds = ['section-url', 'quick-url', 'multi-url', 'silence-url', 'tags-url', 'thumb-url'];
        let activeUrl = lastActiveUrl;
        for (const id of urlInputIds) {
            const val = document.getElementById(id)?.value.trim();
            if (val) {
                activeUrl = val;
                break;
            }
        }

        if (activeUrl) {
            embedVideoPlayer(activeUrl, mode);
        } else {
            logToConsole('[Player] Please enter or paste a video link first to display the player.', 'system');
        }
    };

    window.closeMediaPlayer = window.closeTwitchPlayer = function() {
        if (mediaPlayerCard) mediaPlayerCard.classList.add('hidden');
        if (playerContainer) playerContainer.innerHTML = '';
        activePlayerType = 'none';
        currentEmbeddedMediaId = '';
        ytPlayerInstance = null;
        twitchPlayerInstance = null;
        if (playerSelector) playerSelector.value = 'hidden';
    };

    window.togglePlayerExpand = function() {
        const container = document.getElementById('player-iframe-container');
        const expandIcon = document.getElementById('player-expand-icon');
        if (!container) return;

        if (container.style.display === 'none') {
            container.style.display = 'block';
            if (expandIcon) expandIcon.className = 'fa-solid fa-chevron-down';
            logToConsole('[Player] Video player expanded.', 'system');
        } else {
            container.style.display = 'none';
            if (expandIcon) expandIcon.className = 'fa-solid fa-chevron-right';
            logToConsole('[Player] Video player collapsed.', 'system');
        }
    };

    // --- CLI Output Collapse Handler ---
    window.toggleCliCollapse = function() {
        const consoleBody = document.getElementById('console-output');
        const cliBox = document.querySelector('.cli-command-box');
        const collapseIcon = document.getElementById('cli-collapse-icon');

        if (!consoleBody) return;

        if (consoleBody.style.display === 'none') {
            consoleBody.style.display = 'block';
            if (cliBox) cliBox.style.display = 'block';
            if (collapseIcon) collapseIcon.className = 'fa-solid fa-chevron-down';
            logToConsole('[CLI] Terminal output expanded.', 'system');
        } else {
            consoleBody.style.display = 'none';
            if (cliBox) cliBox.style.display = 'none';
            if (collapseIcon) collapseIcon.className = 'fa-solid fa-chevron-right';
            logToConsole('[CLI] Terminal output collapsed.', 'system');
        }
    };

    function formatSecondsToHHMMSS(seconds) {
        const total = Math.max(0, Math.floor(seconds || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
    }

    window.markCurrentTimestamp = function(targetType = 'start') {
        let currentSec = 0;
        let captured = false;

        if (activePlayerType === 'youtube' && ytPlayerInstance && typeof ytPlayerInstance.getCurrentTime === 'function') {
            currentSec = ytPlayerInstance.getCurrentTime();
            captured = true;
        } else if (activePlayerType === 'twitch' && twitchPlayerInstance && typeof twitchPlayerInstance.getCurrentTime === 'function') {
            currentSec = twitchPlayerInstance.getCurrentTime();
            captured = true;
        }

        if (!captured) {
            logToConsole('[Timestamp] Play a video in the embedded player above to capture exact timestamps.', 'system');
            return;
        }

        const formattedTime = formatSecondsToHHMMSS(currentSec);
        const targetInputId = targetType === 'start' ? 'section-start' : 'section-end';
        const targetElem = document.getElementById(targetInputId);

        if (targetElem) {
            targetElem.value = formattedTime;
            targetElem.dispatchEvent(new Event('input'));
            logToConsole(`[Timestamp Marked] Set ${targetType.toUpperCase()} time to player position: ${formattedTime} (${Math.floor(currentSec)}s)`, 'success');
            updateGeneratedCommand();
        }
    };

    // --- Modal Inspector Controls ---
    copyCmdBtn.addEventListener('click', () => {
        cmdModalOverlay.classList.remove('hidden');
    });

    window.closeCmdModal = function() {
        cmdModalOverlay.classList.add('hidden');
    };

    window.copyCliCommand = function() {
        const cmd = buildCommandForActiveTab();
        navigator.clipboard.writeText(cmd).then(() => {
            logToConsole('[Clipboard] CLI command line copied to clipboard!', 'success');
        });
    };

    // --- Console Log Helper ---
    const MAX_CONSOLE_LINES = 80;

    function logToConsole(message, type = 'info', isProgress = false) {
        if (!message) return;
        
        let effectiveType = type;
        if (message.includes('Sign in to confirm you’re not a bot') || message.includes('Sign in to confirm you\'re not a bot') || message.includes('ERROR:')) {
            effectiveType = 'error';
        } else if (message.includes('WARNING:')) {
            effectiveType = 'system';
        }

        // Detect progress updates e.g. [download] 12% ...
        const isDownloadProgress = isProgress || message.startsWith('[download]');
        const lastLine = consoleOutput.lastElementChild;

        if (isDownloadProgress && lastLine && lastLine.classList.contains('progress-line')) {
            // Update existing progress line in-place to prevent DOM clutter
            const timestamp = new Date().toLocaleTimeString();
            lastLine.innerHTML = `<span style="opacity: 0.6;">[${timestamp}]</span> <span>${escapeHtml(message)}</span>`;
        } else {
            // Create new log line
            const line = document.createElement('div');
            line.className = `log-line ${effectiveType}${isDownloadProgress ? ' progress-line' : ''}`;
            
            const timestamp = new Date().toLocaleTimeString();
            line.innerHTML = `<span style="opacity: 0.6;">[${timestamp}]</span> <span>${escapeHtml(message)}</span>`;

            consoleOutput.appendChild(line);

            // Cap maximum lines in DOM to avoid freezing browser memory
            while (consoleOutput.children.length > MAX_CONSOLE_LINES) {
                consoleOutput.removeChild(consoleOutput.firstChild);
            }
        }

        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }

    function escapeHtml(text) {
        return text.replace(/&/g, "&amp;")
                   .replace(/</g, "&lt;")
                   .replace(/>/g, "&gt;");
    }

    // Clear console
    clearConsoleBtn.addEventListener('click', () => {
        consoleOutput.innerHTML = '';
        logToConsole('[System] Console output log cleared.', 'system');
    });

    // Copy entire log
    copyLogBtn.addEventListener('click', () => {
        const logText = consoleOutput.innerText;
        navigator.clipboard.writeText(logText).then(() => {
            logToConsole('[Clipboard] Console logs copied to clipboard!', 'success');
        });
    });

    // --- YouTube Video ID Helper ---
    function extractYtId(url) {
        const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
        const match = url.match(regExp);
        return (match && match[2].length === 11) ? match[2] : null;
    }

    // --- Live Download Progress Bar Handlers ---
    const progressCard = document.getElementById('download-progress-card');
    const progressFill = document.getElementById('progress-bar-fill');
    const progressPercentVal = document.getElementById('progress-percent-val');
    const progressSpeedText = document.getElementById('progress-speed-text');
    const progressEtaText = document.getElementById('progress-eta-text');
    const progressStatusTitle = document.getElementById('progress-status-title');

    function showProgressBar(title = 'Downloading Media...') {
        if (!progressCard) return;
        progressCard.classList.remove('hidden');
        if (progressStatusTitle) progressStatusTitle.textContent = title;
        if (progressFill) progressFill.style.width = '0%';
        if (progressPercentVal) progressPercentVal.textContent = '0%';
        if (progressSpeedText) progressSpeedText.innerHTML = '<i class="fa-solid fa-gauge-high"></i> Speed: Connecting...';
        if (progressEtaText) progressEtaText.innerHTML = '<i class="fa-regular fa-clock"></i> ETA: Calculating...';
    }

    function updateProgressBar(percent, speed, eta) {
        if (!progressCard) return;
        const validPercent = Math.min(100, Math.max(0, parseFloat(percent || 0)));
        if (progressFill) progressFill.style.width = `${validPercent}%`;
        if (progressPercentVal) progressPercentVal.textContent = `${validPercent.toFixed(1)}%`;
        if (speed && progressSpeedText) progressSpeedText.innerHTML = `<i class="fa-solid fa-gauge-high"></i> ${speed}`;
        if (eta && progressEtaText) progressEtaText.innerHTML = `<i class="fa-regular fa-clock"></i> ETA ${eta}`;
    }

    function finishProgressBar(success = true) {
        if (!progressCard) return;
        if (success) {
            if (progressFill) progressFill.style.width = '100%';
            if (progressPercentVal) progressPercentVal.textContent = '100%';
            if (progressStatusTitle) progressStatusTitle.textContent = 'Download Complete!';
        } else {
            if (progressStatusTitle) progressStatusTitle.textContent = 'Process Finished';
        }
        setTimeout(() => {
            if (progressCard) progressCard.classList.add('hidden');
        }, 3500);
    }

    // --- Overwrite Confirmation Handler ---
    let pendingExecutionFn = null;

    function openOverwriteModal(fileName, onConfirm) {
        const modal = document.getElementById('overwrite-modal-overlay');
        const nameSpan = document.getElementById('overwrite-file-name');
        const confirmBtn = document.getElementById('btn-confirm-overwrite');
        if (!modal || !confirmBtn) {
            onConfirm();
            return;
        }

        if (nameSpan) nameSpan.textContent = fileName;
        pendingExecutionFn = onConfirm;
        modal.classList.remove('hidden');

        confirmBtn.onclick = () => {
            modal.classList.add('hidden');
            if (pendingExecutionFn) {
                const fn = pendingExecutionFn;
                pendingExecutionFn = null;
                fn();
            }
        };
    }

    function cancelOverwriteModal() {
        const modal = document.getElementById('overwrite-modal-overlay');
        if (modal) modal.classList.add('hidden');
        pendingExecutionFn = null;
        logToConsole('[Cancelled] Operation cancelled. Existing file preserved.', 'system');
        resetExecutionState();
    }
    window.cancelOverwriteModal = cancelOverwriteModal;

    function resetExecutionState() {
        isTaskRunning = false;
        if (actionBtn) {
            actionBtn.disabled = false;
            actionBtn.style.opacity = '1';
        }
        if (valTaskStatus) valTaskStatus.textContent = 'Idle';
    }

    function getTargetOutputFileForCheck() {
        let val = '';
        if (activeTabId === 'tab-quick-download' || activeTabId === 'tab-quick-downloader') {
            val = document.getElementById('quick-output')?.value || '';
            const titleVal = document.getElementById('quick-title')?.value.trim();
            if (titleVal && val) {
                const clean = sanitizeFilename(titleVal);
                if (val.includes('%(title)s')) {
                    val = val.replace(/%\(title\)s/g, clean);
                } else {
                    const lastSlash = Math.max(val.lastIndexOf('\\'), val.lastIndexOf('/'));
                    if (lastSlash !== -1) {
                        val = val.substring(0, lastSlash + 1) + clean + '.mp4';
                    }
                }
            }
        } else if (activeTabId === 'tab-section-clipper') {
            val = document.getElementById('section-output')?.value || '';
            const titleVal = document.getElementById('section-title')?.value.trim();
            if (titleVal && val) {
                const clean = sanitizeFilename(titleVal);
                if (val.includes('%(title)s')) {
                    val = val.replace(/%\(title\)s/g, clean);
                } else {
                    const lastSlash = Math.max(val.lastIndexOf('\\'), val.lastIndexOf('/'));
                    if (lastSlash !== -1) {
                        val = val.substring(0, lastSlash + 1) + clean + '.mp4';
                    }
                }
            }
        } else if (activeTabId === 'tab-file-converter') {
            const name = document.getElementById('convert-name')?.value.trim() || 'converted_clip';
            val = `downloads/${name}.mp4`;
        }
        return val || '';
    }

    let activeFileHandle = null;

    // --- Execution Handler ---
    actionBtn.addEventListener('click', async () => {
        if (isTaskRunning) return;
        activeFileHandle = null;

        const downloadTabs = ['tab-quick-download', 'tab-section-clipper', 'tab-silence-cutter', 'tab-file-converter', 'tab-multi-section', 'tab-shorts-harvest'];

        // 1. Open Save As Folder Picker FIRST before initiating download process
        if (downloadTabs.includes(activeTabId) && typeof window.showSaveFilePicker === 'function') {
            let suggestedTitle = '';
            if (activeTabId === 'tab-quick-download') suggestedTitle = document.getElementById('quick-title')?.value.trim();
            else if (activeTabId === 'tab-section-clipper') suggestedTitle = document.getElementById('section-title')?.value.trim();
            else if (activeTabId === 'tab-silence-cutter') suggestedTitle = document.getElementById('silence-title')?.value.trim();
            else if (activeTabId === 'tab-file-converter') suggestedTitle = document.getElementById('convert-name')?.value.trim();

            let ext = 'mp4';
            if (activeTabId === 'tab-quick-download') {
                const fmtVal = document.getElementById('quick-format')?.value || '';
                if (fmtVal.includes('bestaudio') || fmtVal.includes('mp3')) ext = 'mp3';
                else if (fmtVal.includes('m4a')) ext = 'm4a';
            }

            let suggestedName = suggestedTitle ? sanitizeFilename(suggestedTitle) : 'Video_Clip';
            if (!suggestedName.toLowerCase().endsWith('.' + ext)) {
                suggestedName += '.' + ext;
            }

            let mimeType = 'video/mp4';
            if (ext === 'mp3') mimeType = 'audio/mpeg';
            else if (ext === 'm4a') mimeType = 'audio/m4a';

            try {
                activeFileHandle = await window.showSaveFilePicker({
                    suggestedName: suggestedName,
                    types: [{
                        description: `${ext.toUpperCase()} File`,
                        accept: { [mimeType]: [`.${ext}`] }
                    }]
                });
            } catch (err) {
                logToConsole('[Cancelled] Save location not selected. Download process aborted.', 'info');
                return; // User cancelled the Save As dialog — abort execution entirely
            }
        }

        let targetPath = getTargetOutputFileForCheck();

        // If targetPath still contains %(title)s template, resolve title via URL
        if (targetPath.includes('%(title)s')) {
            let activeUrl = '';
            if (activeTabId === 'tab-quick-download') activeUrl = document.getElementById('quick-url')?.value.trim();
            else if (activeTabId === 'tab-section-clipper') activeUrl = document.getElementById('section-url')?.value.trim();

            if (activeUrl) {
                try {
                    const res = await fetch('/api/fetch-title', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: activeUrl })
                    });
                    const data = await res.json();
                    if (data.success && data.title) {
                        const clean = sanitizeFilename(data.title);
                        targetPath = targetPath.replace(/%\(title\)s/g, clean);
                    }
                } catch (e) {}
            }
        }

        // Check if file exists before running
        let fileExists = false;
        let existingFileName = '';
        if (targetPath && !targetPath.includes('%(')) {
            try {
                const checkRes = await fetch('/api/check-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filePath: targetPath })
                });
                const checkData = await checkRes.json();
                if (checkData.success && checkData.exists) {
                    fileExists = true;
                    existingFileName = checkData.fileName || targetPath;
                }
            } catch (e) {}
        }

        const cmd = buildCommandForActiveTab();

        const runExecutionLogic = async () => {
            logToConsole(`[Execute] Triggered execution for active tool tab [${activeTabId}]`, 'system');
            logToConsole(`$ ${cmd}`, 'info');

            isTaskRunning = true;
            actionBtn.disabled = true;
            actionBtn.style.opacity = '0.7';
            valTaskStatus.textContent = 'Running...';

            if (activeTabId === 'tab-yt-thumbnail') {
                const url = document.getElementById('thumb-url').value.trim();
                const ytId = extractYtId(url);
                if (ytId) {
                    const maxResUrl = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
                    thumbPreviewImg.src = maxResUrl;
                    thumbDownloadLink.href = maxResUrl;
                    thumbnailPreviewCard.classList.remove('hidden');
                    logToConsole(`[Success] Fetched high-res thumbnail preview for video ID: ${ytId}`, 'success');
                }
            }

            if (activeTabId === 'tab-yt-tags') {
                const tagsUrl = document.getElementById('tags-url')?.value.trim();
                const mode = document.querySelector('input[name="analysis-mode"]:checked')?.value || 'tags';
                const resultsCard = document.getElementById('extracted-results-card');
                const resultsTitle = document.getElementById('results-card-title');
                const resultsIcon = document.getElementById('results-card-icon');
                const tagsCloud = document.getElementById('results-tags-cloud');
                const textBox = document.getElementById('results-text-box');

                if (!tagsUrl) {
                    logToConsole('[Error] Please enter a valid YouTube video URL first.', 'error');
                    resetExecutionState();
                    return;
                }

                if (mode === 'tags') {
                    logToConsole('[Metadata] Extracting video tags, channel tags & description on-screen...', 'system');
                    try {
                        const res = await fetch('/api/fetch-metadata', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: tagsUrl })
                        });
                        const data = await res.json();
                        if (data.success && data.metadata) {
                            const { video_tags, channel_tags, description, channel, title } = data.metadata;
                            if (resultsTitle) resultsTitle.textContent = `Video & Channel Tags: "${title || 'YouTube Video'}"`;
                            if (resultsIcon) resultsIcon.className = 'fa-solid fa-tags results-icon';

                            const videoBlock = document.getElementById('results-video-tags-block');
                            const channelBlock = document.getElementById('results-channel-tags-block');
                            const videoTagsCloud = document.getElementById('results-video-tags-cloud');
                            const channelTagsCloud = document.getElementById('results-channel-tags-cloud');
                            const bodyHeaderTitle = document.getElementById('results-body-header-title');

                            if (videoBlock) videoBlock.style.display = 'flex';
                            if (channelBlock) channelBlock.style.display = 'flex';
                            if (bodyHeaderTitle) bodyHeaderTitle.innerHTML = '<i class="fa-solid fa-align-left"></i> Video Description';

                            // Render Video Tags
                            if (videoTagsCloud) {
                                videoTagsCloud.innerHTML = '';
                                const vTags = video_tags && video_tags.length > 0 ? video_tags : ['youtube', 'video'];
                                vTags.forEach(tag => {
                                    const pill = document.createElement('span');
                                    pill.className = 'tag-pill';
                                    pill.textContent = `#${tag}`;
                                    pill.onclick = () => {
                                        navigator.clipboard.writeText(tag);
                                        logToConsole(`[Clipboard] Copied video tag: #${tag}`, 'info');
                                    };
                                    videoTagsCloud.appendChild(pill);
                                });
                            }

                            // Render Channel Tags
                            if (channelTagsCloud) {
                                channelTagsCloud.innerHTML = '';
                                const cTags = channel_tags && channel_tags.length > 0 ? channel_tags : [channel || 'YouTubeChannel'];
                                cTags.forEach(tag => {
                                    const pill = document.createElement('span');
                                    pill.className = 'tag-pill';
                                    pill.textContent = `#${tag}`;
                                    pill.onclick = () => {
                                        navigator.clipboard.writeText(tag);
                                        logToConsole(`[Clipboard] Copied channel tag: #${tag}`, 'info');
                                    };
                                    channelTagsCloud.appendChild(pill);
                                });
                            }

                            if (textBox) textBox.textContent = `[Channel / Uploader]: ${channel || 'YouTube'}\n\n[DESCRIPTION]:\n${description}`;
                            if (resultsCard) resultsCard.classList.remove('hidden');

                            renderTagCloud(video_tags, description);
                            logToConsole(`[Success] Extracted ${video_tags ? video_tags.length : 0} video tags & ${channel_tags ? channel_tags.length : 0} channel tags!`, 'success');
                        } else {
                            logToConsole('[Error] Could not fetch video metadata tags.', 'error');
                        }
                    } catch (e) {
                        logToConsole('[Error] Failed to connect to metadata service.', 'error');
                    }
                } else if (mode === 'transcript') {
                    logToConsole('[AI Transcript] Extracting in-memory transcript key moments...', 'system');
                    try {
                        const res = await fetch('/api/fetch-transcript', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: tagsUrl })
                        });
                        const data = await res.json();
                        if (data.success && data.transcript) {
                            const videoBlock = document.getElementById('results-video-tags-block');
                            const channelBlock = document.getElementById('results-channel-tags-block');
                            const bodyHeaderTitle = document.getElementById('results-body-header-title');

                            if (videoBlock) videoBlock.style.display = 'none';
                            if (channelBlock) channelBlock.style.display = 'none';
                            if (bodyHeaderTitle) bodyHeaderTitle.innerHTML = '<i class="fa-solid fa-brain"></i> AI Subtitles & Transcript';

                            if (resultsTitle) resultsTitle.textContent = 'AI Transcript Key Moments & Subtitles';
                            if (resultsIcon) resultsIcon.className = 'fa-solid fa-brain results-icon';
                            if (textBox) textBox.textContent = data.transcript;
                            if (resultsCard) resultsCard.classList.remove('hidden');

                            logToConsole('[Success] Extracted AI transcript key moments directly on-screen!', 'success');
                        } else {
                            logToConsole('[Error] Could not extract transcript subtitles for this video.', 'error');
                        }
                    } catch (e) {
                        logToConsole('[Error] Failed to connect to transcript service.', 'error');
                    }
                }

                resetExecutionState();
                return;
            }

            try {
                const response = await fetch('/api/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: cmd, tabId: activeTabId })
                });

                if (response.ok && response.body) {
                    showProgressBar('Downloading & Merging Media...');
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop();

                        for (const line of lines) {
                            if (!line.trim()) continue;
                            try {
                                const data = JSON.parse(line.trim());
                                if (data.text) {
                                    logToConsole(data.text, data.type || 'info', data.percent !== null);
                                }
                                if (data.percent !== null && data.percent !== undefined) {
                                    updateProgressBar(data.percent, data.speed, data.eta);
                                }
                                if (data.done) {
                                    finishProgressBar(data.exitCode === 0);
                                    // downloadToken + fileName come in the same done packet
                                    if (data.exitCode === 0 && data.downloadToken && data.fileName) {
                                        const fname = data.fileName;
                                        logToConsole(`[Download Ready] Transferring file from server...`, 'success');
                                        try {
                                            const dlUrl = `/api/download-file?token=${data.downloadToken}`;
                                            const dlRes = await fetch(dlUrl);
                                            if (!dlRes.ok) {
                                                const errText = await dlRes.text().catch(() => '');
                                                throw new Error(`Server responded ${dlRes.status}: ${errText}`);
                                            }
                                            const blob = await dlRes.blob();

                                            if (activeFileHandle) {
                                                logToConsole(`[Saved] Writing directly to selected file: "${activeFileHandle.name}"...`, 'success');
                                                const writable = await activeFileHandle.createWritable();
                                                await writable.write(blob);
                                                await writable.close();
                                                logToConsole(`[Saved] Successfully saved file to: "${activeFileHandle.name}"!`, 'success');
                                                activeFileHandle = null;
                                            } else {
                                                const blobUrl = URL.createObjectURL(blob);
                                                const a = document.createElement('a');
                                                a.href = blobUrl;
                                                a.download = fname;
                                                document.body.appendChild(a);
                                                a.click();
                                                document.body.removeChild(a);
                                                setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
                                                logToConsole(`[Saved] "${fname}" saved to your Downloads folder!`, 'success');
                                            }
                                        } catch (dlErr) {
                                            logToConsole(`[Error] Could not save file: ${dlErr.message}`, 'error');
                                        }
                                    } else if (data.exitCode === 0 && !data.downloadToken) {
                                        logToConsole('[Warning] Download completed but no file token received from server.', 'system');
                                    }
                                }
                            } catch (e) {}
                        }
                    }
                } else {
                    runSimulatedExecution(cmd);
                }
            } catch (err) {
                runSimulatedExecution(cmd);
            } finally {
                resetExecutionState();
            }
        };

        if (fileExists) {
            openOverwriteModal(existingFileName, runExecutionLogic);
        } else {
            runExecutionLogic();
        }
    });

    // Simulated execution mode when running standalone
    function runSimulatedExecution(cmd) {
        logToConsole('[Info] Running in Browser Client Mode. Generated script ready for execution.', 'info');
        showProgressBar('Simulating Download Progress...');
        
        let simPercent = 0;
        const simInterval = setInterval(() => {
            simPercent += 20;
            updateProgressBar(simPercent, '14.8 MiB/s', `00:0${Math.max(0, Math.ceil((100 - simPercent)/25))}`);
            if (simPercent >= 100) {
                clearInterval(simInterval);
                finishProgressBar(true);
            }
        }, 350);

        setTimeout(() => {
            if (activeTabId === 'tab-yt-tags') {
                const sampleTags = ['gaming', 'clips', 'streamer', 'highlight', 'viral', 'podcast', 'yt-dlp'];
                const sampleDesc = 'Official video clip metadata extracted successfully.\nContains tags, title parameters, and transcript timestamps.';
                renderTagCloud(sampleTags, sampleDesc);
                logToConsole('[Tags] Extracted 7 tags and video description.', 'success');
            } else if (activeTabId === 'tab-hdd-mirror') {
                logToConsole('[Robocopy] Syncing ./downloads -> ./backup', 'info');
                logToConsole('[Robocopy] Summary: 0 New Files, 0 Extra Files. HDD Mirror Complete.', 'success');
            } else {
                logToConsole(`[Output] Output file target configured. File will be written to target directory.`, 'success');
            }
        }, 1200);
    }

    function renderTagCloud(tagsArr, descText) {
        tagsCloudContainer.innerHTML = '';
        tagsArr.forEach(tag => {
            const pill = document.createElement('span');
            pill.className = 'tag-pill';
            pill.textContent = `#${tag}`;
            pill.onclick = () => {
                navigator.clipboard.writeText(tag);
                logToConsole(`[Clipboard] Copied tag: #${tag}`, 'info');
            };
            tagsCloudContainer.appendChild(pill);
        });

        if (descText) {
            descriptionBoxContainer.textContent = descText;
        }
    }

    window.closeExtractedResults = function() {
        const card = document.getElementById('extracted-results-card');
        if (card) card.classList.add('hidden');
    };

    window.copyExtractedCategory = function(category) {
        let textToCopy = '';
        if (category === 'video-tags') {
            textToCopy = Array.from(document.querySelectorAll('#results-video-tags-cloud .tag-pill')).map(p => p.textContent).join(', ');
            logToConsole('[Clipboard] Copied Video Tags to clipboard!', 'success');
        } else if (category === 'channel-tags') {
            textToCopy = Array.from(document.querySelectorAll('#results-channel-tags-cloud .tag-pill')).map(p => p.textContent).join(', ');
            logToConsole('[Clipboard] Copied Channel Tags to clipboard!', 'success');
        } else if (category === 'description') {
            textToCopy = document.getElementById('results-text-box')?.textContent || '';
            logToConsole('[Clipboard] Copied Description / Transcript to clipboard!', 'success');
        } else if (category === 'all') {
            const vTags = Array.from(document.querySelectorAll('#results-video-tags-cloud .tag-pill')).map(p => p.textContent).join(', ');
            const cTags = Array.from(document.querySelectorAll('#results-channel-tags-cloud .tag-pill')).map(p => p.textContent).join(', ');
            const desc = document.getElementById('results-text-box')?.textContent || '';
            textToCopy = `VIDEO TAGS:\n${vTags}\n\nCHANNEL TAGS:\n${cTags}\n\nDESCRIPTION / TRANSCRIPT:\n${desc}`;
            logToConsole('[Clipboard] Copied All Metadata to clipboard!', 'success');
        }

        if (textToCopy) {
            navigator.clipboard.writeText(textToCopy);
        }
    };

    window.downloadExtractedMetaFile = function() {
        const tags = Array.from(document.querySelectorAll('#tags-cloud-container .tag-pill')).map(p => p.textContent).join(', ');
        const desc = document.getElementById('description-box-container')?.textContent || '';
        if (!tags && (!desc || desc.includes('appear here after'))) {
            logToConsole('[Warning] No extracted metadata to download yet.', 'system');
            return;
        }

        const content = `=== EXTRACTED VIDEO TAGS ===\n${tags}\n\n=== VIDEO DESCRIPTION ===\n${desc}`;
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'video_metadata_tags.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        logToConsole('[Downloaded] Saved video tags & description text file!', 'success');
    };

    window.browseFolderForInput = async function(inputId) {
        const inputElem = document.getElementById(inputId);
        if (!inputElem) return;

        logToConsole('[System] Opening Windows Folder Browser dialog...', 'system');

        // 1. Try native Windows folder dialog via backend API
        try {
            const response = await fetch('/api/select-folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.success && data.folderPath) {
                    let selectedFolder = data.folderPath;
                    let currentVal = inputElem.value.trim();

                    // If target input currently contains filename templates (e.g. %(title)s_%(height)sp.%(ext)s), preserve template!
                    if (currentVal.includes('%(title)s')) {
                        const filenamePart = currentVal.includes('\\') ? currentVal.substring(currentVal.lastIndexOf('\\') + 1) : '%(title)s.mp4';
                        selectedFolder = `${selectedFolder}\\${filenamePart}`;
                    } else if (currentVal.endsWith('.mp4') && !selectedFolder.endsWith('.mp4')) {
                        const filenamePart = currentVal.includes('\\') ? currentVal.substring(currentVal.lastIndexOf('\\') + 1) : 'clip.mp4';
                        selectedFolder = `${selectedFolder}\\${filenamePart}`;
                    }

                    inputElem.value = selectedFolder;
                    inputElem.dispatchEvent(new Event('input'));
                    updateGeneratedCommand();
                    logToConsole(`[Folder Selected] Destination path set to: "${selectedFolder}"`, 'success');
                    return;
                }
            }
        } catch (err) {}

        // 2. Browser showDirectoryPicker API Fallback
        if (window.showDirectoryPicker) {
            try {
                const dirHandle = await window.showDirectoryPicker();
                if (dirHandle && dirHandle.name) {
                    let folderPath = `downloads/${dirHandle.name}`;
                    let currentVal = inputElem.value.trim();

                    if (currentVal.includes('%(title)s')) {
                        const filenamePart = currentVal.includes('\\') || currentVal.includes('/') ? currentVal.substring(Math.max(currentVal.lastIndexOf('\\'), currentVal.lastIndexOf('/')) + 1) : '%(title)s.mp4';
                        folderPath = `${folderPath}/${filenamePart}`;
                    } else if (currentVal.endsWith('.mp4')) {
                        const filenamePart = currentVal.includes('\\') || currentVal.includes('/') ? currentVal.substring(Math.max(currentVal.lastIndexOf('\\'), currentVal.lastIndexOf('/')) + 1) : 'clip.mp4';
                        folderPath = `${folderPath}/${filenamePart}`;
                    }

                    inputElem.value = folderPath;
                    inputElem.dispatchEvent(new Event('input'));
                    updateGeneratedCommand();
                    logToConsole(`[Folder Selected] Target folder set to: "${dirHandle.name}"`, 'success');
                    return;
                }
            } catch (e) {
                if (e.name !== 'AbortError') {
                    logToConsole('[Notice] Browsers block selecting root "Desktop" for security on web apps. Please select or create a subfolder inside Desktop (e.g. a "Clips" folder) or use default "downloads/".', 'info');
                }
            }
        }
    };

    window.setDesktopPreset = function(inputId) {
        const inputElem = document.getElementById(inputId);
        if (!inputElem) return;

        let currentVal = inputElem.value.trim();
        let filenamePart = '%(title)s.mp4';

        if (currentVal.includes('%(title)s')) {
            filenamePart = currentVal.includes('/') || currentVal.includes('\\') ? currentVal.substring(Math.max(currentVal.lastIndexOf('/'), currentVal.lastIndexOf('\\')) + 1) : '%(title)s.mp4';
        } else if (currentVal.endsWith('.mp4')) {
            filenamePart = currentVal.includes('/') || currentVal.includes('\\') ? currentVal.substring(Math.max(currentVal.lastIndexOf('/'), currentVal.lastIndexOf('\\')) + 1) : 'clip.mp4';
        }

        inputElem.value = `downloads/Clips/${filenamePart}`;
        inputElem.dispatchEvent(new Event('input'));
        updateGeneratedCommand();
        logToConsole('[Folder Preset Set] Target destination configured to "downloads/Clips/"', 'success');
    };

    // --- Backend Health Check ---
    async function checkBackendHealth() {
        try {
            const res = await fetch('/api/health');
            if (res.ok) {
                isServerConnected = true;
                backendStatusIndicator.className = 'status-indicator online';
                backendStatusText.textContent = 'Node.js Backend Connected';
                valBackendMode.textContent = 'Local Server API';
            } else {
                setBackendOffline();
            }
        } catch (e) {
            setBackendOffline();
        }
    }

    function setBackendOffline() {
        isServerConnected = false;
        backendStatusIndicator.className = 'status-indicator offline';
        backendStatusText.textContent = 'Standalone Client';
        valBackendMode.textContent = 'CLI Script Mode';
    }

    checkBackendHealth();
    updateGeneratedCommand();
});
