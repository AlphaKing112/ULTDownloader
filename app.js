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
    
    // Status & Backend indicators
    const backendStatusIndicator = document.getElementById('backend-status-indicator');
    const backendStatusText = document.getElementById('backend-status-text');

    // Tags & Meta card
    const extractedMetaCard = document.getElementById('extracted-results-card');
    const tagsCloudContainer = document.getElementById('results-video-tags-cloud');
    const descriptionBoxContainer = document.getElementById('results-text-box');

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
            if (url.includes('kick.com/videos') || /kick\.com\/[\w-]+\/videos\//.test(url)) {
                platformIndicator.innerHTML = '<i class="fa-solid fa-bolt" style="color: #22c55e;"></i> <strong>Kick VOD Detected!</strong> Format auto-optimization & postprocessing enabled.';
                platformIndicator.style.borderColor = '#22c55e';
            } else if (url.includes('kick.com') && url.includes('clip')) {
                platformIndicator.innerHTML = '<i class="fa-solid fa-bolt" style="color: #22c55e;"></i> <strong>Kick Clip Detected!</strong> Format auto-optimization enabled.';
                platformIndicator.style.borderColor = '#22c55e';
            } else if (url.includes('twitch.tv')) {
                platformIndicator.innerHTML = '<i class="fa-brands fa-twitch" style="color: #9146ff;"></i> <strong>Twitch Video Detected!</strong> Use the player to mark start/end times.';
                platformIndicator.style.borderColor = '#9146ff';
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

    // --- Live Section Clip Duration Calculator ---
    const sectionStartInput = document.getElementById('section-start');
    const sectionEndInput = document.getElementById('section-end');
    const sectionTotalDurationBadge = document.getElementById('section-total-duration');
    const sectionDurationText = document.getElementById('section-duration-text');
    const sectionRangePreview = document.getElementById('section-range-preview');
    const sectionDurationCard = document.getElementById('section-duration-card');

    function parseTimestampToSeconds(str) {
        if (!str) return 0;
        const clean = str.trim().replace(/^[^0-9:]/, '');
        const parts = clean.split(':').map(Number);
        if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
        if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
        return parseFloat(clean) || 0;
    }

    function formatDurationHuman(totalSec) {
        if (totalSec <= 0) return '0s';
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = Math.floor(totalSec % 60);
        const parts = [];
        if (h > 0) parts.push(`${h}h`);
        if (m > 0 || h > 0) parts.push(`${m}m`);
        parts.push(`${s}s`);
        return parts.join(' ');
    }

    function updateSectionDurationDisplay() {
        if (!sectionStartInput || !sectionEndInput) return;

        const startSec = parseTimestampToSeconds(sectionStartInput.value);
        const endSec = parseTimestampToSeconds(sectionEndInput.value);
        const durationSec = endSec - startSec;

        if (endSec > startSec) {
            const hhmmss = formatSecondsToHHMMSS(durationSec);
            const human = formatDurationHuman(durationSec);
            const label = `${hhmmss} (${human})`;
            if (sectionTotalDurationBadge) {
                sectionTotalDurationBadge.innerHTML = `<i class="fa-solid fa-stopwatch"></i> Total: ${label}`;
                sectionTotalDurationBadge.className = 'badge-duration valid';
            }
            if (sectionDurationText) sectionDurationText.textContent = label;
            if (sectionRangePreview) sectionRangePreview.textContent = `${sectionStartInput.value.trim()} → ${sectionEndInput.value.trim()}`;
            if (sectionDurationCard) sectionDurationCard.classList.remove('invalid');
        } else {
            if (sectionTotalDurationBadge) {
                sectionTotalDurationBadge.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> End must be > Start';
                sectionTotalDurationBadge.className = 'badge-duration invalid';
            }
            if (sectionDurationText) sectionDurationText.textContent = 'Invalid time range';
            if (sectionRangePreview) sectionRangePreview.textContent = 'End time must be after start time';
            if (sectionDurationCard) sectionDurationCard.classList.add('invalid');
        }
    }

    if (sectionStartInput) {
        sectionStartInput.addEventListener('input', () => {
            updateSectionDurationDisplay();
            updateGeneratedCommand();
        });
    }
    if (sectionEndInput) {
        sectionEndInput.addEventListener('input', () => {
            updateSectionDurationDisplay();
            updateGeneratedCommand();
        });
    }

    // --- Live Transcript Range Duration & Presets ---
    const transcriptStartInput = document.getElementById('transcript-start');
    const transcriptEndInput = document.getElementById('transcript-end');
    const transcriptDurationBadge = document.getElementById('transcript-duration-badge');

    function updateTranscriptDurationDisplay() {
        if (!transcriptStartInput || !transcriptEndInput || !transcriptDurationBadge) return;

        const startVal = transcriptStartInput.value.trim();
        const endVal = transcriptEndInput.value.trim();

        if (endVal.toLowerCase() === 'full' || (!startVal && !endVal)) {
            transcriptDurationBadge.innerHTML = '<i class="fa-solid fa-infinity"></i> Full Video';
            transcriptDurationBadge.className = 'badge-duration valid';
            return;
        }

        const startSec = parseTimestampToSeconds(startVal || '00:00:00');
        const endSec = parseTimestampToSeconds(endVal);

        if (endSec > startSec) {
            const durationSec = endSec - startSec;
            const hhmmss = formatSecondsToHHMMSS(durationSec);
            const human = formatDurationHuman(durationSec);
            transcriptDurationBadge.innerHTML = `<i class="fa-solid fa-stopwatch"></i> Total: ${hhmmss} (${human})`;
            transcriptDurationBadge.className = 'badge-duration valid';
        } else {
            transcriptDurationBadge.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> End must be > Start';
            transcriptDurationBadge.className = 'badge-duration invalid';
        }
    }

    window.setTranscriptPreset = function(preset) {
        if (!transcriptStartInput || !transcriptEndInput) return;
        document.querySelectorAll('.transcript-preset-pill').forEach(p => p.classList.remove('active'));

        if (preset === '5m') {
            transcriptStartInput.value = '00:00:00';
            transcriptEndInput.value = '00:05:00';
        } else if (preset === '15m') {
            transcriptStartInput.value = '00:00:00';
            transcriptEndInput.value = '00:15:00';
        } else if (preset === '30m') {
            transcriptStartInput.value = '00:00:00';
            transcriptEndInput.value = '00:30:00';
        } else if (preset === 'full') {
            transcriptStartInput.value = '';
            transcriptEndInput.value = 'Full';
        }

        // Mark active pill
        const activeBtn = Array.from(document.querySelectorAll('.transcript-preset-pill')).find(b => b.getAttribute('onclick')?.includes(`'${preset}'`));
        if (activeBtn) activeBtn.classList.add('active');

        updateTranscriptDurationDisplay();
        updateGeneratedCommand();
    };

    window.syncTranscriptRangeFromClipper = function() {
        if (!sectionStartInput || !sectionEndInput || !transcriptStartInput || !transcriptEndInput) return;
        transcriptStartInput.value = sectionStartInput.value.trim() || '00:00:00';
        transcriptEndInput.value = sectionEndInput.value.trim() || '00:01:00';
        document.querySelectorAll('.transcript-preset-pill').forEach(p => p.classList.remove('active'));
        updateTranscriptDurationDisplay();
        updateGeneratedCommand();
        logToConsole(`[Sync] Imported section range: ${transcriptStartInput.value} → ${transcriptEndInput.value} to Transcript Analyzer`, 'info');
    };

    if (transcriptStartInput) {
        transcriptStartInput.addEventListener('input', () => {
            document.querySelectorAll('.transcript-preset-pill').forEach(p => p.classList.remove('active'));
            updateTranscriptDurationDisplay();
            updateGeneratedCommand();
        });
    }
    if (transcriptEndInput) {
        transcriptEndInput.addEventListener('input', () => {
            document.querySelectorAll('.transcript-preset-pill').forEach(p => p.classList.remove('active'));
            updateTranscriptDurationDisplay();
            updateGeneratedCommand();
        });
    }

    // --- Range Builder for Multi-Section ---
    const newRangeInput = document.getElementById('new-range-input');
    const btnAddRange = document.getElementById('btn-add-range');
    const btnClearRanges = document.getElementById('btn-clear-ranges');
    const rangesListUl = document.getElementById('ranges-list-ul');
    const btnMultiFromPlayer = document.getElementById('btn-multi-from-player');

    function addRangeToList(rawVal) {
        const val = (rawVal || '').trim();
        if (!val) return;
        
        const li = document.createElement('li');
        li.className = 'range-item';
        li.dataset.range = val;
        li.innerHTML = `<span><i class="fa-regular fa-bookmark"></i> ${escapeHtml(val)}</span>
                        <button type="button" class="btn-remove-range" onclick="this.parentElement.remove(); updateGeneratedCommand();"><i class="fa-solid fa-xmark"></i></button>`;
        rangesListUl.appendChild(li);
        if (newRangeInput) newRangeInput.value = '';
        updateGeneratedCommand();
    }

    if (btnAddRange && newRangeInput) {
        btnAddRange.addEventListener('click', () => addRangeToList(newRangeInput.value));
        newRangeInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addRangeToList(newRangeInput.value);
            }
        });
    }

    if (btnMultiFromPlayer) {
        btnMultiFromPlayer.addEventListener('click', () => {
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
                logToConsole('[Multi-Section] Load and play a video in the player to capture timestamps directly.', 'system');
                return;
            }
            const startStr = formatSecondsToHHMMSS(currentSec);
            const endStr = formatSecondsToHHMMSS(currentSec + 60);
            if (newRangeInput) {
                newRangeInput.value = `${startStr}-${endStr}`;
                newRangeInput.focus();
            }
            logToConsole(`[Multi-Section] Captured player range: ${startStr}-${endStr} (Click Add to confirm)`, 'info');
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

        // ONLY fetch & display Video Tags & Metadata card for YouTube URLs!
        const isYouTube = url.toLowerCase().includes('youtube.com') || url.toLowerCase().includes('youtu.be');
        if (!isYouTube) {
            const card = document.getElementById('extracted-results-card');
            if (card) card.classList.add('hidden');
            return;
        }

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

    // --- Channel VOD Browser (Section Clip Extractor) ---
    // Type a Twitch/Kick username -> list VODs / highlights / clips -> click one to load it as the section URL.
    const channelUsernameInput = document.getElementById('channel-username');
    const channelSearchBtn = document.getElementById('channel-search-btn');
    const channelVideosList = document.getElementById('channel-videos-list');
    const channelVideosStatus = document.getElementById('channel-videos-status');
    const channelPlatformToggle = document.getElementById('channel-platform-toggle');
    const channelTypeToggle = document.getElementById('channel-type-toggle');
    const channelHighlightsBtn = document.getElementById('channel-type-highlights');
    const channelRangeFilter = document.getElementById('channel-range-filter');
    const channelRangeToggle = document.getElementById('channel-range-toggle');
    const channelLoadMoreRow = document.getElementById('channel-load-more-row');
    const channelLoadMoreBtn = document.getElementById('channel-load-more-btn');
    const channelMediaVaultPanel = document.getElementById('channel-media-vault-panel');
    const channelVaultTitle = document.getElementById('channel-vault-title');
    const vaultCountBadge = document.getElementById('vault-count-badge');

    window.closeChannelVaultPanel = function() {
        if (channelMediaVaultPanel) {
            channelMediaVaultPanel.classList.add('hidden');
        }
    };

    let channelPlatform = 'twitch';
    let channelType = 'vods';
    let channelRange = 'all'; // Default to all time
    let channelPage = 1;
    let channelCursor = null;
    let channelHasMore = false;
    let currentLoadedVideos = [];
    let isLoadingMore = false;
    let channelRequestSeq = 0;
    let channelDebounceTimer = null;
    let lastChannelQueryKey = '';

    function setChannelStatus(text, cls = '') {
        if (!channelVideosStatus) return;
        channelVideosStatus.textContent = text;
        channelVideosStatus.className = `fetch-status-badge ${cls}`.trim();
    }

    function setActiveToggle(container, attr, value) {
        if (!container) return;
        container.querySelectorAll('button').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute(attr) === value);
        });
    }

    function formatRelativeDate(iso) {
        if (!iso) return '';
        const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
        if (isNaN(d)) return '';
        const days = Math.floor((Date.now() - d.getTime()) / 86400000);
        if (days <= 0) return 'today';
        if (days === 1) return 'yesterday';
        if (days < 30) return `${days} days ago`;
        return d.toLocaleDateString();
    }

    function formatViews(n) {
        if (n === null || n === undefined) return '';
        if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
        if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K views`;
        return `${n} views`;
    }

    function escapeAttr(text) {
        return escapeHtml(String(text || '')).replace(/"/g, '&quot;');
    }

    // Accept plain usernames as well as pasted channel links (twitch.tv/name, kick.com/name)
    function normalizeChannelInput(raw) {
        let val = (raw || '').trim();
        const linkMatch = val.match(/(?:https?:\/\/)?(?:www\.|m\.)?(twitch\.tv|kick\.com)\/([A-Za-z0-9_-]+)/i);
        if (linkMatch) {
            const detected = linkMatch[1].toLowerCase().startsWith('kick') ? 'kick' : 'twitch';
            if (detected !== channelPlatform) selectChannelPlatform(detected, false);
            val = linkMatch[2];
        }
        return val.replace(/^@/, '');
    }

    function selectChannelPlatform(platform, reload = true) {
        channelPlatform = platform;
        setActiveToggle(channelPlatformToggle, 'data-platform', platform);
        // Kick has no "highlights" concept - its equivalent is clips
        if (channelHighlightsBtn) channelHighlightsBtn.classList.toggle('hidden', platform === 'kick');
        if (platform === 'kick' && channelType === 'highlights') {
            selectChannelType('clips', false);
        }
        channelPage = 1;
        channelCursor = null;
        currentLoadedVideos = [];
        if (reload) loadChannelVideos(true);
    }

    function selectChannelType(type, reload = true) {
        channelType = type;
        setActiveToggle(channelTypeToggle, 'data-type', type);
        // Show range filter only for clips
        if (channelRangeFilter) {
            channelRangeFilter.classList.toggle('hidden', type !== 'clips');
        }
        channelPage = 1;
        channelCursor = null;
        currentLoadedVideos = [];
        if (reload) loadChannelVideos(true);
    }

    function selectChannelRange(range, reload = true) {
        channelRange = range;
        setActiveToggle(channelRangeToggle, 'data-range', range);
        channelPage = 1;
        channelCursor = null;
        currentLoadedVideos = [];
        if (reload) loadChannelVideos(true);
    }

    let channelPreviewMuted = true;
    const clipDirectUrlCache = new Map(); // slug -> direct MP4 url

    function setupThumbnailHoverPreview(thumbElem, video, platform, type) {
        if (!thumbElem || !video) return;

        let hoverTimer = null;
        let cycleTimer = null;
        let stopTimer = null;
        let resumeCycleTimer = null;
        let isScrubbing = false;
        let previewContainer = null;
        let hlsInstance = null;

        function cleanupPreview() {
            if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
            if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
            if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
            if (resumeCycleTimer) { clearTimeout(resumeCycleTimer); resumeCycleTimer = null; }
            if (hlsInstance) {
                try { hlsInstance.destroy(); } catch (e) {}
                hlsInstance = null;
            }
            if (previewContainer && previewContainer.parentNode) {
                const vid = previewContainer.querySelector('video');
                if (vid) {
                    try {
                        vid.pause();
                        vid.removeAttribute('src');
                        vid.load();
                    } catch (e) {}
                }
                previewContainer.remove();
                previewContainer = null;
            }
        }

        thumbElem.addEventListener('mouseenter', () => {
            cleanupPreview();

            hoverTimer = setTimeout(() => {
                const isClip = type === 'clips' || /(?:clips\.twitch\.tv\/|twitch\.tv\/[^\/]+\/clip\/|\/clips\/)/i.test(video.url || '');
                const duration = Math.floor(video.duration || 0);

                // Build storyboard frames for VODs / Highlights
                let rawThumb = (video.thumbnail || '').replace(/%\{width\}x%\{height\}/gi, '640x360');
                let frames = [];

                if (rawThumb && /thumb\d+/i.test(rawThumb)) {
                    frames = [
                        rawThumb.replace(/thumb\d+/i, 'thumb0'),
                        rawThumb.replace(/thumb\d+/i, 'thumb1'),
                        rawThumb.replace(/thumb\d+/i, 'thumb2'),
                        rawThumb.replace(/thumb\d+/i, 'thumb3')
                    ];
                } else if (rawThumb) {
                    frames = [rawThumb];
                }

                previewContainer = document.createElement('div');
                previewContainer.className = 'channel-preview-container';

                if (isClip) {
                    // --- High-Performance Direct Clip HTML5 Video Preview (Twitch & Kick) ---
                    const clipMatch = (video.url || '').match(/(?:clips\.twitch\.tv\/|twitch\.tv\/[^\/]+\/clip\/|\/clips\/)([A-Za-z0-9_-]+)/i);
                    const slug = (clipMatch && clipMatch[1]) ? clipMatch[1] : (video.id || '');

                    previewContainer.innerHTML = `
                        <div class="channel-preview-badge"><i class="fa-solid fa-play"></i> Clip Preview</div>
                        <img class="channel-preview-frame" src="${escapeAttr(rawThumb)}" alt="Preview">
                        <video class="channel-preview-video" ${channelPreviewMuted ? 'muted' : ''} autoplay loop playsinline style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity 0.25s ease;"></video>
                        <button type="button" class="channel-preview-vol-btn${channelPreviewMuted ? '' : ' unmuted'}" title="${channelPreviewMuted ? 'Turn on sound' : 'Mute sound'}">
                            <i class="fa-solid ${channelPreviewMuted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>
                        </button>
                        <div class="channel-preview-bar animated"></div>
                    `;

                    const videoElem = previewContainer.querySelector('video');
                    const posterImg = previewContainer.querySelector('.channel-preview-frame');
                    const volBtn = previewContainer.querySelector('.channel-preview-vol-btn');

                    if (volBtn && videoElem) {
                        volBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            channelPreviewMuted = !channelPreviewMuted;
                            videoElem.muted = channelPreviewMuted;
                            volBtn.classList.toggle('unmuted', !channelPreviewMuted);
                            volBtn.title = channelPreviewMuted ? 'Turn on sound' : 'Mute sound';
                            volBtn.innerHTML = `<i class="fa-solid ${channelPreviewMuted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
                        });
                    }

                    function startClipPlayback(srcUrl) {
                        if (!videoElem || !srcUrl) return;

                        videoElem.oncanplay = () => {
                            videoElem.style.opacity = '1';
                        };

                        if (srcUrl.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
                            try {
                                hlsInstance = new Hls({ enableWorker: false });
                                hlsInstance.loadSource(srcUrl);
                                hlsInstance.attachMedia(videoElem);
                                hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
                                    videoElem.play().catch(() => {});
                                });
                            } catch (hlsErr) {
                                videoElem.src = srcUrl;
                                videoElem.play().catch(() => {});
                            }
                        } else {
                            videoElem.src = srcUrl;
                            videoElem.play().catch(() => {});
                        }
                    }

                    if (platform === 'kick' && video.clip_url) {
                        startClipPlayback(video.clip_url);
                    } else if (clipDirectUrlCache.has(slug)) {
                        startClipPlayback(clipDirectUrlCache.get(slug));
                    } else if (slug && platform === 'twitch') {
                        fetch(`/api/clip-preview?platform=twitch&slug=${encodeURIComponent(slug)}`)
                            .then(r => r.json())
                            .then(data => {
                                if (data && data.success && data.previewUrl) {
                                    clipDirectUrlCache.set(slug, data.previewUrl);
                                    startClipPlayback(data.previewUrl);
                                }
                            })
                            .catch(() => {});
                    } else if (video.url) {
                        startClipPlayback(video.url);
                    }
                } else {
                    // --- Live Storyboard Scrub & Animated Preview (VODs / Highlights) ---
                    const initFrame = frames[0] || rawThumb;
                    const durationStr = duration > 0 ? `00:00:00 (0%)` : 'Preview';

                    previewContainer.innerHTML = `
                        <div class="channel-preview-badge"><i class="fa-solid fa-film"></i> Preview</div>
                        <div class="channel-preview-timestamp">${escapeHtml(durationStr)}</div>
                        <img class="channel-preview-frame" src="${escapeAttr(initFrame)}" alt="Preview">
                        <div class="channel-preview-bar"></div>
                    `;

                    const frameImg = previewContainer.querySelector('.channel-preview-frame');
                    const timeBadge = previewContainer.querySelector('.channel-preview-timestamp');
                    const bar = previewContainer.querySelector('.channel-preview-bar');

                    let currentFrameIdx = 0;
                    const validFrames = [initFrame];

                    // Preload additional storyboard frames and filter to valid ones
                    if (frames.length > 1) {
                        for (let i = 1; i < frames.length; i++) {
                            const fUrl = frames[i];
                            const testImg = new Image();
                            testImg.onload = () => {
                                if (!validFrames.includes(fUrl)) {
                                    validFrames.push(fUrl);
                                    validFrames.sort();
                                }
                            };
                            testImg.src = fUrl;
                        }
                    }

                    function setFrame(idx, percent = null) {
                        if (!validFrames.length || !frameImg) return;
                        currentFrameIdx = idx % validFrames.length;
                        frameImg.src = validFrames[currentFrameIdx];

                        const p = percent !== null ? percent : (currentFrameIdx / Math.max(1, validFrames.length - 1));
                        if (bar) bar.style.width = `${Math.min(100, Math.max(0, p * 100)).toFixed(1)}%`;

                        if (timeBadge && duration > 0) {
                            const curSec = Math.floor(p * duration);
                            timeBadge.textContent = `${formatSecondsToHHMMSS(curSec)} (${Math.round(p * 100)}%)`;
                        }
                    }

                    // Auto-cycle through frames every 1.2 seconds
                    cycleTimer = setInterval(() => {
                        if (isScrubbing) return;
                        setFrame((currentFrameIdx + 1) % validFrames.length);
                    }, 1200);

                    // Interactive horizontal scrub on mouse movement
                    previewContainer.addEventListener('mousemove', (e) => {
                        isScrubbing = true;
                        const rect = previewContainer.getBoundingClientRect();
                        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                        const pct = rect.width > 0 ? (x / rect.width) : 0;
                        const frameIdx = Math.min(validFrames.length - 1, Math.floor(pct * validFrames.length));
                        setFrame(frameIdx, pct);

                        if (resumeCycleTimer) clearTimeout(resumeCycleTimer);
                        resumeCycleTimer = setTimeout(() => {
                            isScrubbing = false;
                        }, 1400);
                    });
                }

                thumbElem.appendChild(previewContainer);

                // Auto-cleanup preview after 20 seconds of continuous hover
                stopTimer = setTimeout(() => {
                    cleanupPreview();
                }, 20000);
            }, 180); // 180ms hover debounce
        });

        thumbElem.addEventListener('mouseleave', () => {
            cleanupPreview();
        });
    }

    function renderChannelVideos(videos, username, append = false) {
        if (!channelVideosList) return;
        channelVideosList.classList.remove('hidden');

        if (!append) {
            currentLoadedVideos = [...videos];
            if (!videos.length) {
                const label = channelType === 'vods' ? 'VODs' : channelType;
                channelVideosList.innerHTML = `<div class="channel-videos-empty">No ${escapeHtml(label)} found for <strong>${escapeHtml(username)}</strong> on ${channelPlatform === 'kick' ? 'Kick' : 'Twitch'}.</div>`;
                if (channelLoadMoreRow) channelLoadMoreRow.classList.add('hidden');
                if (channelMediaVaultPanel) channelMediaVaultPanel.classList.remove('hidden');
                if (vaultCountBadge) vaultCountBadge.textContent = '0 items';
                return;
            }
            channelVideosList.innerHTML = '';
        } else {
            currentLoadedVideos.push(...videos);
        }

        const currentUrl = sectionUrlInput ? sectionUrlInput.value.trim() : '';
        const startIndex = append ? currentLoadedVideos.length - videos.length : 0;

        const fragment = document.createDocumentFragment();
        videos.forEach((v, idx) => {
            const globalIndex = startIndex + idx;
            const meta = [formatRelativeDate(v.date), formatViews(v.views)].filter(Boolean).join(' • ');
            const thumb = v.thumbnail
                ? `<img src="${escapeAttr(v.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
                : '';
            const featuredBadge = (channelType === 'clips' && v.isFeatured)
                ? `<span class="channel-clip-featured-badge" title="Featured Clip"><i class="fa-solid fa-star"></i> Featured</span>`
                : '';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `channel-video-item${v.url === currentUrl ? ' selected' : ''}`;
            btn.dataset.index = globalIndex;
            btn.title = v.title || '';
            btn.innerHTML = `
                <span class="channel-video-thumb">
                    ${thumb}
                    ${featuredBadge}
                    <span class="channel-video-duration">${formatSecondsToHHMMSS(v.duration)}</span>
                </span>
                <span class="channel-video-info">
                    <span class="channel-video-title">${escapeHtml(v.title || 'Untitled')}</span>
                    <span class="channel-video-meta">${escapeHtml(meta)}</span>
                </span>`;

            const thumbSpan = btn.querySelector('.channel-video-thumb');
            setupThumbnailHoverPreview(thumbSpan, v, channelPlatform, channelType);

            btn.addEventListener('click', () => {
                channelVideosList.querySelectorAll('.channel-video-item').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selectChannelVideo(currentLoadedVideos[globalIndex]);
            });

            fragment.appendChild(btn);
        });

        channelVideosList.appendChild(fragment);

        // Show and update Streamer Media Vault Panel below CLI Output
        if (channelMediaVaultPanel) {
            channelMediaVaultPanel.classList.remove('hidden');
            if (channelVaultTitle) {
                const platformLabel = channelPlatform === 'kick' ? 'Kick' : 'Twitch';
                let rangeLabel = '';
                if (channelType === 'clips') {
                    if (channelRange === 'featured') rangeLabel = ' - ⭐ Featured';
                    else if (channelRange === '24h') rangeLabel = ' - 24 Hours';
                    else if (channelRange === '7d') rangeLabel = ' - Week (7 Days)';
                    else if (channelRange === '30d') rangeLabel = ' - 30 Days';
                }
                const typeLabel = (channelType === 'clips' && channelRange === 'featured')
                    ? 'Featured Clips'
                    : (channelType === 'vods' ? 'VODs' : (channelType === 'highlights' ? 'Highlights' : 'Clips'));
                channelVaultTitle.textContent = `${username}'s ${typeLabel} (${platformLabel}${rangeLabel})`;
            }
            if (vaultCountBadge) {
                vaultCountBadge.textContent = `${currentLoadedVideos.length} items`;
            }
            if (!append && videos.length) {
                channelMediaVaultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        // Update Load More button visibility
        if (channelLoadMoreRow && channelLoadMoreBtn) {
            if (channelHasMore) {
                channelLoadMoreRow.classList.remove('hidden');
                channelLoadMoreBtn.innerHTML = `<i class="fa-solid fa-angles-down"></i> Load More ${channelType === 'clips' ? 'Clips' : 'Videos'}`;
            } else {
                channelLoadMoreRow.classList.add('hidden');
            }
        }
    }

    function selectChannelVideo(video) {
        if (!video || !sectionUrlInput) return;
        if (activeTabId !== 'tab-section-clipper') {
            activateTab('tab-section-clipper');
        }
        const titleElem = document.getElementById('section-title');
        const startElem = document.getElementById('section-start');
        const endElem = document.getElementById('section-end');

        // Prime the title cache so the auto-fetch resolves instantly without another yt-dlp call
        if (video.title) titleFetchCache.set(video.url, video.title);
        if (titleElem && video.title) {
            titleElem.value = video.title;
            titleElem.dataset.autoFetched = 'true';
        }

        const duration = Math.floor(video.duration || 0);
        if (startElem && endElem) {
            if (channelType === 'clips' && duration > 0) {
                // Clips are short: default to the whole clip
                startElem.value = '00:00:00';
                endElem.value = formatSecondsToHHMMSS(duration);
            } else if (duration > 0) {
                const toSec = (t) => (t || '').split(':').reduce((acc, p) => acc * 60 + (parseInt(p, 10) || 0), 0);
                if (toSec(startElem.value) >= duration) startElem.value = '00:00:00';
                if (toSec(endElem.value) > duration) endElem.value = formatSecondsToHHMMSS(duration);
            }
        }

        sectionUrlInput.value = video.url;
        sectionUrlInput.dispatchEvent(new Event('input')); // platform detect + title + player embed
        updateSectionDurationDisplay();
        updateGeneratedCommand();

        const kind = channelType === 'vods' ? 'VOD' : (channelType === 'highlights' ? 'Highlight' : 'Clip');
        logToConsole(`[Channel Browser] Loaded ${channelPlatform === 'kick' ? 'Kick' : 'Twitch'} ${kind}: "${video.title}" (${formatSecondsToHHMMSS(duration)})`, 'success');
    }

    async function loadChannelVideos(force = false) {
        if (!channelUsernameInput) return;
        const username = normalizeChannelInput(channelUsernameInput.value);
        if (username !== channelUsernameInput.value.trim()) channelUsernameInput.value = username;

        if (!username || username.length < 2) {
            setChannelStatus('');
            if (channelVideosList) { channelVideosList.innerHTML = ''; channelVideosList.classList.add('hidden'); }
            if (channelLoadMoreRow) channelLoadMoreRow.classList.add('hidden');
            if (channelMediaVaultPanel) channelMediaVaultPanel.classList.add('hidden');
            lastChannelQueryKey = '';
            currentLoadedVideos = [];
            channelHasMore = false;
            return;
        }
        if (!/^[A-Za-z0-9_-]{2,30}$/.test(username)) {
            setChannelStatus('Usernames can only contain letters, numbers, _ and -', 'error');
            return;
        }

        const queryKey = `${channelPlatform}:${username.toLowerCase()}:${channelType}:${channelRange}`;
        if (!force && queryKey === lastChannelQueryKey) return;
        lastChannelQueryKey = queryKey;

        channelPage = 1;
        channelCursor = null;
        channelHasMore = false;

        const seq = ++channelRequestSeq;
        const platformLabel = channelPlatform === 'kick' ? 'Kick' : 'Twitch';
        let rangeText = '';
        if (channelType === 'clips') {
            if (channelRange === 'featured') rangeText = ' (Featured)';
            else if (channelRange === '24h') rangeText = ' (24 Hours)';
            else if (channelRange === '7d') rangeText = ' (Week)';
            else if (channelRange === '30d') rangeText = ' (30 Days)';
        }
        setChannelStatus(`⚡ Loading ${username}'s ${channelType}${rangeText} from ${platformLabel}...`, 'loading');
        if (channelSearchBtn) channelSearchBtn.classList.add('fetching');

        try {
            const params = new URLSearchParams({
                platform: channelPlatform,
                username,
                type: channelType,
                range: channelRange,
                page: '1'
            });
            const res = await fetch(`/api/channel-videos?${params.toString()}`);
            const data = await res.json();
            if (seq !== channelRequestSeq) return; // a newer search superseded this one

            if (!data.success) {
                lastChannelQueryKey = ''; // allow retry
                setChannelStatus(data.error || 'Could not load channel', 'error');
                if (channelVideosList) {
                    channelVideosList.classList.remove('hidden');
                    channelVideosList.innerHTML = `<div class="channel-videos-empty">${escapeHtml(data.error || 'Could not load channel videos.')}</div>`;
                }
                if (channelLoadMoreRow) channelLoadMoreRow.classList.add('hidden');
                return;
            }

            const videos = Array.isArray(data.videos) ? data.videos : [];
            channelHasMore = !!data.hasMore;
            channelCursor = data.nextCursor || null;
            channelPage = data.page || 1;

            const typeLabel = channelType === 'vods' ? 'VODs' : (channelType === 'highlights' ? 'Highlights' : 'Clips');
            setChannelStatus(videos.length ? `✓ ${videos.length} ${typeLabel} loaded in vault below` : `No ${typeLabel} found`, videos.length ? 'success' : '');
            renderChannelVideos(videos, username, false);
        } catch (err) {
            if (seq !== channelRequestSeq) return;
            lastChannelQueryKey = '';
            setChannelStatus('Backend server unreachable', 'error');
        } finally {
            if (seq === channelRequestSeq && channelSearchBtn) channelSearchBtn.classList.remove('fetching');
        }
    }

    async function loadMoreChannelVideos() {
        if (isLoadingMore || !channelHasMore || !channelUsernameInput) return;
        const username = normalizeChannelInput(channelUsernameInput.value);
        if (!username) return;

        isLoadingMore = true;
        if (channelLoadMoreBtn) {
            channelLoadMoreBtn.disabled = true;
            channelLoadMoreBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Loading more...`;
        }
        setChannelStatus(`⚡ Loading more ${channelType}...`, 'loading');

        try {
            const nextPage = channelPage + 1;
            const params = new URLSearchParams({
                platform: channelPlatform,
                username,
                type: channelType,
                range: channelRange,
                page: String(nextPage)
            });
            if (channelCursor) {
                params.set('cursor', channelCursor);
            }

            const res = await fetch(`/api/channel-videos?${params.toString()}`);
            const data = await res.json();

            if (!data.success || !Array.isArray(data.videos) || data.videos.length === 0) {
                channelHasMore = false;
                if (channelLoadMoreRow) channelLoadMoreRow.classList.add('hidden');
                setChannelStatus(`✓ All ${currentLoadedVideos.length} loaded`, 'success');
                return;
            }

            channelPage = data.page || nextPage;
            channelHasMore = !!data.hasMore;
            channelCursor = data.nextCursor || null;

            renderChannelVideos(data.videos, username, true);
            setChannelStatus(`✓ ${currentLoadedVideos.length} loaded — click one to load`, 'success');
            logToConsole(`[Channel Browser] Loaded +${data.videos.length} more ${channelType} (${currentLoadedVideos.length} total)`, 'info');
        } catch (e) {
            console.error('Error loading more videos:', e);
            setChannelStatus('Failed to load more items', 'error');
        } finally {
            isLoadingMore = false;
            if (channelLoadMoreBtn) {
                channelLoadMoreBtn.disabled = false;
                channelLoadMoreBtn.innerHTML = `<i class="fa-solid fa-angles-down"></i> Load More ${channelType === 'clips' ? 'Clips' : 'Videos'}`;
            }
        }
    }

    if (channelUsernameInput) {
        channelUsernameInput.addEventListener('input', () => {
            clearTimeout(channelDebounceTimer);
            channelDebounceTimer = setTimeout(() => loadChannelVideos(false), 400);
        });
        channelUsernameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                clearTimeout(channelDebounceTimer);
                loadChannelVideos(true);
            }
        });
    }
    if (channelSearchBtn) {
        channelSearchBtn.addEventListener('click', () => {
            clearTimeout(channelDebounceTimer);
            loadChannelVideos(true);
        });
    }
    if (channelPlatformToggle) {
        channelPlatformToggle.querySelectorAll('.channel-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => selectChannelPlatform(btn.getAttribute('data-platform')));
        });
    }
    if (channelTypeToggle) {
        channelTypeToggle.querySelectorAll('.channel-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => selectChannelType(btn.getAttribute('data-type')));
        });
    }
    if (channelRangeToggle) {
        channelRangeToggle.querySelectorAll('.channel-range-btn').forEach(btn => {
            btn.addEventListener('click', () => selectChannelRange(btn.getAttribute('data-range')));
        });
    }
    if (channelLoadMoreBtn) {
        channelLoadMoreBtn.addEventListener('click', () => {
            loadMoreChannelVideos();
        });
    }

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
        const rangeRow = document.getElementById('transcript-range-row');
        if (rangeRow) {
            rangeRow.style.display = mode === 'transcript' ? 'flex' : 'none';
        }
        if (mode === 'transcript') {
            updateTranscriptDurationDisplay();
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
                // -avoid_negative_ts make_zero + -fflags +genpts+discardcorrupt+igndts: fixes keyframe timestamp misalignment
                const ffmpegFix = '-c copy -avoid_negative_ts make_zero -fflags +genpts+discardcorrupt+igndts -movflags +faststart';
                const impersonate = url.toLowerCase().includes('kick.com') ? ' --impersonate Chrome' : '';

                const avcFormat = 'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a][acodec^=mp4a]/bestvideo+bestaudio/best[ext=mp4]';
                if (url.toLowerCase().includes('kick.com')) {
                    const fmtStr = preset === 'auto' ? avcFormat : preset;
                    cmd = `yt-dlp --js-runtimes node${impersonate} --newline --download-sections "*${start}-${end}" -f "${fmtStr}" --merge-output-format mp4 --postprocessor-args "ffmpeg:${ffmpegFix}" -o "${out}" "${url}"`;
                } else if (url.toLowerCase().includes('twitch.tv')) {
                    cmd = `yt-dlp --js-runtimes node --newline --download-sections "*${start}-${end}" -f "${avcFormat}" --merge-output-format mp4 --postprocessor-args "ffmpeg:${ffmpegFix}" -o "${out}" "${url}"`;
                } else {
                    cmd = `yt-dlp --js-runtimes node --newline --download-sections "*${start}-${end}" -f "${avcFormat}" --merge-output-format mp4 --postprocessor-args "ffmpeg:${ffmpegFix}" -o "${out}" "${url}"`;
                }
                break;
            }

            case 'tab-multi-section': {
                const url = document.getElementById('multi-url').value.trim() || '<VIDEO_URL>';
                const outDir = document.getElementById('multi-output').value.trim() || 'downloads/yt-sections';
                const items = Array.from(rangesListUl.querySelectorAll('.range-item')).map(li => {
                    return li.dataset.range || li.querySelector('span')?.textContent.replace(/^[\s\S]*?(\d{2}:\d{2}:\d{2}-\d{2}:\d{2}:\d{2})/, '$1').trim();
                }).filter(Boolean);
                
                const impersonate = url.toLowerCase().includes('kick.com') ? ' --impersonate Chrome' : '';
                if (items.length === 0) {
                    cmd = `yt-dlp${impersonate} --js-runtimes node --newline "${url}" --download-sections "*00:01:00-00:02:30" -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${outDir}/clip_00-01-00-00-02-30.%(ext)s"`;
                } else {
                    const rangesCmds = items.map(r => `yt-dlp${impersonate} --js-runtimes node --newline "${url}" --download-sections "*${r}" -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${outDir}/clip_${r.replace(/:/g, '-')}.%(ext)s"`).join(' && ');
                    cmd = `if not exist "${outDir}" mkdir "${outDir}" && ${rangesCmds}`;
                }
                break;
            }

            case 'tab-shorts-harvest': {
                let channel = document.getElementById('shorts-channel').value.trim() || '@channelname';
                if (channel.startsWith('@')) {
                    channel = `https://www.youtube.com/${channel}`;
                }
                if (/youtube\.com\/@[^/]+$/i.test(channel)) {
                    channel = `${channel}/shorts`;
                }
                const maxDur = document.getElementById('shorts-duration')?.value || '61';
                const maxCount = document.getElementById('shorts-max-count')?.value || '25';
                const outDir = document.getElementById('shorts-output')?.value || 'downloads/shorts';
                const useArchive = document.getElementById('shorts-archive-check')?.checked;
                
                const archiveFlag = useArchive ? ` --download-archive "${outDir}/downloaded.txt"` : '';
                const limitFlag = maxCount !== 'all' ? ` --playlist-end ${maxCount}` : '';
                cmd = `yt-dlp --js-runtimes node --sleep-requests 1.5 --extractor-args "youtube:player_client=android_vr,web_creator" --newline "${channel}" --match-filter "duration < ${maxDur}"${limitFlag} -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${outDir}/%(title)s - %(id)s.%(ext)s"${archiveFlag}`;
                break;
            }

            case 'tab-silence-cutter': {
                const url = document.getElementById('silence-url').value.trim() || '<VIDEO_URL>';
                const db = document.getElementById('silence-db')?.value || '-33';
                const margin = document.getElementById('silence-margin')?.value || '50';
                const titleVal = document.getElementById('silence-title')?.value.trim();
                const filename = titleVal ? sanitizeFilename(titleVal) : 'silence_clip';
                const rawPath = `downloads/${filename}_raw.mp4`;
                const cutPath = `downloads/${filename}_cut.mp4`;
                cmd = `yt-dlp --js-runtimes node --newline -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${rawPath}" "${url}" && auto-editor "${rawPath}" --edit audio:${db}dB --margin ${margin} --output "${cutPath}"`;
                break;
            }

            case 'tab-file-converter': {
                const input = document.getElementById('convert-input').value.trim() || 'input_media.mkv';
                const outName = document.getElementById('convert-name').value.trim() || 'converted_clip';
                const preset = document.getElementById('convert-preset')?.value || 'copy';
                let ffmpegFlags = '-c copy -movflags +faststart';
                let outExt = 'mp4';
                if (preset === 'h264') {
                    ffmpegFlags = '-c:v libx264 -preset fast -crf 20 -c:a aac -b:a 192k -movflags +faststart';
                } else if (preset === 'audio') {
                    ffmpegFlags = '-vn -c:a libmp3lame -q:a 2';
                    outExt = 'mp3';
                }
                cmd = `ffmpeg -y -i "${input}" ${ffmpegFlags} "downloads/${outName}.${outExt}"`;
                break;
            }

            case 'tab-yt-tags': {
                const url = document.getElementById('tags-url').value.trim() || '<VIDEO_URL>';
                const mode = document.querySelector('input[name="analysis-mode"]:checked')?.value || 'tags';

                if (mode === 'tags') {
                    cmd = `yt-dlp -j "${url}" | jq -r ".tags // [\\"No tags\\"] | join(\\", \\")"`;
                } else {
                    const start = (document.getElementById('transcript-start')?.value || '').trim();
                    const end = (document.getElementById('transcript-end')?.value || '').trim();
                    let rangeArgs = '';
                    if (end.toLowerCase() === 'full') {
                        rangeArgs = ' --full';
                    } else {
                        if (start) rangeArgs += ` --start ${start}`;
                        if (end) rangeArgs += ` --end ${end}`;
                    }
                    cmd = `python transcribe_whisper.py "${url}"${rangeArgs}`;
                }
                break;
            }

            case 'tab-yt-thumbnail': {
                const url = document.getElementById('thumb-url').value.trim() || '<VIDEO_URL>';
                const titleVal = document.getElementById('thumb-title')?.value.trim();
                const outName = titleVal ? sanitizeFilename(titleVal) : '%(title)s';
                cmd = `yt-dlp --skip-download --write-thumbnail --convert-thumbnails jpg -o "downloads/${outName}" "${url}"`;
                break;
            }

            case 'tab-hdd-mirror': {
                const src = document.getElementById('mirror-source').value.trim() || 'downloads';
                const dest = document.getElementById('mirror-dest').value.trim() || 'D:\\ClipsBackup';
                const mode = document.getElementById('mirror-mode')?.value || 'safe';
                const flags = mode === 'mirror' ? '/MIR /R:1 /W:1 /NFL /NDL /NJH /NJS' : '/E /XO /R:1 /W:1 /NFL /NDL /NJH /NJS';
                cmd = `robocopy "${src}" "${dest}" ${flags}`;
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

    // --- Jump Player to Timestamp (Interactive Transcript Click) ---
    window.jumpToPlayerTimestamp = async function(seconds, timeLabel, rowElem) {
        if (typeof seconds !== 'number' || isNaN(seconds)) return;

        // If player is hidden or not embedded yet, embed it using the active URL
        if (activePlayerType === 'none' || !mediaPlayerCard || mediaPlayerCard.classList.contains('hidden')) {
            const urlInputIds = ['tags-url', 'section-url', 'quick-url'];
            let activeUrl = lastActiveUrl;
            for (const id of urlInputIds) {
                const val = document.getElementById(id)?.value.trim();
                if (val) {
                    activeUrl = val;
                    break;
                }
            }
            if (activeUrl) {
                await embedVideoPlayer(activeUrl, 'auto');
                await new Promise(r => setTimeout(r, 600));
            }
        }

        // Expand player container if collapsed
        const container = document.getElementById('player-iframe-container');
        if (container && container.style.display === 'none') {
            togglePlayerExpand();
        }

        let jumped = false;

        // Twitch Player seek & play
        if (activePlayerType === 'twitch' && twitchPlayerInstance) {
            try {
                if (typeof twitchPlayerInstance.seek === 'function') {
                    twitchPlayerInstance.seek(seconds);
                    if (typeof twitchPlayerInstance.play === 'function') {
                        twitchPlayerInstance.play();
                    }
                    jumped = true;
                }
            } catch (err) {
                console.warn('[Twitch Seek Error]', err);
            }
        }

        // YouTube Player seek & play
        if (activePlayerType === 'youtube' && ytPlayerInstance) {
            try {
                if (typeof ytPlayerInstance.seekTo === 'function') {
                    ytPlayerInstance.seekTo(seconds, true);
                    if (typeof ytPlayerInstance.playVideo === 'function') {
                        ytPlayerInstance.playVideo();
                    }
                    jumped = true;
                }
            } catch (err) {
                console.warn('[YouTube Seek Error]', err);
            }
        }

        // HTML5 Video Player (if embedded)
        const html5Video = document.querySelector('#player-iframe-container video');
        if (html5Video) {
            html5Video.currentTime = seconds;
            html5Video.play().catch(() => {});
            jumped = true;
        }

        // Scroll smoothly to player
        if (mediaPlayerCard && !mediaPlayerCard.classList.contains('hidden')) {
            mediaPlayerCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // Highlight clicked row
        document.querySelectorAll('.transcript-interactive-row').forEach(r => r.classList.remove('active'));
        if (rowElem) {
            rowElem.classList.add('active');
        }

        if (jumped) {
            logToConsole(`[Player] Jumped player to timestamp: ${timeLabel || formatSecondsToHHMMSS(seconds)} (${Math.floor(seconds)}s)`, 'success');
        } else {
            logToConsole(`[Player] Selected timestamp ${timeLabel || formatSecondsToHHMMSS(seconds)}. Video ready in player.`, 'info');
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
            if (progressStatusTitle) progressStatusTitle.textContent = 'Process Complete!';
        } else {
            if (progressStatusTitle) progressStatusTitle.textContent = 'Process Finished';
        }
        setTimeout(() => {
            if (progressCard) progressCard.classList.add('hidden');
        }, 3000);
    }

    function hideProgressBar() {
        if (progressCard) progressCard.classList.add('hidden');
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

        const singleFileTabs = ['tab-quick-download', 'tab-section-clipper', 'tab-silence-cutter', 'tab-file-converter'];

        // 1. Open Save As Folder Picker FIRST before initiating download process (Single-file operations only)
        if (singleFileTabs.includes(activeTabId) && typeof window.showSaveFilePicker === 'function') {
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
            } else if (activeTabId === 'tab-file-converter') {
                const presetVal = document.getElementById('convert-preset')?.value || '';
                if (presetVal === 'audio') ext = 'mp3';
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

            if (activeTabId === 'tab-yt-thumbnail') {
                const url = document.getElementById('thumb-url').value.trim();
                const ytId = extractYtId(url);
                if (ytId) {
                    const maxResUrl = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
                    if (thumbPreviewImg) {
                        thumbPreviewImg.onerror = function() {
                            this.onerror = null;
                            this.src = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
                        };
                        thumbPreviewImg.src = maxResUrl;
                    }
                    if (thumbDownloadLink) thumbDownloadLink.href = maxResUrl;
                    if (thumbnailPreviewCard) thumbnailPreviewCard.classList.remove('hidden');
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

                            if (textBox) {
                                textBox.classList.remove('transcript-interactive-container');
                                textBox.textContent = `[Channel / Uploader]: ${channel || 'YouTube'}\n\n[DESCRIPTION]:\n${description}`;
                            }
                            rawTranscriptData = description || '';
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
                    const startVal = (document.getElementById('transcript-start')?.value || '').trim();
                    const endVal = (document.getElementById('transcript-end')?.value || '').trim();
                    const isFull = endVal.toLowerCase() === 'full';
                    const hasRange = Boolean(startVal || (endVal && !isFull));
                    const rangeMsg = isFull ? ' (Full Stream)' : (hasRange ? ` (${startVal || '00:00:00'} - ${endVal})` : ' (First 5m Fast Preview)');

                    logToConsole(`[AI Transcript] Generating speech-to-text transcript${rangeMsg}...`, 'system');
                    showProgressBar('Connecting & preparing audio stream...');
                    updateProgressBar(5, 'Connecting...', 'Starting');

                    try {
                        const response = await fetch('/api/fetch-transcript', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                url: tagsUrl,
                                start: isFull ? '' : startVal,
                                end: isFull ? '' : endVal,
                                full: isFull
                            })
                        });

                        if (response.ok && response.body) {
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
                                        if (data.type === 'progress') {
                                            updateProgressBar(data.percent, data.speed || 'Whisper AI', data.eta || 'Compiling');
                                            if (progressStatusTitle) progressStatusTitle.textContent = data.status || 'Compiling dialogue timestamps...';
                                        } else if (data.type === 'result') {
                                            if (data.success && data.transcript) {
                                                updateProgressBar(100, 'Complete', '0s');
                                                if (progressStatusTitle) progressStatusTitle.textContent = 'Transcription Complete!';
                                                setTimeout(() => {
                                                    hideProgressBar();
                                                }, 800);

                                                const videoBlock = document.getElementById('results-video-tags-block');
                                                const channelBlock = document.getElementById('results-channel-tags-block');
                                                const bodyHeaderTitle = document.getElementById('results-body-header-title');
                                                const noticeBanner = document.getElementById('results-notice-banner');

                                                if (videoBlock) videoBlock.style.display = 'none';
                                                if (channelBlock) channelBlock.style.display = 'none';
                                                if (bodyHeaderTitle) bodyHeaderTitle.innerHTML = '<i class="fa-solid fa-brain"></i> AI Subtitles & Full Transcript';

                                                if (resultsTitle) resultsTitle.textContent = 'AI Speech-to-Text Transcript (Local Whisper)';
                                                if (resultsIcon) resultsIcon.className = 'fa-solid fa-brain results-icon';

                                                if (noticeBanner) {
                                                    if (data.notice) {
                                                        noticeBanner.innerHTML = `<i class="fa-solid fa-bolt"></i> <span>${escapeHtml(data.notice)}</span>`;
                                                        noticeBanner.classList.remove('hidden');
                                                    } else {
                                                        noticeBanner.classList.add('hidden');
                                                    }
                                                }

                                                if (textBox) {
                                                    renderInteractiveTranscript(data.transcript);
                                                }
                                                if (resultsCard) resultsCard.classList.remove('hidden');

                                                logToConsole('[Success] Speech-to-text transcript generated directly on-screen!', 'success');
                                            } else {
                                                hideProgressBar();
                                                logToConsole(`[Error] ${data.error || 'Could not extract transcript for this video.'}`, 'error');
                                            }
                                        }
                                    } catch (parseErr) {
                                        // Ignore partial JSON parse errors
                                    }
                                }
                            }
                        } else {
                            hideProgressBar();
                            logToConsole('[Error] Failed to connect to transcript service.', 'error');
                        }
                    } catch (e) {
                        hideProgressBar();
                        logToConsole('[Error] Failed to connect to transcript service.', 'error');
                    }
                }

                resetExecutionState();
                return;
            }

            try {
                showProgressBar('Connecting & Downloading Media...');
                const response = await fetch('/api/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: cmd, tabId: activeTabId })
                });

                if (response.ok && response.body) {
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
                                    const isSuccess = (activeTabId === 'tab-hdd-mirror') ? (typeof data.exitCode === 'number' && data.exitCode < 8) : (data.exitCode === 0);
                                    finishProgressBar(isSuccess);
                                    if (activeTabId === 'tab-hdd-mirror' && isSuccess) {
                                        logToConsole(`[Robocopy] HDD sync completed successfully (Exit Code: ${data.exitCode})!`, 'success');
                                    }
                                    // downloadToken + fileName come in the same done packet
                                    if (isSuccess && data.downloadToken && data.fileName) {
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
        const videoTagsContainer = document.getElementById('results-video-tags-cloud') || tagsCloudContainer;
        const descContainer = document.getElementById('results-text-box') || descriptionBoxContainer;
        const metaCard = document.getElementById('extracted-results-card') || extractedMetaCard;

        if (videoTagsContainer) {
            videoTagsContainer.innerHTML = '';
            if (Array.isArray(tagsArr) && tagsArr.length > 0) {
                tagsArr.forEach(tag => {
                    const pill = document.createElement('span');
                    pill.className = 'tag-pill';
                    pill.textContent = `#${tag}`;
                    pill.onclick = () => {
                        if (navigator.clipboard) {
                            navigator.clipboard.writeText(tag);
                        }
                        logToConsole(`[Clipboard] Copied tag: #${tag}`, 'info');
                    };
                    videoTagsContainer.appendChild(pill);
                });
            } else {
                videoTagsContainer.innerHTML = '<span class="text-muted" style="color:var(--text-muted);font-size:0.85rem;">No video tags extracted</span>';
            }
        }

        if (descContainer && descText) {
            descContainer.classList.remove('transcript-interactive-container');
            descContainer.textContent = descText;
        }

        if (metaCard) {
            metaCard.classList.remove('hidden');
        }
    }

    let rawTranscriptData = '';

    function renderInteractiveTranscript(rawText) {
        const textBox = document.getElementById('results-text-box') || descriptionBoxContainer;
        if (!textBox) return;

        rawTranscriptData = rawText || '';
        textBox.innerHTML = '';
        textBox.classList.add('transcript-interactive-container');

        const lines = (rawText || '').split(/[\r\n]+/);
        let hasTimestamps = false;
        const fragment = document.createDocumentFragment();

        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;

            // Match [HH:MM:SS - HH:MM:SS] or [MM:SS - MM:SS] dialogue
            const match = trimmed.match(/^\[([0-9:]+)(?:\s*-\s*([0-9:]+))?\]\s*(.*)$/);

            if (match) {
                hasTimestamps = true;
                const startStr = match[1];
                const endStr = match[2] || '';
                const text = match[3];
                const startSec = parseTimestampToSeconds(startStr);

                const row = document.createElement('div');
                row.className = 'transcript-interactive-row';

                const timeBtn = document.createElement('button');
                timeBtn.type = 'button';
                timeBtn.className = 'transcript-time-chip';
                timeBtn.title = `Jump player to ${startStr}`;
                timeBtn.innerHTML = `<i class="fa-solid fa-play"></i> <span>${escapeHtml(startStr)}${endStr ? ' - ' + escapeHtml(endStr) : ''}</span>`;
                timeBtn.onclick = () => jumpToPlayerTimestamp(startSec, startStr, row);

                const textSpan = document.createElement('span');
                textSpan.className = 'transcript-text-content';
                textSpan.textContent = text;

                row.appendChild(timeBtn);
                row.appendChild(textSpan);
                fragment.appendChild(row);
            } else {
                const plainRow = document.createElement('div');
                plainRow.className = 'transcript-plain-line';
                plainRow.textContent = trimmed;
                fragment.appendChild(plainRow);
            }
        });

        if (hasTimestamps) {
            textBox.appendChild(fragment);
        } else {
            textBox.classList.remove('transcript-interactive-container');
            textBox.textContent = rawText;
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
            textToCopy = rawTranscriptData || document.getElementById('results-text-box')?.innerText || '';
            logToConsole('[Clipboard] Copied Description / Transcript to clipboard!', 'success');
        } else if (category === 'all') {
            const vTags = Array.from(document.querySelectorAll('#results-video-tags-cloud .tag-pill')).map(p => p.textContent).join(', ');
            const cTags = Array.from(document.querySelectorAll('#results-channel-tags-cloud .tag-pill')).map(p => p.textContent).join(', ');
            const desc = rawTranscriptData || document.getElementById('results-text-box')?.innerText || '';
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

    window.browseFileForInput = async function(inputId, nameInputId) {
        const inputElem = document.getElementById(inputId);
        if (!inputElem) return;

        logToConsole('[System] Opening Windows File Browser dialog...', 'system');

        // 1. Try native Windows file dialog via backend API
        try {
            const response = await fetch('/api/select-file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.success && data.filePath) {
                    inputElem.value = data.filePath;
                    inputElem.dispatchEvent(new Event('input'));
                    if (nameInputId) {
                        const nameElem = document.getElementById(nameInputId);
                        if (nameElem) {
                            const baseName = data.filePath.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
                            nameElem.value = sanitizeFilename(baseName) || 'converted_clip';
                            nameElem.dispatchEvent(new Event('input'));
                        }
                    }
                    updateGeneratedCommand();
                    logToConsole(`[File Selected] Input media file set to: "${data.filePath}"`, 'success');
                    return;
                }
            }
        } catch (err) {}

        // 2. Browser file input fallback
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'video/*,.mkv,.mov,.avi,.webm,.flv,.mp4';
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                inputElem.value = file.name;
                inputElem.dispatchEvent(new Event('input'));
                if (nameInputId) {
                    const nameElem = document.getElementById(nameInputId);
                    if (nameElem) {
                        const baseName = file.name.replace(/\.[^/.]+$/, '');
                        nameElem.value = sanitizeFilename(baseName) || 'converted_clip';
                        nameElem.dispatchEvent(new Event('input'));
                    }
                }
                updateGeneratedCommand();
                logToConsole(`[File Selected] Selected local file: "${file.name}"`, 'info');
            }
        };
        fileInput.click();
    };

    window.downloadThumbnailImage = async function() {
        const img = document.getElementById('thumb-preview-img');
        if (!img || !img.src) return;
        const titleVal = document.getElementById('thumb-title')?.value.trim() || 'thumbnail';
        const filename = `${sanitizeFilename(titleVal) || 'thumbnail'}.jpg`;
        try {
            const res = await fetch(img.src);
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            logToConsole(`[Thumbnail] Successfully saved "${filename}"!`, 'success');
        } catch (e) {
            window.open(img.src, '_blank');
        }
    };

    window.updateRobocopyMode = function(mode) {
        const flagsElem = document.getElementById('robocopy-flags-display');
        const hintElem = document.getElementById('robocopy-hint-display');
        if (mode === 'mirror') {
            if (flagsElem) flagsElem.textContent = '/MIR /R:1 /W:1 /NFL /NDL /NJH /NJS';
            if (hintElem) hintElem.innerHTML = '<span style="color:#ef4444;font-weight:600;"><i class="fa-solid fa-triangle-exclamation"></i> Warning:</span> Mirrors source exactly. Any files on your HDD destination not present in source will be permanently deleted.';
        } else {
            if (flagsElem) flagsElem.textContent = '/E /XO /R:1 /W:1 /NFL /NDL /NJH /NJS';
            if (hintElem) hintElem.innerHTML = '🛡️ Copies subdirectories and newer files without deleting any existing files on your external drive.';
        }
        updateGeneratedCommand();
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
    }

    checkBackendHealth();
    updateSectionDurationDisplay();
    updateGeneratedCommand();
});
