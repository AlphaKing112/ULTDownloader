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

    // Modal elements
    const cmdModalOverlay = document.getElementById('cmd-modal-overlay');
    const modalCliCode = document.getElementById('modal-cli-code');

    function applyYouTubeCoverFallback(imgEl, ytId, onNextSrc = null) {
        if (!imgEl || !ytId) return;
        imgEl.onerror = function() {
            let nextSrc = '';
            if (this.src.includes('maxresdefault.jpg')) nextSrc = `https://img.youtube.com/vi/${ytId}/hq720.jpg`;
            else if (this.src.includes('hq720.jpg')) nextSrc = `https://img.youtube.com/vi/${ytId}/sddefault.jpg`;
            else if (this.src.includes('sddefault.jpg')) nextSrc = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
            if (nextSrc) {
                this.src = nextSrc;
                if (typeof onNextSrc === 'function') onNextSrc(nextSrc);
            }
        };
    }

    function triggerFileDownload(href, filename, { revokeMs = 0, showReadyBar = true, newTab = false } = {}) {
        if (!href) return;
        if (showReadyBar && typeof showDownloadReadyBar === 'function') {
            showDownloadReadyBar(href, filename);
        }
        const a = document.createElement('a');
        a.href = href;
        if (filename) a.download = filename;
        if (newTab) a.target = '_blank';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        if (revokeMs > 0 && href.startsWith('blob:')) {
            setTimeout(() => URL.revokeObjectURL(href), revokeMs);
        }
    }

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
            title: 'Thumbnail & Timestamp Frame Grabber',
            optionBadge: 'Option #11',
            icon: 'fa-regular fa-image',
            btnText: 'Capture / Fetch Thumbnail Frame',
            tip: 'Extracts high-resolution cover thumbnails or exact timestamp frames across YouTube, Twitch, and Kick.'
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

    function updateActionBtnForTab() {
        const meta = tabMetadata[activeTabId];
        if (!meta) return;
        let btnLabel = meta.btnText;
        if (activeTabId === 'tab-quick-download') {
            const fmt = document.getElementById('quick-format')?.value || '';
            if (fmt === 'audio_mp3') btnLabel = 'Download Audio (MP3)';
            else if (fmt === 'audio_m4a') btnLabel = 'Download Audio (M4A)';
            else if (fmt === 'compat_mp4') btnLabel = 'Download Universal MP4';
            else if (fmt.includes('1440')) btnLabel = 'Download Video (1440p 2K)';
            else if (fmt === 'bestvideo[height<=1080]+bestaudio/best') btnLabel = 'Download Video (1080p HD)';
            else if (fmt === 'bestvideo[height<=720]+bestaudio/best') btnLabel = 'Download Video (720p HD)';
        } else if (activeTabId === 'tab-section-clipper') {
            const preset = document.getElementById('section-format-preset')?.value || 'auto';
            const crop = document.getElementById('section-crop-mode')?.value || 'original';
            const cropGroup = document.getElementById('section-crop-group');
            const cutSelect = document.getElementById('section-cut-mode');
            if (cropGroup) cropGroup.style.display = preset === 'mp3' ? 'none' : '';
            if (cutSelect && cutSelect.closest('.form-group')) {
                cutSelect.closest('.form-group').style.display = preset === 'mp3' ? 'none' : '';
            }
            if (preset === 'mp3') btnLabel = 'Download Audio Clip (MP3)';
            else if (crop === 'vertical_crop' || crop === 'vertical_blur') btnLabel = 'Download 9:16 Vertical Clip';
        } else if (activeTabId === 'tab-yt-thumbnail') {
            const rawTime = document.getElementById('thumb-timestamp')?.value.trim();
            const isZero = !rawTime || rawTime === '0' || rawTime === '00:00:00' || rawTime === '0:00' || rawTime === '00:00';
            btnLabel = isZero ? 'Download Default Cover (HD)' : `Download Frame (${rawTime})`;
        } else if (activeTabId === 'tab-yt-tags') {
            const mode = document.querySelector('input[name="analysis-mode"]:checked')?.value || 'tags';
            btnLabel = mode === 'transcript' ? 'Generate AI Transcript' : 'Extract Tags & Metadata';
        }
        actionBtn.querySelector('span').textContent = btnLabel;
    }

    function activateTab(targetTabId) {
        if (typeof stopClipPreviewLoop === 'function' && activeTabId !== targetTabId) {
            stopClipPreviewLoop(false);
        }
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

        // Auto-sync active link into Tags & Transcript if empty so user doesn't have to re-paste
        if (activeTabId === 'tab-yt-tags') {
            const tagsInput = document.getElementById('tags-url');
            if (tagsInput && !tagsInput.value.trim()) {
                const candidate = getPreferredActiveUrl();
                if (candidate && /^https?:\/\//i.test(candidate)) {
                    tagsInput.value = candidate;
                }
            }
        }

        const meta = tabMetadata[activeTabId];
        if (meta) {
            tabTitle.textContent = meta.title;
            optionBadge.textContent = meta.optionBadge;
            headerIcon.className = `fa-solid ${meta.icon} header-icon`;
        }

        updateActionBtnForTab();
        updateGeneratedCommand();
        if (typeof checkMediaUrlInput === 'function') {
            checkMediaUrlInput();
        }
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
            if (sectionDurationText) sectionDurationText.textContent = label;
            if (sectionRangePreview) sectionRangePreview.textContent = `${sectionStartInput.value.trim()} → ${sectionEndInput.value.trim()}`;
            if (sectionDurationCard) sectionDurationCard.classList.remove('invalid');
        } else {
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

    // --- Live Transcript Range Duration, Platform Detection & AI Engine ---
    const transcriptStartInput = document.getElementById('transcript-start');
    const transcriptEndInput = document.getElementById('transcript-end');
    const transcriptDurationBadge = document.getElementById('transcript-duration-badge');
    const transcriptPlatformBadge = document.getElementById('transcript-platform-badge');
    const transcriptEngineHint = document.getElementById('transcript-engine-hint');
    const btnEngineWhisper = document.getElementById('btn-engine-whisper');
    const btnEngineCaptions = document.getElementById('btn-engine-captions');
    const tagsUrlField = document.getElementById('tags-url');
    let selectedTranscriptEngine = 'whisper';

    function detectTranscriptPlatform(url) {
        const u = String(url || '').trim().toLowerCase();
        if (!u) return null;
        if (u.includes('youtube.com') || u.includes('youtu.be')) {
            return { key: 'youtube', label: 'YouTube', icon: 'fa-brands fa-youtube', cls: 'plat-youtube', isYouTube: true };
        }
        if (u.includes('twitch.tv')) {
            const isClip = u.includes('clips.twitch.tv/') || u.includes('/clip/');
            return { key: isClip ? 'twitch_clip' : 'twitch_vod', label: isClip ? 'Twitch Clip' : 'Twitch VOD', icon: 'fa-brands fa-twitch', cls: 'plat-twitch', isYouTube: false };
        }
        if (u.includes('kick.com')) {
            const isClip = u.includes('/clips/') || u.includes('clip=');
            return { key: isClip ? 'kick_clip' : 'kick_vod', label: isClip ? 'Kick Clip' : 'Kick VOD', icon: 'fa-solid fa-bolt', cls: 'plat-kick', isYouTube: false };
        }
        return null;
    }

    function updateTranscriptPlatformUI() {
        const url = tagsUrlField ? tagsUrlField.value.trim() : '';
        const plat = detectTranscriptPlatform(url);

        if (transcriptPlatformBadge) {
            if (plat) {
                transcriptPlatformBadge.className = `transcript-platform-badge ${plat.cls}`;
                transcriptPlatformBadge.innerHTML = `<i class="${plat.icon}"></i> ${plat.label}`;
            } else {
                transcriptPlatformBadge.className = 'transcript-platform-badge hidden';
                transcriptPlatformBadge.innerHTML = '';
            }
        }

        const captionsAllowed = !plat || plat.isYouTube;
        if (btnEngineCaptions) {
            btnEngineCaptions.disabled = !captionsAllowed;
            if (!captionsAllowed && selectedTranscriptEngine === 'captions') {
                selectedTranscriptEngine = 'whisper';
            }
        }
        if (btnEngineWhisper && btnEngineCaptions) {
            btnEngineWhisper.classList.toggle('active', selectedTranscriptEngine === 'whisper');
            btnEngineCaptions.classList.toggle('active', selectedTranscriptEngine === 'captions');
        }

        if (transcriptEngineHint) {
            if (plat && !plat.isYouTube) {
                transcriptEngineHint.innerHTML = `<i class="fa-solid fa-circle-info"></i> <strong>${plat.label} detected:</strong> uses optimized ${plat.label.startsWith('Twitch') ? 'Twitch Audio-Only' : 'Kick Direct'} stream + Whisper AI voice speaker colors. Click any timestamp to jump.`;
            } else if (selectedTranscriptEngine === 'captions') {
                transcriptEngineHint.innerHTML = `<i class="fa-solid fa-circle-info"></i> <strong>Fast YT Captions:</strong> grabs full YouTube timed captions in 1-2s and parses <code>&gt;&gt;</code> speaker turns. Switch to <strong>Whisper AI + Speakers</strong> for voice-based speaker colors.`;
            } else {
                transcriptEngineHint.innerHTML = `<i class="fa-solid fa-circle-info"></i> <strong>Whisper AI + Speakers</strong> listens to voices on YouTube, Twitch &amp; Kick and highlights each speaker in a different color. Click any timestamp to jump, or click a speaker pill to filter/rename.`;
            }
        }

        updateTranscriptDurationDisplay();
    }

    window.setTranscriptEngine = function(engine) {
        const plat = detectTranscriptPlatform(tagsUrlField?.value);
        if (engine === 'captions' && plat && !plat.isYouTube) {
            logToConsole(`[Info] ${plat.label} uses Whisper AI (Fast YT Captions only applies to YouTube links).`, 'info');
            return;
        }
        selectedTranscriptEngine = engine === 'captions' ? 'captions' : 'whisper';
        updateTranscriptPlatformUI();
    };

    window.rerunTranscriptWithWhisper = function() {
        selectedTranscriptEngine = 'whisper';
        const detectBox = document.getElementById('transcript-detect-speakers');
        if (detectBox) detectBox.checked = true;
        updateTranscriptPlatformUI();
        if (btnExecuteCmd && !btnExecuteCmd.disabled) {
            btnExecuteCmd.click();
        }
    };

    function updateTranscriptDurationDisplay() {
        if (!transcriptStartInput || !transcriptEndInput || !transcriptDurationBadge) return;

        const startVal = transcriptStartInput.value.trim();
        const endVal = transcriptEndInput.value.trim();

        if (!startVal && !endVal) {
            const label = selectedTranscriptEngine === 'captions'
                ? 'Auto (Instant Full YT Subs)'
                : 'Auto (Whisper AI · 5m VOD)';
            transcriptDurationBadge.innerHTML = `<i class="fa-solid fa-bolt"></i> ${label}`;
            transcriptDurationBadge.className = 'badge-duration valid';
            return;
        }
        if (endVal.toLowerCase() === 'full') {
            transcriptDurationBadge.innerHTML = '<i class="fa-solid fa-infinity"></i> Full Stream';
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

    if (tagsUrlField) {
        tagsUrlField.addEventListener('input', updateTranscriptPlatformUI);
        tagsUrlField.addEventListener('change', updateTranscriptPlatformUI);
    }

    window.setTranscriptPreset = function(preset) {
        if (!transcriptStartInput || !transcriptEndInput) return;
        document.querySelectorAll('.transcript-preset-pill').forEach(p => p.classList.remove('active'));

        if (preset === 'auto') {
            transcriptStartInput.value = '';
            transcriptEndInput.value = '';
        } else if (preset === '5m') {
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
        return str.replace(/[\\/:*?"<>|$]/g, '_').replace(/\s+/g, ' ').trim();
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

        // ONLY fetch & display Video Tags & Metadata card when explicitly on the Tags tab!
        const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
        if (activeTab !== 'tab-yt-tags') {
            const card = document.getElementById('extracted-results-card');
            if (card) card.classList.add('hidden');
            return;
        }

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
                renderExtractedMetadataResult(data);
                const vCount = data.metadata.video_tags?.length || 0;
                const cCount = data.metadata.channel_tags?.length || 0;
                logToConsole(`[Metadata] Extracted ${vCount} video tags & ${cCount} channel tags from ${data.metadata.channel || 'YouTube'}.`, 'success');
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
                    if (pair.urlId === 'tags-url') {
                        window.fetchFullMetadataForUrl(url);
                    }
                    if (pair.urlId === 'thumb-url' && typeof window.resetThumbnailToDefaultCover === 'function') {
                        window.resetThumbnailToDefaultCover();
                    }
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
            updateActionBtnForTab();
            updateGeneratedCommand();
        }
        const tagsSummary = document.getElementById('tags-mode-summary');
        if (tagsSummary) {
            tagsSummary.style.display = mode === 'tags' ? 'flex' : 'none';
        }
        const rangeRow = document.getElementById('transcript-range-row');
        if (rangeRow) {
            rangeRow.style.display = mode === 'transcript' ? 'flex' : 'none';
        }
        if (mode === 'transcript') {
            updateTranscriptPlatformUI();
        }
    };

    // --- CLI Command Generator ---
    function buildCommandForActiveTab() {
        let cmd = '';

        switch (activeTabId) {
            case 'tab-quick-download': {
                const url = document.getElementById('quick-url').value.trim() || '<VIDEO_URL>';
                const titleVal = document.getElementById('quick-title')?.value.trim();
                const cleanTitle = titleVal ? sanitizeFilename(titleVal) : '';
                const fmt = document.getElementById('quick-format').value;
                const impersonate = url.toLowerCase().includes('kick.com') ? ' --impersonate Chrome' : '';

                if (fmt === 'audio_mp3' || fmt === 'audio_m4a' || fmt === 'bestaudio/best') {
                    const audioFmt = fmt === 'audio_m4a' ? 'm4a' : 'mp3';
                    const audioSel = audioFmt === 'm4a' ? 'bestaudio[ext=m4a]/bestaudio/best' : 'bestaudio/best';
                    const out = `downloads/${cleanTitle || '%(title)s'}.%(ext)s`;
                    cmd = `yt-dlp${impersonate} --js-runtimes node --newline --no-part -f "${audioSel}" -x --audio-format ${audioFmt} --audio-quality 0 -o "${out}" "${url}"`;
                } else {
                    const realFmt = fmt === 'compat_mp4'
                        ? 'bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo+bestaudio/best'
                        : fmt;
                    const sortFlag = fmt === 'compat_mp4' ? ' -S "vcodec:h264,acodec:m4a"' : '';
                    const out = cleanTitle
                        ? `downloads/${cleanTitle}.%(ext)s`
                        : `downloads/%(title)s_%(height|best)sp.%(ext)s`;
                    cmd = `yt-dlp${impersonate} --js-runtimes node --newline --no-part -f "${realFmt}"${sortFlag} --merge-output-format mp4 -o "${out}" "${url}"`;
                }
                break;
            }

            case 'tab-section-clipper': {
                const url = document.getElementById('section-url').value.trim() || '<VIDEO_URL>';
                const titleVal = document.getElementById('section-title')?.value.trim();
                const cleanTitle = titleVal ? sanitizeFilename(titleVal) : '';
                const start = document.getElementById('section-start').value.trim() || '00:00:00';
                const end = document.getElementById('section-end').value.trim() || '00:01:00';
                const rangeTag = `${start.replace(/[:.]/g, '-')}_to_${end.replace(/[:.]/g, '-')}`;
                const preset = document.getElementById('section-format-preset')?.value || 'auto';
                const cutMode = document.getElementById('section-cut-mode')?.value || 'fast';
                const cropMode = document.getElementById('section-crop-mode')?.value || 'original';
                const impersonate = url.toLowerCase().includes('kick.com') ? ' --impersonate Chrome' : '';

                if (preset === 'mp3') {
                    const baseName = cleanTitle ? `${cleanTitle}_${rangeTag}` : `%(title)s_${rangeTag}`;
                    const out = `downloads/${baseName}.%(ext)s`;
                    cmd = `yt-dlp --js-runtimes node${impersonate} --newline --no-part --download-sections "*${start}-${end}" -f "bestaudio/best" -x --audio-format mp3 --audio-quality 0 -o "${out}" "${url}"`;
                } else {
                    const formatMap = {
                        auto: 'bestvideo+bestaudio/best',
                        compat: 'bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo+bestaudio/best',
                        '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
                        '720p': 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
                        '480p': 'bestvideo[height<=480]+bestaudio/best[height<=480]/best',
                        '1080p60': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
                        best: 'bestvideo+bestaudio/best'
                    };
                    const fmtStr = formatMap[preset] || formatMap.auto;
                    const sortFlag = preset === 'compat' ? ' -S "vcodec:h264,acodec:m4a"' : '';
                    const exactFlag = cutMode === 'exact' ? ' --force-keyframes-at-cuts' : '';
                    const ppArgs = cutMode === 'exact'
                        ? ' --postprocessor-args "Merger+ffmpeg:-movflags +faststart"'
                        : ' --downloader-args "ffmpeg_i:-fflags +discardcorrupt+igndts" --postprocessor-args "Merger+ffmpeg:-c copy -avoid_negative_ts make_zero -movflags +faststart"';
                    const cropSuffix = (cropMode === 'vertical_crop' || cropMode === 'vertical_blur') ? '_9x16' : '';
                    const baseName = cleanTitle ? `${cleanTitle}_${rangeTag}${cropSuffix}` : `%(title)s_${rangeTag}${cropSuffix}`;
                    const out = `downloads/${baseName}.%(ext)s`;
                    cmd = `yt-dlp --js-runtimes node${impersonate} --newline --no-part --download-sections "*${start}-${end}"${exactFlag} -f "${fmtStr}"${sortFlag} --merge-output-format mp4${ppArgs} -o "${out}" "${url}"`;
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
                const timeVal = document.getElementById('thumb-timestamp')?.value.trim();
                const fmtExt = document.getElementById('thumb-format')?.value === 'png' ? 'png' : 'jpg';
                const outName = titleVal ? sanitizeFilename(titleVal) : '%(title)s';
                const ytId = extractYtId(url);
                if (ytId && !timeVal) {
                    cmd = `curl -L -o "downloads/${outName}.jpg" "https://img.youtube.com/vi/${ytId}/maxresdefault.jpg"`;
                } else if (timeVal) {
                    cmd = `yt-dlp --js-runtimes node -g -f "22/best[height<=720]/18/best" "${url}" | xargs -I {} ffmpeg -y -ss ${timeVal} -i "{}" -frames:v 1 "downloads/${outName}_${timeVal.replace(/:/g, '-')}.${fmtExt}"`;
                } else {
                    cmd = `yt-dlp --skip-download --write-thumbnail --convert-thumbnails ${fmtExt} -o "downloads/${outName}" "${url}"`;
                }
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
            updateActionBtnForTab();
            updateGeneratedCommand();
            checkMediaUrlInput();
        });
        elem.addEventListener('change', () => {
            updateActionBtnForTab();
            updateGeneratedCommand();
            checkMediaUrlInput();
        });
    });

    // --- Unified Media Player & Timestamp Capture ---
    const mediaPlayerCard = document.getElementById('media-player-card');
    const playerContainer = document.getElementById('player-iframe-container');
    const playerTitle = document.getElementById('media-player-title');
    const playerIcon = document.getElementById('player-type-icon');

    let activePlayerType = 'none'; // 'youtube', 'twitch', 'kick', 'html5', 'none'
    let currentEmbeddedMediaId = ''; // Track active video/VOD ID to prevent reloading iframe
    let ytPlayerInstance = null;
    let twitchPlayerInstance = null;
    let activeKickHlsInstance = null;
    let clipPreviewLoopTimer = null;
    let lastActiveUrl = '';

    function getActiveTabUrlInputId() {
        const tabUrlMap = {
            'tab-quick-download': 'quick-url',
            'tab-section-clipper': 'section-url',
            'tab-multi-section': 'multi-url',
            'tab-silence-cutter': 'silence-url',
            'tab-yt-tags': 'tags-url',
            'tab-yt-thumbnail': 'thumb-url'
        };
        return tabUrlMap[activeTabId] || null;
    }

    function getPreferredActiveUrl() {
        const tabInputId = getActiveTabUrlInputId();
        if (tabInputId) {
            const tabVal = document.getElementById(tabInputId)?.value.trim();
            if (tabVal && tabVal.length > 10) return tabVal;
        }
        const urlInputIds = ['section-url', 'quick-url', 'multi-url', 'silence-url', 'tags-url', 'thumb-url'];
        for (const id of urlInputIds) {
            const elem = document.getElementById(id);
            if (elem && elem.value.trim().length > 10) {
                return elem.value.trim();
            }
        }
        return lastActiveUrl || '';
    }

    function cleanupDirectHtml5Player() {
        if (activeKickHlsInstance) {
            try { activeKickHlsInstance.destroy(); } catch (e) {}
            activeKickHlsInstance = null;
        }
        const vid = document.getElementById('direct-html5-player');
        if (vid) {
            try {
                vid.pause();
                vid.removeAttribute('src');
                vid.load();
            } catch (e) {}
        }
    }

    function mountDirectHtml5Video(streamUrl, fallbackIframeSrc = null) {
        if (!playerContainer) return;
        cleanupDirectHtml5Player();
        playerContainer.innerHTML = `<video id="direct-html5-player" controls playsinline style="width:100%;height:320px;background:#000;border-radius:12px;outline:none;"></video>`;
        const videoEl = document.getElementById('direct-html5-player');
        if (!videoEl) return;

        const handlePlayFail = () => {
            if (fallbackIframeSrc && playerContainer) {
                cleanupDirectHtml5Player();
                playerContainer.innerHTML = `<iframe src="${fallbackIframeSrc}" height="320" width="100%" style="border:none;border-radius:12px;width:100%;height:320px;" allowfullscreen="true"></iframe>`;
            }
        };

        if (streamUrl.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
            activeKickHlsInstance = new Hls({ enableWorker: false });
            activeKickHlsInstance.loadSource(streamUrl);
            activeKickHlsInstance.attachMedia(videoEl);
            activeKickHlsInstance.on(Hls.Events.ERROR, (_evt, data) => {
                if (data && data.fatal) handlePlayFail();
            });
        } else {
            videoEl.onerror = handlePlayFail;
            videoEl.src = streamUrl;
        }
    }

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
        const detectedUrl = getPreferredActiveUrl();
        if (!detectedUrl) return;
        embedVideoPlayer(detectedUrl, 'auto');
    };

    window.embedVideoPlayer = async function(url, forceMode = 'auto') {
        if (!url) return;
        lastActiveUrl = url;

        const isTwitch = url.toLowerCase().includes('twitch.tv');
        const isYouTube = url.toLowerCase().includes('youtube.com') || url.toLowerCase().includes('youtu.be');
        const isKick = url.toLowerCase().includes('kick.com');

        let targetMode = forceMode;
        if (forceMode === 'auto') {
            if (isTwitch) targetMode = 'twitch';
            else if (isYouTube) targetMode = 'youtube';
            else if (isKick) targetMode = 'kick';
            else targetMode = 'hidden';
        }

        if (targetMode === 'hidden') {
            closeMediaPlayer();
            return;
        }

        if (targetMode === 'youtube' && isYouTube) {
            const ytId = extractYtId(url);
            if (!ytId) return;

            if (activePlayerType === 'youtube' && currentEmbeddedMediaId === ytId && !mediaPlayerCard.classList.contains('hidden')) {
                return;
            }

            cleanupDirectHtml5Player();
            stopClipPreviewLoop(false);
            currentEmbeddedMediaId = ytId;
            activePlayerType = 'youtube';

            if (mediaPlayerCard) mediaPlayerCard.classList.remove('hidden');
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

            if (activePlayerType === 'twitch' && currentEmbeddedMediaId === mediaId && !mediaPlayerCard.classList.contains('hidden')) {
                return;
            }

            cleanupDirectHtml5Player();
            stopClipPreviewLoop(false);
            currentEmbeddedMediaId = mediaId;
            activePlayerType = 'twitch';

            if (mediaPlayerCard) mediaPlayerCard.classList.remove('hidden');
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
                const fallbackIframe = `https://clips.twitch.tv/embed?clip=${clipId}&parent=${currentHost}&autoplay=false`;
                if (playerTitle) playerTitle.textContent = `Twitch Clip Player (${clipId})`;
                if (clipDirectUrlCache.has(clipId)) {
                    mountDirectHtml5Video(clipDirectUrlCache.get(clipId), fallbackIframe);
                } else {
                    try {
                        const r = await fetch(`/api/clip-preview?platform=twitch&slug=${encodeURIComponent(clipId)}`);
                        const data = await r.json();
                        if (data && data.success && data.previewUrl) {
                            clipDirectUrlCache.set(clipId, data.previewUrl);
                            mountDirectHtml5Video(data.previewUrl, fallbackIframe);
                        } else if (playerContainer) {
                            playerContainer.innerHTML = `<iframe src="${fallbackIframe}" height="320" width="100%" style="border:none;border-radius:12px;width:100%;height:320px;" allowfullscreen="true"></iframe>`;
                        }
                    } catch (e) {
                        if (playerContainer) {
                            playerContainer.innerHTML = `<iframe src="${fallbackIframe}" height="320" width="100%" style="border:none;border-radius:12px;width:100%;height:320px;" allowfullscreen="true"></iframe>`;
                        }
                    }
                }
            }
        } else if ((targetMode === 'kick' || targetMode === 'auto') && isKick) {
            const clipMatch = url.match(/(?:kick\.com\/[^\/]+\/clips\/|kick\.com\/clips\/|[?&]clip=)([A-Za-z0-9_-]+)/i);
            const vodMatch = url.match(/kick\.com\/[^\/]+\/videos\/([A-Za-z0-9_-]+)|kick\.com\/videos\/([A-Za-z0-9_-]+)/i);
            const channelMatch = url.match(/kick\.com\/([A-Za-z0-9_.-]+)/i);

            let channelSlug = '';
            if (channelMatch && !['video', 'videos', 'clips', 'categories'].includes(channelMatch[1].toLowerCase())) {
                channelSlug = channelMatch[1];
            }

            const kickVodId = vodMatch ? (vodMatch[1] || vodMatch[2]) : '';
            const kickClipId = clipMatch ? clipMatch[1] : '';
            const mediaId = kickVodId ? `kick_vod_${kickVodId}` : (kickClipId ? `kick_clip_${kickClipId}` : (channelSlug ? `kick_live_${channelSlug}` : 'kick_media'));

            if (activePlayerType === 'kick' && currentEmbeddedMediaId === mediaId && !mediaPlayerCard.classList.contains('hidden')) {
                return;
            }

            cleanupDirectHtml5Player();
            stopClipPreviewLoop(false);
            currentEmbeddedMediaId = mediaId;
            activePlayerType = 'kick';

            if (mediaPlayerCard) mediaPlayerCard.classList.remove('hidden');
            if (playerIcon) playerIcon.className = 'fa-solid fa-bolt player-icon kick';

            if (kickVodId || kickClipId) {
                if (playerTitle) playerTitle.textContent = kickVodId ? `Kick VOD Player (${kickVodId.slice(0, 8)}...)` : `Kick Clip Player (${kickClipId})`;
                const apiUrl = kickVodId
                    ? `/api/clip-preview?platform=kick&vodId=${encodeURIComponent(kickVodId)}`
                    : `/api/clip-preview?platform=kick&slug=${encodeURIComponent(kickClipId)}`;
                try {
                    const r = await fetch(apiUrl);
                    const data = await r.json();
                    if (data && data.success && data.previewUrl) {
                        mountDirectHtml5Video(data.previewUrl);
                        logToConsole(`[Player] Kick ${kickVodId ? 'VOD' : 'Clip'} loaded with live timestamp controls!`, 'info');
                        return;
                    }
                } catch (e) {}
            }

            if (playerTitle) {
                playerTitle.textContent = channelSlug ? `Kick Player (@${channelSlug})` : 'Kick Media Player';
            }

            if (playerContainer) {
                const targetSlug = kickClipId || kickVodId || channelSlug || '';
                playerContainer.innerHTML = `<iframe src="https://player.kick.com/${encodeURIComponent(targetSlug)}?autoplay=false&muted=false" height="320" width="100%" style="border:none;border-radius:12px;width:100%;height:320px;" allowfullscreen="true"></iframe>`;
            }
            logToConsole(`[Player] Kick player loaded for: ${url}`, 'info');
        }
    };

    window.closeMediaPlayer = function() {
        cleanupDirectHtml5Player();
        stopClipPreviewLoop(false);
        if (mediaPlayerCard) mediaPlayerCard.classList.add('hidden');
        if (playerContainer) playerContainer.innerHTML = '';
        activePlayerType = 'none';
        currentEmbeddedMediaId = '';
        ytPlayerInstance = null;
        twitchPlayerInstance = null;
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

    function getPlayerCurrentTime() {
        const html5Video = document.getElementById('direct-html5-player') || document.querySelector('#player-iframe-container video');
        if (html5Video && !isNaN(html5Video.currentTime)) {
            return html5Video.currentTime || 0;
        }
        if (activePlayerType === 'youtube' && ytPlayerInstance && typeof ytPlayerInstance.getCurrentTime === 'function') {
            try { return ytPlayerInstance.getCurrentTime() || 0; } catch (e) { return 0; }
        }
        if (activePlayerType === 'twitch' && twitchPlayerInstance && typeof twitchPlayerInstance.getCurrentTime === 'function') {
            try { return twitchPlayerInstance.getCurrentTime() || 0; } catch (e) { return 0; }
        }
        return 0;
    }

    function seekAndPlayPlayer(seconds) {
        const html5Video = document.getElementById('direct-html5-player') || document.querySelector('#player-iframe-container video');
        if (html5Video) {
            try {
                html5Video.currentTime = seconds;
                html5Video.play().catch(() => {});
                return true;
            } catch (e) {}
        }
        if (activePlayerType === 'youtube' && ytPlayerInstance && typeof ytPlayerInstance.seekTo === 'function') {
            try {
                ytPlayerInstance.seekTo(seconds, true);
                if (typeof ytPlayerInstance.playVideo === 'function') ytPlayerInstance.playVideo();
                return true;
            } catch (e) {}
        }
        if (activePlayerType === 'twitch' && twitchPlayerInstance && typeof twitchPlayerInstance.seek === 'function') {
            try {
                twitchPlayerInstance.seek(seconds);
                if (typeof twitchPlayerInstance.play === 'function') twitchPlayerInstance.play();
                return true;
            } catch (e) {}
        }
        return false;
    }

    function pauseActivePlayer() {
        const html5Video = document.getElementById('direct-html5-player') || document.querySelector('#player-iframe-container video');
        if (html5Video) {
            try { html5Video.pause(); } catch (e) {}
        }
        if (activePlayerType === 'youtube' && ytPlayerInstance && typeof ytPlayerInstance.pauseVideo === 'function') {
            try { ytPlayerInstance.pauseVideo(); } catch (e) {}
        }
        if (activePlayerType === 'twitch' && twitchPlayerInstance && typeof twitchPlayerInstance.pause === 'function') {
            try { twitchPlayerInstance.pause(); } catch (e) {}
        }
    }

    window.nudgeSectionTime = function(targetType = 'start', deltaSec = 1) {
        const targetId = targetType === 'start' ? 'section-start' : 'section-end';
        const elem = document.getElementById(targetId);
        if (!elem) return;
        const curSec = parseTimestampToSeconds(elem.value);
        const nextSec = Math.max(0, Math.round(curSec + deltaSec));
        elem.value = formatSecondsToHHMMSS(nextSec);
        elem.dispatchEvent(new Event('input'));
        updateSectionDurationDisplay();
        updateGeneratedCommand();
    };

    function stopClipPreviewLoop(pausePlayer = true) {
        if (clipPreviewLoopTimer) {
            clearInterval(clipPreviewLoopTimer);
            clipPreviewLoopTimer = null;
        }
        if (pausePlayer) pauseActivePlayer();
        const btn = document.getElementById('btn-preview-clip-loop');
        if (btn) {
            btn.classList.remove('btn-preview-active');
            btn.innerHTML = `<i class="fa-solid fa-repeat" style="color: #06b6d4;"></i> Preview Clip`;
        }
    }

    window.toggleClipPreviewLoop = async function() {
        if (clipPreviewLoopTimer) {
            stopClipPreviewLoop(true);
            logToConsole('[Clip Preview] Stopped preview loop.', 'info');
            return;
        }

        const url = document.getElementById('section-url')?.value.trim();
        if (!url) {
            logToConsole('[Clip Preview] Paste a video link first to preview the clip.', 'error');
            return;
        }

        const startSec = parseTimestampToSeconds(document.getElementById('section-start')?.value);
        const endSec = parseTimestampToSeconds(document.getElementById('section-end')?.value);
        if (endSec <= startSec) {
            logToConsole('[Clip Preview] End time must be greater than Start time.', 'error');
            return;
        }

        if (activePlayerType === 'none' || !mediaPlayerCard || mediaPlayerCard.classList.contains('hidden')) {
            await embedVideoPlayer(url, 'auto');
            await new Promise(r => setTimeout(r, 700));
        }

        if (!seekAndPlayPlayer(startSec)) {
            logToConsole('[Clip Preview] Player is still loading or iframe does not support direct seeking. Try pressing play in the player first.', 'system');
            return;
        }

        const btn = document.getElementById('btn-preview-clip-loop');
        if (btn) {
            btn.classList.add('btn-preview-active');
            btn.innerHTML = `<i class="fa-solid fa-stop" style="color: #ef4444;"></i> Stop Preview`;
        }

        const startStr = formatSecondsToHHMMSS(startSec);
        const endStr = formatSecondsToHHMMSS(endSec);
        logToConsole(`[Clip Preview] Looping ${startStr} → ${endStr} in player...`, 'success');

        clipPreviewLoopTimer = setInterval(() => {
            const curStart = parseTimestampToSeconds(document.getElementById('section-start')?.value);
            const curEnd = parseTimestampToSeconds(document.getElementById('section-end')?.value);
            const curPos = getPlayerCurrentTime();
            if (curEnd > curStart && curPos >= curEnd) {
                seekAndPlayPlayer(curStart);
            }
        }, 250);
    };

    // Live Player Position Ticker
    setInterval(() => {
        const liveTimeElem = document.getElementById('player-live-time-display');
        if (!liveTimeElem) return;
        if (activePlayerType === 'none' || (mediaPlayerCard && mediaPlayerCard.classList.contains('hidden'))) return;

        const sec = getPlayerCurrentTime();
        const html5Video = document.getElementById('direct-html5-player');
        if (sec > 0 || ytPlayerInstance || twitchPlayerInstance || html5Video) {
            liveTimeElem.textContent = formatSecondsToHHMMSS(sec);
        }
    }, 500);

    window.markCurrentTimestamp = function(targetType = 'start') {
        const html5Video = document.getElementById('direct-html5-player');
        const currentSec = getPlayerCurrentTime();
        if (currentSec <= 0 && activePlayerType === 'none' && !html5Video) {
            logToConsole('[Timestamp] Play or scrub the video in the embedded player above to capture exact timestamps.', 'system');
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

    // --- High-Resolution Frame Thumbnail Capture from Player ---
    let lastCapturedThumbData = null;
    let inFlightThumbCapture = null; // { key, promise } to prevent duplicate parallel frame requests

    window.captureThumbnailFromPlayer = async function(requestedTime = null) {
        let timeStr = requestedTime;
        if (!timeStr) {
            const inputVal = document.getElementById('thumb-timestamp')?.value.trim();
            const playerSec = getPlayerCurrentTime();
            if (playerSec > 0) {
                timeStr = formatSecondsToHHMMSS(playerSec);
            } else if (inputVal && inputVal !== '00:00:00' && inputVal !== '0') {
                timeStr = inputVal;
            } else {
                timeStr = '00:00:00';
            }
        }
        const isDefaultZero = !timeStr || timeStr === '00:00:00' || timeStr === '0';

        // Find active video URL (prioritizing the currently active tab)
        const activeUrl = getPreferredActiveUrl();

        if (!activeUrl) {
            logToConsole('[Thumbnail] Please enter or paste a video link first to capture a thumbnail.', 'error');
            return;
        }

        const chosenFormat = document.getElementById('thumb-format')?.value === 'png' ? 'png' : 'jpg';
        const dedupeKey = `${activeUrl}|${isDefaultZero ? '00:00:00' : timeStr}|${chosenFormat}`;
        if (inFlightThumbCapture && inFlightThumbCapture.key === dedupeKey) {
            return await inFlightThumbCapture.promise;
        }

        const titleVal = document.getElementById('thumb-title')?.value.trim() || document.getElementById('section-title')?.value.trim() || '';
        const thumbTimeInput = document.getElementById('thumb-timestamp');
        if (thumbTimeInput) thumbTimeInput.value = isDefaultZero ? '' : timeStr;
        updateActionBtnForTab();

        const btn = document.getElementById('btn-player-capture-thumb');
        const origHtml = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>${isDefaultZero ? 'Loading Cover...' : `Extracting ${timeStr}...`}</span>`;
        }

        const runCapture = async () => {

        const showCapturedPreview = (thumbUrl, filename, capturedTime, isFrame = true, meta = {}) => {
            const displayTime = capturedTime || timeStr || '00:00:00';
            const isCover = !isFrame || displayTime === '00:00:00';
            const outFormat = meta.ext || (document.getElementById('thumb-format')?.value === 'png' ? 'png' : 'jpg');
            lastCapturedThumbData = {
                success: true,
                thumbnailUrl: thumbUrl,
                downloadUrl: thumbUrl,
                isFrame: !isCover,
                source: meta.source || (isCover ? 'cover' : 'direct-stream'),
                qualityLabel: meta.qualityLabel || '',
                ext: outFormat,
                timestamp: displayTime,
                filename: filename || (isCover ? 'default_cover_1080p.jpg' : `thumbnail_${displayTime.replace(/:/g, '-')}.${outFormat}`)
            };

            const card = document.getElementById('captured-thumbnail-card');
            const img = document.getElementById('captured-thumb-img');
            const label = document.getElementById('captured-thumb-time-label');
            const overlay = document.getElementById('captured-thumb-timestamp-overlay');
            const bannerText = document.getElementById('captured-thumb-banner-text');

            const applyYtImgFallback = (imgEl) => {
                applyYouTubeCoverFallback(imgEl, extractYtId(activeUrl), (nextSrc) => {
                    if (lastCapturedThumbData && isCover) {
                        lastCapturedThumbData.thumbnailUrl = nextSrc;
                        lastCapturedThumbData.downloadUrl = nextSrc;
                    }
                });
            };

            if (img) {
                applyYtImgFallback(img);
                img.src = thumbUrl;
            }
            if (label) label.textContent = isCover ? `Default Cover (${meta.qualityLabel || 'HD'})` : `Frame at ${displayTime}`;
            if (overlay) overlay.textContent = isCover ? (meta.qualityLabel || 'HD Cover') : displayTime;
            if (bannerText) {
                if (isCover) {
                    bannerText.innerHTML = meta.errorNotice
                        ? `⚠️ ${escapeHtml(meta.errorNotice)}`
                        : `✨ <strong>Official Cover (${escapeHtml(meta.qualityLabel || '1080p Full HD')})</strong> loaded directly from video CDN in maximum quality.`;
                } else if (meta.source === 'direct-stream') {
                    bannerText.innerHTML = `✨ <strong>Direct Video Stream Frame (${escapeHtml(meta.qualityLabel || outFormat.toUpperCase())})</strong> extracted at <strong>${displayTime}</strong>.`;
                } else {
                    bannerText.innerHTML = `⚡ <strong>${escapeHtml(meta.qualityLabel || 'Timeline Storyboard Upscaled to 1080p')}</strong> extracted at <strong>${displayTime}</strong>.`;
                }
            }
            if (card) {
                card.classList.remove('hidden');
                card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }

            // Also populate the Thumbnail Grabber tab view
            const thumbInput = document.getElementById('thumb-url');
            if (thumbInput && !thumbInput.value.trim()) thumbInput.value = activeUrl;
            if (thumbTimeInput) thumbTimeInput.value = isCover ? '' : displayTime;
            updateActionBtnForTab();
            const thumbImg = document.getElementById('thumb-preview-img');
            if (thumbImg) {
                applyYtImgFallback(thumbImg);
                thumbImg.src = thumbUrl;
            }
            const thumbCap = document.getElementById('thumb-preview-caption');
            if (thumbCap) {
                thumbCap.textContent = isCover ? `Official Cover (${meta.qualityLabel || '1080p HD'})` : `Frame at ${displayTime} — ready to download`;
            }
            const thumbCard = document.getElementById('thumbnail-preview-card');
            if (thumbCard) thumbCard.classList.remove('hidden');
        };

        // If player is at 00:00:00 (default), resolve official high-resolution default cover via backend
        if (isDefaultZero) {
            logToConsole('[Thumbnail] Player at 00:00:00 (default) - Fetching highest-resolution official cover...', 'info');
            try {
                const res = await fetch('/api/fetch-thumbnail', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: activeUrl, timestamp: '', title: titleVal, format: chosenFormat })
                });
                const data = await res.json();
                if (data && data.success && data.thumbnailUrl) {
                    showCapturedPreview(data.thumbnailUrl, data.filename, '00:00:00', false, data);
                    logToConsole(`[Thumbnail Captured] Loaded official ${data.qualityLabel || 'HD'} cover!`, 'success');
                    return data;
                }
            } catch (e) {}
            const ytId = extractYtId(activeUrl);
            if (ytId) {
                const maxRes = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
                showCapturedPreview(maxRes, `${sanitizeFilename(titleVal) || ytId}_default_cover.jpg`, '00:00:00', false);
                return lastCapturedThumbData;
            }
        }

        logToConsole(`[Thumbnail] Extracting ${chosenFormat.toUpperCase()} frame snapshot at ${timeStr}...`, 'system');

        try {
            const res = await fetch('/api/fetch-thumbnail', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: activeUrl, timestamp: timeStr, title: titleVal, format: chosenFormat })
            });
            const data = await res.json();
            if (data && data.success && data.thumbnailUrl) {
                showCapturedPreview(data.thumbnailUrl, data.filename, data.timestamp || timeStr, data.isFrame !== false, data);
                if (data.isFrame) {
                    logToConsole(`[Thumbnail Captured] Extracted ${data.qualityLabel || 'HD'} frame at ${timeStr}! Ready to download.`, 'success');
                } else {
                    logToConsole(`[Thumbnail Notice] ${data.errorNotice || 'Loaded official high-resolution cover!'}`, 'system');
                    if (data.botBlocked) updateCookieStatus();
                }
                return data;
            } else {
                throw new Error(data?.error || 'Could not extract frame at timestamp');
            }
        } catch (err) {
            logToConsole(`[Thumbnail Notice] Frame extraction fallback: ${err.message}`, 'warning');
            const ytId = extractYtId(activeUrl);
            if (ytId) {
                const maxRes = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
                showCapturedPreview(maxRes, `${ytId}_cover.jpg`, '00:00:00', false);
                logToConsole(`[Thumbnail Captured] Loaded default video cover for ${ytId}.`, 'success');
            }
            return lastCapturedThumbData;
        }
        }; // end runCapture

        const capturePromise = runCapture();
        inFlightThumbCapture = { key: dedupeKey, promise: capturePromise };
        try {
            return await capturePromise;
        } finally {
            if (inFlightThumbCapture && inFlightThumbCapture.promise === capturePromise) {
                inFlightThumbCapture = null;
            }
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origHtml;
            }
        }
    };

    window.closeCapturedThumb = function() {
        const card = document.getElementById('captured-thumbnail-card');
        if (card) card.classList.add('hidden');
    };

    function dataUrlToBlob(dataUrl) {
        if (!dataUrl || !dataUrl.startsWith('data:')) return null;
        const commaIdx = dataUrl.indexOf(',');
        if (commaIdx === -1) return null;
        const header = dataUrl.slice(5, commaIdx);
        const mime = header.split(';')[0] || 'application/octet-stream';
        const binStr = atob(dataUrl.slice(commaIdx + 1));
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }

    function showDownloadReadyBar(href, filename) {
        const bar = document.getElementById('download-ready-bar');
        const link = document.getElementById('download-ready-link');
        const nameEl = document.getElementById('download-ready-name');
        if (!bar || !link || !href) return;
        link.href = href;
        if (filename) link.download = filename;
        if (nameEl) nameEl.textContent = filename ? `Ready: ${filename}` : 'Ready to save';
        bar.classList.remove('hidden');
    }

    window.downloadCapturedThumbnail = async function() {
        if (!lastCapturedThumbData) return;
        const filename = lastCapturedThumbData.filename || `thumbnail_${(lastCapturedThumbData.timestamp || 'frame').replace(/:/g, '-')}.jpg`;
        const downloadUrl = lastCapturedThumbData.downloadUrl || lastCapturedThumbData.thumbnailUrl;
        if (!downloadUrl) return;

        try {
            // Convert data: URLs synchronously so iOS Safari preserves tap gesture context
            const syncBlob = dataUrlToBlob(downloadUrl);
            const blob = syncBlob || await (await fetch(downloadUrl)).blob();
            const url = URL.createObjectURL(blob);
            triggerFileDownload(url, filename, { revokeMs: 60000, showReadyBar: true });
            logToConsole(`[Thumbnail Downloaded] Saved "${filename}" to your device (or tap "Save File" above on iPhone/Safari)!`, 'success');
        } catch (e) {
            window.open(downloadUrl, '_blank');
        }
    };

    window.copyCapturedThumbToClipboard = async function() {
        const thumbUrl = lastCapturedThumbData?.thumbnailUrl || lastCapturedThumbData?.downloadUrl;
        if (!thumbUrl) return;
        try {
            const res = await fetch(thumbUrl);
            const blob = await res.blob();
            await navigator.clipboard.write([
                new ClipboardItem({ [blob.type]: blob })
            ]);
            logToConsole('[Clipboard] Thumbnail copied directly to your clipboard!', 'success');
        } catch (e) {
            logToConsole('[Clipboard] Right-click the image or click Download JPG to save.', 'system');
        }
    };

    window.syncThumbnailTimeFromPlayer = function() {
        const sec = getPlayerCurrentTime();
        const timeStr = formatSecondsToHHMMSS(sec);
        const thumbTime = document.getElementById('thumb-timestamp');
        if (sec <= 0 || timeStr === '00:00:00') {
            if (thumbTime) {
                thumbTime.value = '';
                thumbTime.dispatchEvent(new Event('input'));
            }
            if (typeof window.resetThumbnailToDefaultCover === 'function') {
                window.resetThumbnailToDefaultCover();
            }
            logToConsole('[Thumbnail] Player is at 00:00:00 (default) - Loaded official 1080p Full HD default cover.', 'success');
            return;
        }
        if (thumbTime) {
            thumbTime.value = timeStr;
            thumbTime.dispatchEvent(new Event('input'));
            updateActionBtnForTab();
            updateGeneratedCommand();
            logToConsole(`[Thumbnail] Set timestamp to ${timeStr} (${Math.floor(sec)}s) — click "Download Frame (${timeStr})" below to save.`, 'info');
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
        if (!url) return null;
        const pathMatch = url.match(/(?:youtube\.com\/(?:shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&#\/]|$)/i);
        if (pathMatch && pathMatch[1]) return pathMatch[1];
        const queryMatch = url.match(/[?&]v=([A-Za-z0-9_-]{11})(?:[&#]|$)/i);
        return (queryMatch && queryMatch[1]) ? queryMatch[1] : null;
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

        // 0. Validate URL & timestamp ranges BEFORE opening Save As picker
        if (activeTabId === 'tab-quick-download') {
            const qUrl = document.getElementById('quick-url')?.value.trim();
            if (!qUrl) {
                logToConsole('[Error] Please enter or paste a Media Link URL first.', 'error');
                return;
            }
        } else if (activeTabId === 'tab-section-clipper') {
            const sUrl = document.getElementById('section-url')?.value.trim();
            if (!sUrl) {
                logToConsole('[Error] Please pick a VOD or enter a Video Link URL first.', 'error');
                return;
            }
            const startSec = parseTimestampToSeconds(document.getElementById('section-start')?.value);
            const endSec = parseTimestampToSeconds(document.getElementById('section-end')?.value);
            if (endSec <= startSec) {
                updateSectionDurationDisplay();
                logToConsole('[Error] Invalid time range: End Time must be greater than Start Time.', 'error');
                return;
            }
        }

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
                if (fmtVal === 'audio_mp3' || fmtVal.includes('bestaudio') || fmtVal.includes('mp3')) ext = 'mp3';
                else if (fmtVal === 'audio_m4a' || fmtVal.includes('m4a')) ext = 'm4a';
            } else if (activeTabId === 'tab-section-clipper') {
                const presetVal = document.getElementById('section-format-preset')?.value || '';
                if (presetVal === 'mp3') ext = 'mp3';
            } else if (activeTabId === 'tab-file-converter') {
                const presetVal = document.getElementById('convert-preset')?.value || '';
                if (presetVal === 'audio') ext = 'mp3';
            }

            let suggestedName = suggestedTitle ? sanitizeFilename(suggestedTitle) : 'Video_Clip';
            if (activeTabId === 'tab-section-clipper') {
                const sVal = (document.getElementById('section-start')?.value.trim() || '00:00:00').replace(/[:.]/g, '-');
                const eVal = (document.getElementById('section-end')?.value.trim() || '00:01:00').replace(/[:.]/g, '-');
                const cropVal = document.getElementById('section-crop-mode')?.value || 'original';
                const cropTag = (ext === 'mp4' && (cropVal === 'vertical_crop' || cropVal === 'vertical_blur')) ? '_9x16' : '';
                suggestedName += `_${sVal}_to_${eVal}${cropTag}`;
            }
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

        let fileExists = false;
        let existingFileName = '';
        if (activeTabId === 'tab-file-converter') {
            const targetPath = getTargetOutputFileForCheck();
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
        }

        const cmd = buildCommandForActiveTab();

        const runExecutionLogic = async () => {
            logToConsole(`[Execute] Triggered execution for active tool tab [${activeTabId}]`, 'system');
            logToConsole(`$ ${cmd}`, 'info');

            isTaskRunning = true;
            actionBtn.disabled = true;
            actionBtn.style.opacity = '0.7';

            if (activeTabId === 'tab-yt-thumbnail') {
                const url = document.getElementById('thumb-url')?.value.trim();

                if (!url) {
                    logToConsole('[Error] Please enter a valid YouTube, Twitch, or Kick URL.', 'error');
                    resetExecutionState();
                    return;
                }

                await downloadThumbnailImage();
                resetExecutionState();
                return;
            }

            if (activeTabId === 'tab-yt-tags') {
                const tagsUrl = document.getElementById('tags-url')?.value.trim();
                const mode = document.querySelector('input[name="analysis-mode"]:checked')?.value || 'tags';
                const resultsCard = document.getElementById('extracted-results-card');
                const resultsTitle = document.getElementById('results-card-title');
                const resultsIcon = document.getElementById('results-card-icon');
                const textBox = document.getElementById('results-text-box');

                if (!tagsUrl) {
                    logToConsole('[Error] Please enter a valid YouTube video URL first.', 'error');
                    resetExecutionState();
                    return;
                }

                if (mode === 'tags') {
                    logToConsole('[Metadata] Extracting video tags, stats & description...', 'system');
                    try {
                        const res = await fetch('/api/fetch-metadata', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: tagsUrl })
                        });
                        const data = await res.json();
                        if (data.success && data.metadata) {
                            renderExtractedMetadataResult(data);
                            const vCount = data.metadata.video_tags?.length || 0;
                            const cCount = data.metadata.channel_tags?.length || 0;
                            logToConsole(`[Success] Extracted ${vCount} video tags & ${cCount} channel categories!`, 'success');
                        } else {
                            logToConsole(`[Error] ${data?.error || 'Could not fetch video metadata tags.'}`, 'error');
                        }
                    } catch (e) {
                        logToConsole('[Error] Failed to connect to metadata service.', 'error');
                    }
                } else if (mode === 'transcript') {
                    const startVal = (document.getElementById('transcript-start')?.value || '').trim();
                    const endVal = (document.getElementById('transcript-end')?.value || '').trim();
                    const isFull = endVal.toLowerCase() === 'full';
                    const hasRange = Boolean(!isFull && (startVal || endVal));
                    const detectSpeakers = document.getElementById('transcript-detect-speakers')?.checked !== false;
                    const langVal = document.getElementById('transcript-lang')?.value || 'en';
                    const plat = detectTranscriptPlatform(tagsUrl);
                    const engineToUse = (selectedTranscriptEngine === 'captions' && (!plat || plat.isYouTube)) ? 'captions' : 'whisper';
                    const contextTitle = document.getElementById('thumb-title')?.value.trim() || document.getElementById('section-title')?.value.trim() || '';
                    const rangeMsg = isFull ? ' (Full Stream)' : (hasRange ? ` (${startVal || '00:00:00'} - ${endVal})` : ` (${engineToUse === 'captions' ? 'Fast YT Captions' : 'Whisper AI · Auto'})`);

                    logToConsole(`[AI Transcript] Extracting ${plat ? plat.label + ' ' : ''}transcript${rangeMsg}${detectSpeakers ? ' + Speaker Colors' : ''}...`, 'system');
                    showProgressBar(engineToUse === 'captions' ? 'Fetching YouTube captions...' : 'Connecting & preparing speech audio...');
                    updateProgressBar(5, engineToUse === 'captions' ? 'Instant Subs' : 'Connecting...', 'Starting');

                    try {
                        const response = await fetch('/api/fetch-transcript', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                url: tagsUrl,
                                start: isFull ? '' : startVal,
                                end: isFull ? '' : endVal,
                                full: isFull,
                                engine: engineToUse,
                                detectSpeakers,
                                language: langVal,
                                title: contextTitle
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
                                                const metaPills = document.getElementById('results-meta-pills');
                                                const bodyHeaderTitle = document.getElementById('results-body-header-title');
                                                const noticeBanner = document.getElementById('results-notice-banner');
                                                const isYtSubs = data.source === 'youtube-autosub';
                                                const spkCount = Number(data.speakerCount || (Array.isArray(data.speakers) ? data.speakers.length : 0));

                                                if (videoBlock) videoBlock.style.display = 'none';
                                                if (channelBlock) channelBlock.style.display = 'none';
                                                if (metaPills) {
                                                    const pills = [];
                                                    if (plat) {
                                                        pills.push(`<span class="meta-stat-pill"><i class="${plat.icon}"></i> ${escapeHtml(plat.label)}</span>`);
                                                    }
                                                    pills.push(`<span class="meta-stat-pill"><i class="fa-solid ${isYtSubs ? 'fa-closed-captioning' : 'fa-brain'}"></i> ${isYtSubs ? 'YouTube Timed Captions' : `Whisper AI${data.model ? ` (${escapeHtml(data.model)})` : ''}`}</span>`);
                                                    if (spkCount > 0) {
                                                        pills.push(`<span class="meta-stat-pill speaker-stat-pill"><i class="fa-solid fa-users"></i> ${spkCount} Speaker${spkCount === 1 ? '' : 's'} Detected</span>`);
                                                    }
                                                    if (data.language) {
                                                        pills.push(`<span class="meta-stat-pill"><i class="fa-solid fa-language"></i> ${escapeHtml(String(data.language).toUpperCase())}</span>`);
                                                    }
                                                    metaPills.innerHTML = pills.join('');
                                                    metaPills.classList.remove('hidden');
                                                }
                                                if (bodyHeaderTitle) bodyHeaderTitle.innerHTML = `<i class="fa-solid ${isYtSubs ? 'fa-closed-captioning' : 'fa-brain'}"></i> ${isYtSubs ? 'Interactive Timestamped Captions' : 'AI Speaker-Colored Transcript'}`;

                                                if (resultsTitle) resultsTitle.textContent = isYtSubs ? 'YouTube Captions & Interactive Transcript' : 'AI Speech Transcript (Whisper AI)';
                                                if (resultsIcon) resultsIcon.className = `fa-solid ${isYtSubs ? 'fa-closed-captioning' : 'fa-brain'} results-icon`;

                                                if (noticeBanner) {
                                                    if (data.notice) {
                                                        const rerunBtn = isYtSubs
                                                            ? ` <button type="button" class="btn-rerun-whisper" onclick="rerunTranscriptWithWhisper()"><i class="fa-solid fa-microphone-lines"></i> Run Whisper AI Voices</button>`
                                                            : '';
                                                        noticeBanner.innerHTML = `<i class="fa-solid fa-bolt"></i> <span>${escapeHtml(data.notice)}</span>${rerunBtn}`;
                                                        noticeBanner.classList.remove('hidden');
                                                    } else {
                                                        noticeBanner.classList.add('hidden');
                                                    }
                                                }

                                                if (textBox) {
                                                    renderInteractiveTranscript(data.transcript, {
                                                        segments: data.segments,
                                                        speakers: data.speakers,
                                                        speakerCount: spkCount,
                                                        showSpeakerColors: detectSpeakers
                                                    });
                                                }
                                                if (resultsCard) resultsCard.classList.remove('hidden');

                                                const turnCount = Array.isArray(data.segments) && data.segments.length ? data.segments.length : data.transcript.split(/\r?\n/).length;
                                                logToConsole(`[Success] ${isYtSubs ? 'YouTube captions' : 'Whisper AI transcript'} loaded (${turnCount} lines${spkCount > 1 ? `, ${spkCount} speakers color-coded` : ''})!`, 'success');
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
                const cropMode = activeTabId === 'tab-section-clipper' && (document.getElementById('section-format-preset')?.value !== 'mp3')
                    ? (document.getElementById('section-crop-mode')?.value || 'original')
                    : 'original';
                const response = await fetch('/api/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: cmd, tabId: activeTabId, cropMode })
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
                                    if (isSuccess && data.downloadToken && data.fileName) {
                                        const fname = data.fileName;
                                        logToConsole(`[Download Ready] Streaming "${fname}" to your device...`, 'success');
                                        try {
                                            const dlUrl = `/api/download-file?token=${data.downloadToken}`;
                                            if (activeFileHandle) {
                                                const dlRes = await fetch(dlUrl);
                                                if (!dlRes.ok) {
                                                    const errText = await dlRes.text().catch(() => '');
                                                    throw new Error(`Server responded ${dlRes.status}: ${errText}`);
                                                }
                                                logToConsole(`[Saved] Streaming directly to selected file: "${activeFileHandle.name}"...`, 'success');
                                                const writable = await activeFileHandle.createWritable();
                                                if (dlRes.body && typeof dlRes.body.pipeTo === 'function') {
                                                    await dlRes.body.pipeTo(writable);
                                                } else {
                                                    const blob = await dlRes.blob();
                                                    await writable.write(blob);
                                                    await writable.close();
                                                }
                                                logToConsole(`[Saved] Successfully saved file to: "${activeFileHandle.name}"!`, 'success');
                                                activeFileHandle = null;
                                            } else {
                                                triggerFileDownload(dlUrl, fname, { showReadyBar: true });
                                                logToConsole(`[Saved] Download started for "${fname}" (tap "Save File" above if iOS Safari waits for confirmation).`, 'success');
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
                } else if (!isServerConnected) {
                    runSimulatedExecution(cmd);
                } else {
                    finishProgressBar(false);
                    logToConsole(`[Error] Server returned HTTP ${response.status} while executing command.`, 'error');
                }
            } catch (err) {
                if (!isServerConnected) {
                    runSimulatedExecution(cmd);
                } else {
                    finishProgressBar(false);
                    logToConsole(`[Error] Connection to server interrupted: ${err.message}`, 'error');
                }
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

    let rawTranscriptData = '';
    let lastResultsTitle = 'video';
    let lastResultsMode = 'metadata';

    function formatCompactViews(num) {
        const n = Number(num);
        if (!Number.isFinite(n) || n <= 0) return '';
        if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B views`;
        if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
        if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K views`;
        return `${n.toLocaleString()} views`;
    }

    function renderMetadataTagPills(container, tags, emptyMsg) {
        if (!container) return;
        container.innerHTML = '';
        if (Array.isArray(tags) && tags.length > 0) {
            tags.forEach(tag => {
                const pill = document.createElement('span');
                pill.className = 'tag-pill';
                pill.textContent = `#${tag}`;
                pill.onclick = () => {
                    if (navigator.clipboard) navigator.clipboard.writeText(tag);
                    logToConsole(`[Clipboard] Copied tag: #${tag}`, 'info');
                };
                container.appendChild(pill);
            });
        } else {
            container.innerHTML = `<span class="text-muted" style="color:var(--text-muted);font-size:0.85rem;">${escapeHtml(emptyMsg)}</span>`;
        }
    }

    function renderExtractedMetadataResult(data) {
        const meta = data?.metadata || {};
        const { video_tags = [], channel_tags = [], description = '', channel = '', title = '', view_count = null, duration_string = '' } = meta;
        const resultsCard = document.getElementById('extracted-results-card') || extractedMetaCard;
        const resultsTitle = document.getElementById('results-card-title');
        const resultsIcon = document.getElementById('results-card-icon');
        const metaPills = document.getElementById('results-meta-pills');
        const videoBlock = document.getElementById('results-video-tags-block');
        const channelBlock = document.getElementById('results-channel-tags-block');
        const videoTagsCloud = document.getElementById('results-video-tags-cloud') || tagsCloudContainer;
        const channelTagsCloud = document.getElementById('results-channel-tags-cloud');
        const bodyHeaderTitle = document.getElementById('results-body-header-title');
        const noticeBanner = document.getElementById('results-notice-banner');
        const searchRow = document.getElementById('transcript-search-row');
        const speakersBar = document.getElementById('transcript-speakers-bar');
        const textBox = document.getElementById('results-text-box') || descriptionBoxContainer;

        lastResultsMode = 'metadata';
        lastResultsTitle = title || 'video';
        rawTranscriptData = description || '';

        if (resultsTitle) resultsTitle.textContent = title || 'Extracted Video Tags & Metadata';
        if (resultsIcon) resultsIcon.className = 'fa-solid fa-tags results-icon';
        if (videoBlock) videoBlock.style.display = 'flex';
        if (channelBlock) channelBlock.style.display = 'flex';
        if (searchRow) searchRow.classList.add('hidden');
        if (speakersBar) speakersBar.classList.add('hidden');
        if (noticeBanner) noticeBanner.classList.add('hidden');
        if (bodyHeaderTitle) bodyHeaderTitle.innerHTML = '<i class="fa-solid fa-align-left"></i> Video Description';

        if (metaPills) {
            const pills = [];
            if (channel) pills.push(`<span class="meta-stat-pill"><i class="fa-solid fa-tv"></i> ${escapeHtml(channel)}</span>`);
            if (duration_string) pills.push(`<span class="meta-stat-pill"><i class="fa-regular fa-clock"></i> ${escapeHtml(duration_string)}</span>`);
            const vStr = formatCompactViews(view_count);
            if (vStr) pills.push(`<span class="meta-stat-pill"><i class="fa-regular fa-eye"></i> ${escapeHtml(vStr)}</span>`);
            pills.push(`<span class="meta-stat-pill"><i class="fa-solid fa-hashtag"></i> ${video_tags.length} tags</span>`);
            if (data.fallback) pills.push(`<span class="meta-stat-pill warn"><i class="fa-solid fa-triangle-exclamation"></i> Basic fallback (full tags timed out)</span>`);
            metaPills.innerHTML = pills.join('');
            metaPills.classList.toggle('hidden', pills.length === 0);
        }

        renderMetadataTagPills(videoTagsCloud, video_tags, data.fallback ? 'Tags unavailable in oEmbed fallback' : 'No public tags set on this video');
        renderMetadataTagPills(channelTagsCloud, channel_tags.length > 0 ? channel_tags : (channel ? [channel] : []), 'No channel categories');

        if (textBox) {
            textBox.classList.remove('transcript-interactive-container');
            textBox.textContent = description || 'No description provided.';
        }
        if (resultsCard) resultsCard.classList.remove('hidden');
    }

    function renderTagCloud(tagsArr, descText) {
        renderExtractedMetadataResult({
            success: true,
            metadata: { title: 'Sample Video Metadata', video_tags: tagsArr || [], channel_tags: ['Demo'], channel: 'Demo Channel', description: descText || '' }
        });
    }

    let activeSpeakerFilter = 'all';
    let transcriptSegmentsState = [];
    let transcriptSpeakersState = [];
    let customSpeakerNames = {};

    function getSpeakerDisplayName(spkId, fallbackLabel = '') {
        return customSpeakerNames[spkId] || fallbackLabel || `Speaker ${spkId}`;
    }

    function rebuildRawTranscriptFromState() {
        if (!transcriptSegmentsState.length) return;
        rawTranscriptData = transcriptSegmentsState.map(seg => {
            const timePart = seg.end ? `[${seg.start} - ${seg.end}]` : `[${seg.start}]`;
            if (seg.speaker) {
                const name = getSpeakerDisplayName(seg.speaker, seg.speakerLabel);
                return `${timePart} [${name}] ${seg.text}`;
            }
            return `${timePart} ${seg.text}`;
        }).join('\n');
    }

    function filterInteractiveTranscriptRows(query) {
        const textBox = document.getElementById('results-text-box') || descriptionBoxContainer;
        const countEl = document.getElementById('transcript-search-count');
        if (!textBox) return;
        const q = String(query || '').trim().toLowerCase();
        const rows = textBox.querySelectorAll('.transcript-interactive-row, .transcript-plain-line');
        let shown = 0;
        rows.forEach(r => {
            const spkMatch = activeSpeakerFilter === 'all' || r.dataset.speaker === String(activeSpeakerFilter);
            const textMatch = !q || r.textContent.toLowerCase().includes(q);
            const match = spkMatch && textMatch;
            r.style.display = match ? '' : 'none';
            if (match) shown++;
        });
        if (countEl) {
            const isFiltered = Boolean(q || activeSpeakerFilter !== 'all');
            countEl.textContent = isFiltered ? `${shown} / ${rows.length} shown` : `${rows.length} lines`;
        }
    }

    function renderTranscriptSpeakersBar(speakers, totalLines) {
        const bar = document.getElementById('transcript-speakers-bar');
        if (!bar) return;

        if (!Array.isArray(speakers) || speakers.length === 0) {
            bar.classList.add('hidden');
            bar.innerHTML = '';
            return;
        }

        bar.innerHTML = '';

        const allBtn = document.createElement('button');
        allBtn.type = 'button';
        allBtn.className = `speaker-filter-pill speaker-all-pill${activeSpeakerFilter === 'all' ? ' active' : ''}`;
        allBtn.innerHTML = `<span>All</span><span class="speaker-share">${totalLines}</span>`;
        allBtn.onclick = () => {
            activeSpeakerFilter = 'all';
            renderTranscriptSpeakersBar(transcriptSpeakersState, transcriptSegmentsState.length);
            filterInteractiveTranscriptRows(document.getElementById('transcript-search-input')?.value || '');
        };
        bar.appendChild(allBtn);

        speakers.forEach(spk => {
            const spkId = Number(spk.id) || 1;
            const colorIdx = ((spkId - 1) % 6) + 1;
            const displayName = getSpeakerDisplayName(spkId, spk.label);

            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = `speaker-filter-pill speaker-color-${colorIdx}${String(activeSpeakerFilter) === String(spkId) ? ' active' : ''}`;
            pill.title = `Click to filter by ${displayName} · Double-click or click pencil to rename`;

            const dot = document.createElement('span');
            dot.className = 'speaker-dot';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'speaker-pill-name';
            nameSpan.textContent = displayName;

            const shareSpan = document.createElement('span');
            shareSpan.className = 'speaker-share';
            shareSpan.textContent = typeof spk.share === 'number' ? `${spk.share}%` : `${spk.count || ''}`;

            const renameBtn = document.createElement('span');
            renameBtn.className = 'speaker-rename-btn';
            renameBtn.title = `Rename ${displayName}`;
            renameBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';

            const handleRename = (ev) => {
                if (ev) ev.stopPropagation();
                const current = getSpeakerDisplayName(spkId, spk.label);
                const nextName = window.prompt(`Rename ${current} (updates transcript, copy & .txt export):`, current);
                if (nextName && nextName.trim()) {
                    const cleaned = nextName.trim().slice(0, 32);
                    customSpeakerNames[spkId] = cleaned;
                    document.querySelectorAll(`[data-speaker-badge="${spkId}"] .speaker-name-text`).forEach(el => {
                        el.textContent = cleaned;
                    });
                    rebuildRawTranscriptFromState();
                    renderTranscriptSpeakersBar(transcriptSpeakersState, transcriptSegmentsState.length);
                    logToConsole(`[Speakers] Renamed Speaker ${spkId} → "${cleaned}"`, 'info');
                }
            };

            renameBtn.onclick = handleRename;
            pill.ondblclick = handleRename;
            pill.onclick = () => {
                activeSpeakerFilter = (String(activeSpeakerFilter) === String(spkId)) ? 'all' : String(spkId);
                renderTranscriptSpeakersBar(transcriptSpeakersState, transcriptSegmentsState.length);
                filterInteractiveTranscriptRows(document.getElementById('transcript-search-input')?.value || '');
            };

            pill.appendChild(dot);
            pill.appendChild(nameSpan);
            pill.appendChild(shareSpan);
            pill.appendChild(renameBtn);
            bar.appendChild(pill);
        });

        bar.classList.remove('hidden');
    }

    function renderInteractiveTranscript(rawText, opts = {}) {
        const textBox = document.getElementById('results-text-box') || descriptionBoxContainer;
        if (!textBox) return;

        lastResultsMode = 'transcript';
        const tagsTitle = document.getElementById('results-card-title')?.textContent || 'transcript';
        lastResultsTitle = document.getElementById('thumb-title')?.value.trim() || document.getElementById('section-title')?.value.trim() || tagsTitle;
        rawTranscriptData = rawText || '';
        activeSpeakerFilter = 'all';
        customSpeakerNames = {};
        textBox.innerHTML = '';
        textBox.classList.add('transcript-interactive-container');

        const showSpeakerColors = opts.showSpeakerColors !== false;
        let parsedSegments = [];

        if (Array.isArray(opts.segments) && opts.segments.length > 0) {
            parsedSegments = opts.segments.map(s => ({
                start: s.start || '00:00',
                end: s.end || '',
                startSec: typeof s.startSec === 'number' ? s.startSec : parseTimestampToSeconds(s.start || '00:00'),
                speaker: showSpeakerColors ? (Number(s.speaker) || 1) : 0,
                speakerLabel: s.speakerLabel || `Speaker ${Number(s.speaker) || 1}`,
                text: s.text || ''
            }));
        } else {
            const lines = (rawText || '').split(/[\r\n]+/);
            const speakerLabelToId = new Map();
            let nextSpkId = 1;
            lines.forEach(line => {
                const trimmed = line.trim();
                if (!trimmed) return;
                const match = trimmed.match(/^\[([0-9:]+)(?:\s*-\s*([0-9:]+))?\]\s*(?:\[([^\]]+)\]\s*)?(.*)$/);
                if (match) {
                    const startStr = match[1];
                    const endStr = match[2] || '';
                    const spkRaw = (match[3] || '').trim();
                    const text = match[4] || '';
                    let spkId = 0;
                    let spkLabel = '';
                    if (showSpeakerColors && spkRaw) {
                        const numMatch = spkRaw.match(/^Speaker\s+(\d+)$/i);
                        if (numMatch) {
                            spkId = parseInt(numMatch[1], 10) || 1;
                            spkLabel = `Speaker ${spkId}`;
                        } else {
                            const key = spkRaw.toLowerCase();
                            if (!speakerLabelToId.has(key)) speakerLabelToId.set(key, nextSpkId++);
                            spkId = speakerLabelToId.get(key);
                            spkLabel = spkRaw;
                        }
                    }
                    parsedSegments.push({
                        start: startStr,
                        end: endStr,
                        startSec: parseTimestampToSeconds(startStr),
                        speaker: spkId,
                        speakerLabel: spkLabel,
                        text
                    });
                } else {
                    parsedSegments.push({ plain: trimmed });
                }
            });
        }

        // Build speaker stats if not already provided
        let speakersList = Array.isArray(opts.speakers) ? opts.speakers : [];
        if (showSpeakerColors && speakersList.length === 0) {
            const counts = new Map();
            parsedSegments.forEach(s => {
                if (s.speaker) {
                    if (!counts.has(s.speaker)) counts.set(s.speaker, { id: s.speaker, label: s.speakerLabel || `Speaker ${s.speaker}`, count: 0 });
                    counts.get(s.speaker).count += 1;
                }
            });
            const totalSpkLines = Array.from(counts.values()).reduce((acc, v) => acc + v.count, 0) || 1;
            speakersList = Array.from(counts.values())
                .sort((a, b) => a.id - b.id)
                .map(v => ({ ...v, share: Math.round((v.count / totalSpkLines) * 100) }));
        }

        transcriptSegmentsState = parsedSegments.filter(s => !s.plain);
        transcriptSpeakersState = showSpeakerColors ? speakersList : [];

        let hasTimestamps = false;
        const fragment = document.createDocumentFragment();

        parsedSegments.forEach(item => {
            if (item.plain) {
                const plainRow = document.createElement('div');
                plainRow.className = 'transcript-plain-line';
                plainRow.textContent = item.plain;
                fragment.appendChild(plainRow);
                return;
            }

            hasTimestamps = true;
            const spkId = showSpeakerColors ? (Number(item.speaker) || 0) : 0;
            const colorIdx = spkId > 0 ? (((spkId - 1) % 6) + 1) : 0;

            const row = document.createElement('div');
            row.className = colorIdx > 0 ? `transcript-interactive-row speaker-${colorIdx}` : 'transcript-interactive-row';
            if (spkId > 0) row.dataset.speaker = String(spkId);

            const timeBtn = document.createElement('button');
            timeBtn.type = 'button';
            timeBtn.className = 'transcript-time-chip';
            timeBtn.title = `Jump player to ${item.start}`;
            timeBtn.innerHTML = `<i class="fa-solid fa-play"></i> <span>${escapeHtml(item.start)}${item.end ? ' - ' + escapeHtml(item.end) : ''}</span>`;
            timeBtn.onclick = () => jumpToPlayerTimestamp(item.startSec, item.start, row);
            row.appendChild(timeBtn);

            if (spkId > 0) {
                const spkBadge = document.createElement('span');
                spkBadge.className = `transcript-speaker-badge speaker-badge-${colorIdx}`;
                spkBadge.setAttribute('data-speaker-badge', String(spkId));
                spkBadge.innerHTML = `<span class="speaker-dot"></span><span class="speaker-name-text">${escapeHtml(getSpeakerDisplayName(spkId, item.speakerLabel))}</span>`;
                row.appendChild(spkBadge);
            }

            const textSpan = document.createElement('span');
            textSpan.className = 'transcript-text-content';
            textSpan.textContent = item.text;
            row.appendChild(textSpan);

            fragment.appendChild(row);
        });

        textBox.appendChild(fragment);
        if (!hasTimestamps) {
            textBox.classList.remove('transcript-interactive-container');
        }

        renderTranscriptSpeakersBar(transcriptSpeakersState, transcriptSegmentsState.length);

        const searchRow = document.getElementById('transcript-search-row');
        const searchInput = document.getElementById('transcript-search-input');
        if (searchRow && searchInput) {
            searchRow.classList.remove('hidden');
            searchInput.value = '';
            searchInput.oninput = () => filterInteractiveTranscriptRows(searchInput.value);
            filterInteractiveTranscriptRows('');
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
            logToConsole(`[Clipboard] Copied ${lastResultsMode === 'transcript' ? 'Transcript' : 'Description'} to clipboard!`, 'success');
        } else if (category === 'all') {
            if (lastResultsMode === 'transcript') {
                textToCopy = rawTranscriptData || document.getElementById('results-text-box')?.innerText || '';
                logToConsole('[Clipboard] Copied Full Transcript to clipboard!', 'success');
            } else {
                const vTags = Array.from(document.querySelectorAll('#results-video-tags-cloud .tag-pill')).map(p => p.textContent).join(', ');
                const cTags = Array.from(document.querySelectorAll('#results-channel-tags-cloud .tag-pill')).map(p => p.textContent).join(', ');
                const desc = rawTranscriptData || document.getElementById('results-text-box')?.innerText || '';
                textToCopy = `TITLE: ${lastResultsTitle}\n\nVIDEO TAGS:\n${vTags || 'None'}\n\nCHANNEL TAGS:\n${cTags || 'None'}\n\nDESCRIPTION:\n${desc}`;
                logToConsole('[Clipboard] Copied All Metadata to clipboard!', 'success');
            }
        }

        if (textToCopy && navigator.clipboard) {
            navigator.clipboard.writeText(textToCopy).catch(() => {});
        }
    };

    window.downloadExtractedMetaFile = function() {
        const descOrSub = rawTranscriptData || document.getElementById('results-text-box')?.innerText || '';
        const vTags = Array.from(document.querySelectorAll('#results-video-tags-cloud .tag-pill')).map(p => p.textContent).join(', ');
        const cTags = Array.from(document.querySelectorAll('#results-channel-tags-cloud .tag-pill')).map(p => p.textContent).join(', ');

        if (!vTags && !cTags && !descOrSub) {
            logToConsole('[Warning] Nothing extracted to download yet.', 'system');
            return;
        }

        const safeName = sanitizeFilename(lastResultsTitle || 'video') || 'video';
        let content = '';
        let filename = '';
        if (lastResultsMode === 'transcript') {
            content = descOrSub;
            filename = `${safeName}_transcript.txt`;
        } else {
            content = `=== TITLE ===\n${lastResultsTitle}\n\n=== VIDEO TAGS ===\n${vTags || 'None'}\n\n=== CHANNEL TAGS ===\n${cTags || 'None'}\n\n=== VIDEO DESCRIPTION ===\n${descOrSub}`;
            filename = `${safeName}_metadata_tags.txt`;
        }

        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        triggerFileDownload(url, filename, { revokeMs: 60000, showReadyBar: true });
        logToConsole(`[Downloaded] Saved "${filename}"!`, 'success');
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
        const chosenFormat = document.getElementById('thumb-format')?.value === 'png' ? 'png' : 'jpg';
        const timeVal = document.getElementById('thumb-timestamp')?.value.trim() || '';
        const isDefaultZero = !timeVal || timeVal === '0' || timeVal === '00:00:00' || timeVal === '0:00' || timeVal === '00:00';

        // 1. If timestamp box is blank or 00:00:00, download the official 1080p cover directly
        if (isDefaultZero) {
            return downloadDefaultCoverThumbnail();
        }

        // 2. If we ALREADY have a captured frame in memory for this EXACT requested timestamp + format, download it immediately
        if (lastCapturedThumbData && lastCapturedThumbData.thumbnailUrl && lastCapturedThumbData.isFrame && lastCapturedThumbData.timestamp === timeVal && (!lastCapturedThumbData.ext || lastCapturedThumbData.ext === chosenFormat)) {
            return downloadCapturedThumbnail();
        }

        // 3. Otherwise, extract frame (updating preview) and download if a real frame succeeded
        if (!inFlightThumbCapture) {
            logToConsole(`[Thumbnail] Capturing exact frame at ${timeVal} (${chosenFormat.toUpperCase()})...`, 'system');
        }
        await captureThumbnailFromPlayer(timeVal);
        if (lastCapturedThumbData && lastCapturedThumbData.thumbnailUrl && lastCapturedThumbData.isFrame) {
            return downloadCapturedThumbnail();
        }
        logToConsole('[Thumbnail Warning] Custom timestamp frame was blocked on YouTube cloud IP — click "Cookies" (top right) to add fresh cookies, or clear timestamp to download the Default Cover (1080p HD).', 'warning');
    };

    window.downloadDefaultCoverThumbnail = async function() {
        const url = document.getElementById('thumb-url')?.value.trim() || getPreferredActiveUrl();

        const titleVal = document.getElementById('thumb-title')?.value.trim() || document.getElementById('section-title')?.value.trim() || 'video';
        const cleanName = sanitizeFilename(titleVal) || 'video';
        const filename = `${cleanName}_default_cover_1080p.jpg`;

        if (!url) {
            logToConsole('[Thumbnail] Please enter or paste a video link first.', 'error');
            return;
        }

        const ytId = extractYtId(url);
        if (ytId) {
            const coverUrls = [
                `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`,
                `https://img.youtube.com/vi/${ytId}/hq720.jpg`,
                `https://img.youtube.com/vi/${ytId}/sddefault.jpg`,
                `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`
            ];
            logToConsole(`[Thumbnail] Downloading highest available official cover for ${ytId}...`, 'system');
            try {
                let res = null;
                for (const cu of coverUrls) {
                    const candidate = await fetch(cu);
                    if (candidate.ok) {
                        res = candidate;
                        break;
                    }
                }
                if (!res) throw new Error('No YouTube cover image returned HTTP 200');
                const blob = await res.blob();
                const blobUrl = URL.createObjectURL(blob);
                triggerFileDownload(blobUrl, filename, { revokeMs: 60000, showReadyBar: true });
                logToConsole(`[Thumbnail Downloaded] Saved official cover "${filename}" (${Math.round(blob.size / 1024)} KB)!`, 'success');
                return;
            } catch (e) {
                triggerFileDownload(coverUrls[0], filename, { showReadyBar: false, newTab: true });
                logToConsole(`[Thumbnail] Direct download initiated for default cover.`, 'info');
                return;
            }
        }

        // For Twitch / Kick, fetch official cover at 00:00:00
        try {
            logToConsole(`[Thumbnail] Fetching official high-resolution default cover for ${url}...`, 'system');
            const res = await fetch('/api/fetch-thumbnail', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, timestamp: '00:00:00', title: titleVal })
            });
            const data = await res.json();
            if (data && data.thumbnailUrl) {
                const imgRes = await fetch(data.thumbnailUrl);
                const blob = await imgRes.blob();
                const blobUrl = URL.createObjectURL(blob);
                const outName = data.filename || filename;
                triggerFileDownload(blobUrl, outName, { revokeMs: 60000, showReadyBar: true });
                logToConsole(`[Thumbnail Downloaded] Saved official high-resolution default cover "${outName}"!`, 'success');
            } else {
                throw new Error(data?.error || 'Failed to fetch default cover');
            }
        } catch (e) {
            logToConsole(`[Thumbnail Error] ${e.message}`, 'error');
        }
    };

    window.resetThumbnailToDefaultCover = function() {
        const thumbTime = document.getElementById('thumb-timestamp');
        if (thumbTime) {
            thumbTime.value = '';
            thumbTime.dispatchEvent(new Event('input'));
        }

        const url = document.getElementById('thumb-url')?.value.trim() || getPreferredActiveUrl();

        const titleVal = document.getElementById('thumb-title')?.value.trim() || document.getElementById('section-title')?.value.trim() || 'video';
        const ytId = extractYtId(url);
        if (ytId) {
            const maxRes = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
            const thumbImg = document.getElementById('thumb-preview-img');
            if (thumbImg) {
                applyYouTubeCoverFallback(thumbImg, ytId, (next) => {
                    if (lastCapturedThumbData) {
                        lastCapturedThumbData.thumbnailUrl = next;
                        lastCapturedThumbData.downloadUrl = next;
                    }
                });
                thumbImg.src = maxRes;
            }
            const thumbCap = document.getElementById('thumb-preview-caption');
            if (thumbCap) thumbCap.textContent = 'Official 1080p Cover';
            const thumbCard = document.getElementById('thumbnail-preview-card');
            if (thumbCard) thumbCard.classList.remove('hidden');

            lastCapturedThumbData = {
                success: true,
                platform: 'youtube',
                isFrame: false,
                thumbnailUrl: maxRes,
                downloadUrl: maxRes,
                timestamp: '00:00:00',
                filename: `${sanitizeFilename(titleVal) || ytId}_default_cover_1080p.jpg`
            };
            logToConsole('[Thumbnail] Reverted to official high-resolution default cover.', 'success');
            updateActionBtnForTab();
            updateGeneratedCommand();
            return;
        }

        if (url) {
            fetch('/api/fetch-thumbnail', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, timestamp: '00:00:00', title: titleVal })
            }).then(r => r.json()).then(data => {
                if (data && data.thumbnailUrl) {
                    lastCapturedThumbData = data;
                    const thumbImg = document.getElementById('thumb-preview-img');
                    if (thumbImg) thumbImg.src = data.thumbnailUrl;
                    const thumbCap = document.getElementById('thumb-preview-caption');
                    if (thumbCap) thumbCap.textContent = `Official Cover (${data.qualityLabel || 'HD'})`;
                    const thumbCard = document.getElementById('thumbnail-preview-card');
                    if (thumbCard) thumbCard.classList.remove('hidden');
                    updateActionBtnForTab();
                    logToConsole('[Thumbnail] Reverted to official high-resolution default cover.', 'success');
                }
            }).catch(() => {});
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

    // --- YouTube Cookie Manager ---
    window.openCookieModal = async function() {
        const modal = document.getElementById('cookie-modal-overlay');
        if (modal) modal.classList.remove('hidden');
        await updateCookieStatus();
    };

    window.closeCookieModal = function() {
        const modal = document.getElementById('cookie-modal-overlay');
        if (modal) modal.classList.add('hidden');
    };

    window.updateCookieStatus = async function() {
        try {
            const res = await fetch('/api/cookies-status');
            const data = await res.json();
            const navLabel = document.getElementById('nav-cookie-status-text');
            const navBtn = document.getElementById('btn-open-cookie-modal');
            const modalStatus = document.getElementById('modal-cookie-status-text');
            const modalBytes = document.getElementById('modal-cookie-bytes');

            if (data && data.success) {
                if (data.disabled) {
                    if (navLabel) navLabel.textContent = 'Cookies Off';
                    if (navBtn) { navBtn.className = 'cookie-status-btn inactive'; }
                    if (modalStatus) modalStatus.innerHTML = '<span style="color: #f59e0b;">Disabled / Cleared</span>';
                    if (modalBytes) modalBytes.textContent = '0 bytes';
                } else if (data.hasCookies && data.rejected) {
                    if (navLabel) navLabel.textContent = 'Cookies Expired';
                    if (navBtn) { navBtn.className = 'cookie-status-btn inactive'; }
                    if (modalStatus) modalStatus.innerHTML = `<span style="color: #ef4444;">Rejected by YouTube (${data.lineCount || 'multiple'} cookies need refresh)</span>`;
                    if (modalBytes) modalBytes.textContent = `${(data.size / 1024).toFixed(1)} KB`;
                } else if (data.hasCookies) {
                    if (navLabel) navLabel.textContent = 'Cookies Active';
                    if (navBtn) { navBtn.className = 'cookie-status-btn active'; }
                    if (modalStatus) modalStatus.innerHTML = `<span style="color: #22c55e;">Active (${data.lineCount || 'multiple'} cookies loaded)</span>`;
                    if (modalBytes) modalBytes.textContent = `${(data.size / 1024).toFixed(1)} KB`;
                } else {
                    if (navLabel) navLabel.textContent = 'Add Cookies';
                    if (navBtn) { navBtn.className = 'cookie-status-btn'; }
                    if (modalStatus) modalStatus.innerHTML = '<span style="color: var(--text-muted);">None Configured</span>';
                    if (modalBytes) modalBytes.textContent = '0 bytes';
                }
            }
        } catch (e) {
            console.warn('Could not check cookie status:', e);
        }
    };

    window.saveCookiesToServer = async function() {
        const input = document.getElementById('modal-cookie-input');
        const text = input ? input.value.trim() : '';
        if (!text || text.length < 10) {
            logToConsole('[Cookies] Please paste valid Netscape cookie text into the box.', 'warning');
            return;
        }

        const btn = document.getElementById('btn-save-cookies');
        const origText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        }

        try {
            const res = await fetch('/api/upload-cookies', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookies: text })
            });
            const data = await res.json();
            if (data && data.success) {
                logToConsole(`[Cookies] ${data.message}! YouTube authentication updated.`, 'success');
                if (input) input.value = '';
                await updateCookieStatus();
                closeCookieModal();
            } else {
                throw new Error(data?.error || 'Failed saving cookies');
            }
        } catch (err) {
            logToConsole(`[Cookies Error] ${err.message}`, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origText;
            }
        }
    };

    window.clearCookiesOnServer = async function() {
        const btn = document.getElementById('btn-clear-cookies');
        const origText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Clearing...';
        }

        try {
            const res = await fetch('/api/upload-cookies', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'clear' })
            });
            const data = await res.json();
            if (data && data.success) {
                logToConsole('[Cookies] Cookies disabled and cleared from server.', 'info');
                await updateCookieStatus();
                closeCookieModal();
            }
        } catch (err) {
            logToConsole(`[Cookies Error] ${err.message}`, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origText;
            }
        }
    };

    // --- Backend Health Check ---
    async function checkBackendHealth() {
        try {
            const res = await fetch('/api/health');
            if (res.ok) {
                isServerConnected = true;
                backendStatusIndicator.className = 'status-indicator online';
                backendStatusText.textContent = 'Node.js Backend Connected';
                updateCookieStatus();
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
    updateActionBtnForTab();
    updateGeneratedCommand();
});
