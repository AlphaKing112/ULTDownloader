import sys
import os
import re
import math
import json
import wave
import glob
import argparse
import tempfile
import subprocess
import numpy as np


def emit_progress(percent, status):
    sys.stderr.write(f"[WHISPER_PROGRESS: {percent:.1f}% | {status}]\n")
    sys.stderr.flush()


def parse_timestamp_to_seconds(ts):
    if not ts:
        return 0.0
    s = str(ts).strip()
    if not s or s.lower() in ("auto", "full", "all", "inf"):
        return 0.0
    parts = s.split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        return 0.0
    if len(nums) == 3:
        return max(0.0, nums[0] * 3600.0 + nums[1] * 60.0 + nums[2])
    if len(nums) == 2:
        return max(0.0, nums[0] * 60.0 + nums[1])
    if len(nums) == 1:
        return max(0.0, nums[0])
    return 0.0


def format_ts(seconds):
    total = max(0, int(round(seconds)))
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    if h > 0:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def detect_platform(source):
    low = source.lower()
    if "youtube.com" in low or "youtu.be" in low:
        return "youtube"
    if "twitch.tv" in low:
        if "clips.twitch.tv/" in low or "/clip/" in low:
            return "twitch_clip"
        if re.search(r"twitch\.tv/videos/\d+", low):
            return "twitch_vod"
        return "twitch"
    if "kick.com" in low:
        if "/clips/" in low or "clip=" in low:
            return "kick_clip"
        if "/video/" in low or "/videos/" in low or "video=" in low:
            return "kick_vod"
        return "kick"
    return "other"


def fetch_kick_direct_stream(source):
    """Fallback for Kick clips/VODs using curl_cffi Chrome impersonation when yt-dlp fails."""
    try:
        from curl_cffi import requests as cf_requests
    except ImportError:
        return None

    clip_m = re.search(r"(?:kick\.com/[^/]+/clips/|kick\.com/clips/|[?&]clip=)([A-Za-z0-9_-]+)", source, re.I)
    if clip_m:
        slug = clip_m.group(1)
        try:
            r = cf_requests.get(
                f"https://kick.com/api/v2/clips/{slug}",
                impersonate="chrome",
                timeout=20,
                headers={"Accept": "application/json"}
            )
            if r.status_code == 200:
                data = r.json()
                clip_obj = data.get("clip") if isinstance(data, dict) and isinstance(data.get("clip"), dict) else data
                if isinstance(clip_obj, dict):
                    return clip_obj.get("clip_url") or clip_obj.get("video_url")
        except Exception:
            return None

    vod_m = re.search(r"(?:kick\.com/video/|kick\.com/[^/]+/videos/|[?&]video=)([0-9a-f-]{12,})", source, re.I)
    if vod_m:
        uuid = vod_m.group(1)
        try:
            r = cf_requests.get(
                f"https://kick.com/api/v1/video/{uuid}",
                impersonate="chrome",
                timeout=20,
                headers={"Accept": "application/json"}
            )
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict):
                    return data.get("source")
        except Exception:
            return None
    return None


def download_audio_to_wav(source, platform, start_time, end_time, is_full, temp_base):
    """Download lightweight audio for YouTube/Twitch/Kick and condition to 16kHz mono PCM WAV."""
    wav_path = f"{temp_base}_clean.wav"
    start_sec = parse_timestamp_to_seconds(start_time) if not is_full else 0.0
    end_sec = parse_timestamp_to_seconds(end_time) if (end_time and not is_full) else 0.0
    has_range = (not is_full) and (start_sec > 0 or end_sec > start_sec)

    raw_audio_file = None
    cookies_rejected = False
    last_err_line = ""

    def run_ytdlp(use_cookies=True):
        nonlocal last_err_line, cookies_rejected
        # Clean any previous raw attempts
        for old in glob.glob(f"{temp_base}_raw.*"):
            try:
                os.remove(old)
            except Exception:
                pass

        if platform.startswith("twitch"):
            fmt = "Audio_Only/audio_only/ba/ba*/bestaudio/worst"
        elif platform == "youtube":
            fmt = "ba[ext=m4a]/ba/ba*/bestaudio/worst"
        else:
            fmt = "ba/ba*/bestaudio/best/worst"

        cmd = [
            "yt-dlp", "--no-warnings", "--no-playlist",
            "--js-runtimes", "deno" if os.path.exists("/usr/local/bin/deno") else "node",
            "-f", fmt,
            "--concurrent-fragments", "5",
            "-o", f"{temp_base}_raw.%(ext)s"
        ]

        cookies_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.txt")
        if platform == "youtube":
            cmd.append("--force-ipv4")
            cmd.extend(["--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"])
            if use_cookies and os.path.exists(cookies_path) and os.path.getsize(cookies_path) > 10:
                cmd.extend(["--cookies", cookies_path, "--extractor-args", "youtube:player_client=mweb,tv,web_safari"])
            else:
                cmd.extend(["--extractor-args", "youtube:player_client=android,ios,web_creator,tv"])

        if platform.startswith("kick"):
            cmd.extend(["--impersonate", "Chrome"])

        if start_time and end_time and not is_full:
            cmd.extend(["--download-sections", f"*{start_time}-{end_time}"])
        elif start_time and not is_full:
            cmd.extend(["--download-sections", f"*{start_time}-inf"])

        cmd.append(source)

        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
        last_stage = 5.0
        err_lines = []

        for line in proc.stdout:
            line_str = line.strip()
            if not line_str:
                continue
            if "ERROR:" in line_str or "not a bot" in line_str or "Sign in to confirm" in line_str or "cookies are no longer valid" in line_str:
                err_lines.append(line_str)
            if "cookies are no longer valid" in line_str or ("Sign in to confirm" in line_str and use_cookies):
                cookies_rejected = True

            if any(k in line_str for k in ("Downloading stream metadata", "Downloading video access token", "Downloading m3u8", "Extracting URL")) and last_stage < 8.0:
                last_stage = 8.0
                emit_progress(8.0, "Fetching stream manifest...")
            elif any(k in line_str for k in ("Downloading 1 format", "Opening", "[download]", "Destination")) and last_stage < 11.0:
                last_stage = 11.0
                emit_progress(11.0, "Buffering audio fragments...")

        proc.wait(timeout=210)
        if err_lines:
            last_err_line = err_lines[-1]

        candidates = [
            f for f in glob.glob(f"{temp_base}_raw.*")
            if not f.endswith((".part", ".ytdl", ".temp")) and os.path.getsize(f) > 512
        ]
        if candidates:
            candidates.sort(key=lambda p: os.path.getsize(p), reverse=True)
            return candidates[0]
        return None

    platform_label = {
        "youtube": "YouTube",
        "twitch_vod": "Twitch VOD",
        "twitch_clip": "Twitch Clip",
        "twitch": "Twitch",
        "kick_vod": "Kick VOD",
        "kick_clip": "Kick Clip",
        "kick": "Kick",
    }.get(platform, "Media")

    emit_progress(5.0, f"Connecting to {platform_label} audio stream...")
    raw_audio_file = run_ytdlp(use_cookies=True)

    # Automatic YouTube cookieless retry if cookies were rejected/expired
    if not raw_audio_file and platform == "youtube" and cookies_rejected:
        emit_progress(7.0, "YouTube cookies rejected; retrying with cookieless client...")
        raw_audio_file = run_ytdlp(use_cookies=False)

    # Kick direct API fallback via curl_cffi + FFmpeg if yt-dlp failed on Kick
    if not raw_audio_file and platform.startswith("kick"):
        emit_progress(9.0, "Using direct Kick API stream extractor...")
        direct_url = fetch_kick_direct_stream(source)
        if direct_url:
            ff_cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
            if has_range and start_sec > 0:
                ff_cmd.extend(["-ss", f"{start_sec:.3f}"])
            ff_cmd.extend(["-i", direct_url])
            if has_range and end_sec > start_sec:
                ff_cmd.extend(["-t", f"{(end_sec - start_sec):.3f}"])
            ff_cmd.extend([
                "-vn", "-ac", "1", "-ar", "16000", "-sample_fmt", "s16",
                "-af", "highpass=f=80,lowpass=f=7600,dynaudnorm=f=200:g=15:p=0.9:m=6",
                wav_path
            ])
            res = subprocess.run(ff_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
            if res.returncode == 0 and os.path.exists(wav_path) and os.path.getsize(wav_path) > 1024:
                return wav_path, start_sec, cookies_rejected, None
            if res.stderr:
                last_err_line = res.stderr.strip().splitlines()[-1]

    if not raw_audio_file:
        detail = last_err_line or f"Could not download {platform_label} audio stream"
        return None, start_sec, cookies_rejected, detail

    # Condition downloaded audio into clean 16kHz mono PCM WAV for Whisper + acoustic speaker analysis
    emit_progress(14.0, "Enhancing speech audio (noise & volume leveling)...")
    try:
        ff_cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", raw_audio_file,
            "-vn", "-ac", "1", "-ar", "16000", "-sample_fmt", "s16",
            "-af", "highpass=f=80,lowpass=f=7600,dynaudnorm=f=200:g=15:p=0.9:m=6",
            wav_path
        ]
        res = subprocess.run(ff_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
        if res.returncode != 0 or not os.path.exists(wav_path) or os.path.getsize(wav_path) <= 1024:
            # Simpler fallback filter if dynaudnorm fails on exotic input
            ff_simple = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", raw_audio_file, "-vn", "-ac", "1", "-ar", "16000", "-sample_fmt", "s16",
                wav_path
            ]
            res2 = subprocess.run(ff_simple, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
            if res2.returncode != 0 or not os.path.exists(wav_path):
                return None, start_sec, cookies_rejected, (res2.stderr or res.stderr or "FFmpeg audio conversion failed").strip()
    finally:
        for old in glob.glob(f"{temp_base}_raw.*"):
            try:
                os.remove(old)
            except Exception:
                pass

    return wav_path, start_sec, cookies_rejected, None


def convert_local_to_wav(source, temp_base):
    wav_path = f"{temp_base}_local.wav"
    ff_cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-sample_fmt", "s16",
        "-af", "highpass=f=80,lowpass=f=7600,dynaudnorm=f=200:g=15:p=0.9:m=6",
        wav_path
    ]
    res = subprocess.run(ff_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
    if res.returncode == 0 and os.path.exists(wav_path) and os.path.getsize(wav_path) > 1024:
        return wav_path
    return None


def load_wav_mono_16k(wav_path):
    with wave.open(wav_path, "rb") as wf:
        sr = wf.getframerate()
        nch = wf.getnchannels()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if nch > 1:
        samples = samples.reshape(-1, nch).mean(axis=1)
    return samples, sr


def build_mel_filterbank(sr=16000, n_fft=512, n_mels=26, fmin=80.0, fmax=7600.0):
    def hz_to_mel(hz):
        return 2595.0 * np.log10(1.0 + hz / 700.0)

    def mel_to_hz(mel):
        return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)

    mels = np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2)
    hz = mel_to_hz(mels)
    bins = np.floor((n_fft + 1) * hz / sr).astype(int)
    n_freqs = n_fft // 2 + 1
    fb = np.zeros((n_mels, n_freqs), dtype=np.float32)

    for i in range(1, n_mels + 1):
        left, center, right = bins[i - 1], bins[i], bins[i + 1]
        if center > left:
            fb[i - 1, left:center] = (np.arange(left, center) - left) / float(center - left)
        if right > center:
            fb[i - 1, center:right] = (right - np.arange(center, right)) / float(right - center)

    # DCT-II matrix for MFCCs 1..13 (skipping c0 energy)
    n_mfcc = 13
    k = np.arange(1, n_mfcc + 1)[:, None]
    n = np.arange(n_mels)[None, :]
    dct = np.cos(np.pi * k * (n + 0.5) / float(n_mels)).astype(np.float32) * math.sqrt(2.0 / n_mels)
    return fb, dct


def extract_voiceprint(audio, sr, start_sec, end_sec, mel_fb, dct_mat, freqs):
    """Extract a speaker-discriminative acoustic voiceprint (MFCCs 1..13, F0 pitch, spectral timbre)."""
    i0 = max(0, int(start_sec * sr))
    i1 = min(len(audio), int(end_sec * sr))
    seg = audio[i0:i1]
    if len(seg) < int(0.18 * sr):
        return None, 0.0, None

    # Pre-emphasis for clearer vocal tract formants
    emphasized = np.empty_like(seg)
    emphasized[0] = seg[0]
    emphasized[1:] = seg[1:] - 0.97 * seg[:-1]

    win_len = 400  # 25ms
    hop = 160      # 10ms
    n_fft = 512
    n_frames = 1 + (len(emphasized) - win_len) // hop
    if n_frames < 5:
        return None, 0.0, None

    # Vectorized framing via stride tricks
    stride = emphasized.strides[0]
    frames = np.lib.stride_tricks.as_strided(
        emphasized, shape=(n_frames, win_len), strides=(hop * stride, stride)
    )
    raw_frames = np.lib.stride_tricks.as_strided(
        seg, shape=(n_frames, win_len), strides=(hop * seg.strides[0], seg.strides[0])
    )

    rms = np.sqrt(np.mean(raw_frames * raw_frames, axis=1) + 1e-12)
    thresh = max(0.012, 0.22 * float(np.percentile(rms, 85)))
    voiced_mask = rms > thresh
    voiced_count = int(np.sum(voiced_mask))
    if voiced_count < 6:
        return None, 0.0, None

    voiced_sec = voiced_count * (hop / float(sr))
    window = np.hamming(win_len).astype(np.float32)
    spec = np.fft.rfft(frames[voiced_mask] * window, n=n_fft, axis=1)
    power = (spec.real * spec.real + spec.imag * spec.imag) / float(n_fft)

    mel_e = np.maximum(power @ mel_fb.T, 1e-10)
    log_mel = np.log(mel_e)
    mfccs = log_mel @ dct_mat.T  # (voiced_count, 13)
    mfcc_mean = np.mean(mfccs, axis=0)

    # Spectral centroid, 85% rolloff, and low-vs-high resonance ratio
    mag = np.sqrt(power + 1e-12)
    mag_sum = np.sum(mag, axis=1) + 1e-10
    centroids = np.sum(mag * freqs[None, :], axis=1) / mag_sum
    median_centroid = float(np.median(centroids))

    cumsum_e = np.cumsum(power, axis=1)
    total_e = cumsum_e[:, -1:] + 1e-12
    rolloff_idx = np.argmax(cumsum_e >= 0.85 * total_e, axis=1)
    median_rolloff = float(np.median(freqs[rolloff_idx]))

    low_band = (freqs >= 80.0) & (freqs <= 600.0)
    high_band = (freqs >= 1200.0) & (freqs <= 4500.0)
    low_e = float(np.mean(np.sum(power[:, low_band], axis=1))) + 1e-10
    high_e = float(np.mean(np.sum(power[:, high_band], axis=1))) + 1e-10
    low_high_ratio = math.log(low_e / high_e)

    # Fundamental frequency (F0) via normalized autocorrelation on 40ms frames (65Hz - 380Hz)
    p_win = 640
    p_hop = 320
    n_pframes = 1 + (len(seg) - p_win) // p_hop
    f0_semitones = []
    if n_pframes >= 1:
        p_frames = np.lib.stride_tricks.as_strided(
            seg, shape=(n_pframes, p_win), strides=(p_hop * seg.strides[0], seg.strides[0])
        )
        p_rms = np.sqrt(np.mean(p_frames * p_frames, axis=1) + 1e-12)
        p_thresh = max(0.015, 0.25 * float(np.percentile(p_rms, 85)))
        lag_min = int(sr / 380.0)  # 42
        lag_max = int(sr / 65.0)   # 246
        # Limit pitch computation to at most 80 evenly spaced voiced frames for speed
        active_indices = np.where(p_rms > p_thresh)[0]
        if len(active_indices) > 80:
            active_indices = active_indices[np.linspace(0, len(active_indices) - 1, 80, dtype=int)]
        for idx in active_indices:
            xf = p_frames[idx] - np.mean(p_frames[idx])
            # FFT autocorrelation
            f_xf = np.fft.rfft(xf, n=1024)
            ac = np.fft.irfft(f_xf * np.conj(f_xf), n=1024)[:lag_max + 1]
            if ac[0] <= 1e-8:
                continue
            ac_norm = ac / ac[0]
            window_ac = ac_norm[lag_min:lag_max + 1]
            best_rel = int(np.argmax(window_ac))
            peak_val = float(window_ac[best_rel])
            if peak_val >= 0.42:
                best_lag = lag_min + best_rel
                f0_hz = sr / float(best_lag)
                f0_semitones.append(12.0 * math.log2(f0_hz / 100.0))

    pitch_st = float(np.median(f0_semitones)) if len(f0_semitones) >= 3 else None

    # Build physically-scaled 17-dim voiceprint vector (no per-video z-scoring so 1 speaker stays 1 speaker!)
    # MFCCs 1..13 capture vocal tract & mic timbre
    v_mfcc = mfcc_mean / 10.5
    v_pitch = ((pitch_st / 5.5) * 1.45) if pitch_st is not None else 0.0
    v_centroid = math.log2(max(200.0, median_centroid) / 1000.0) * 1.05
    v_rolloff = math.log2(max(400.0, median_rolloff) / 2200.0) * 0.85
    v_tilt = low_high_ratio * 0.32

    vec = np.concatenate([
        v_mfcc.astype(np.float32),
        np.array([v_pitch, v_centroid, v_rolloff, v_tilt], dtype=np.float32)
    ])
    return vec, voiced_sec, pitch_st


def weighted_kmeans_from_init(X, weights, init_labels, k, iters=18):
    labels = init_labels.copy()
    n, d = X.shape
    centroids = np.zeros((k, d), dtype=np.float32)

    for _ in range(iters):
        for c in range(k):
            mask = labels == c
            if np.any(mask):
                w = weights[mask][:, None]
                centroids[c] = np.sum(X[mask] * w, axis=0) / np.sum(w)
            else:
                centroids[c] = X[c % n]

        dists = np.linalg.norm(X[:, None, :] - centroids[None, :, :], axis=2)
        new_labels = np.argmin(dists, axis=1)
        if np.array_equal(new_labels, labels):
            break
        labels = new_labels

    # Recompute final centroids
    for c in range(k):
        mask = labels == c
        if np.any(mask):
            w = weights[mask][:, None]
            centroids[c] = np.sum(X[mask] * w, axis=0) / np.sum(w)
    return labels, centroids


def agglomerative_average_linkage(dist_mat, k):
    """Deterministic pure-NumPy average-linkage hierarchical clustering into k clusters."""
    n = dist_mat.shape[0]
    clusters = [[i] for i in range(n)]
    while len(clusters) > k:
        best_pair = (0, 1)
        best_dist = float("inf")
        m = len(clusters)
        for i in range(m):
            ci = clusters[i]
            for j in range(i + 1, m):
                cj = clusters[j]
                d = float(np.mean(dist_mat[np.ix_(ci, cj)]))
                if d < best_dist:
                    best_dist = d
                    best_pair = (i, j)
        i, j = best_pair
        clusters[i] = clusters[i] + clusters[j]
        clusters.pop(j)

    labels = np.zeros(n, dtype=np.int32)
    for cid, members in enumerate(clusters):
        for idx in members:
            labels[idx] = cid
    return labels


def compute_silhouette(dist_mat, labels, k):
    n = len(labels)
    if k <= 1 or n <= k:
        return -1.0
    scores = []
    for i in range(n):
        c = labels[i]
        same = [j for j in range(n) if j != i and labels[j] == c]
        if not same:
            scores.append(0.0)
            continue
        a = float(np.mean(dist_mat[i, same]))
        b = float("inf")
        for other_c in range(k):
            if other_c == c:
                continue
            others = [j for j in range(n) if labels[j] == other_c]
            if others:
                b = min(b, float(np.mean(dist_mat[i, others])))
        denom = max(a, b, 1e-8)
        scores.append((b - a) / denom)
    return float(np.mean(scores))


def diarize_segments(wav_path, segments, max_speakers=4):
    """
    Assign speaker IDs (1..K) to Whisper segments using pure-NumPy acoustic voiceprints.
    Automatically determines whether there is 1 speaker or multiple speakers (2..4).
    """
    if not segments:
        return segments, 0

    try:
        audio, sr = load_wav_mono_16k(wav_path)
    except Exception:
        for seg in segments:
            seg["speaker"] = 1
        return segments, 1

    if len(audio) < sr:
        for seg in segments:
            seg["speaker"] = 1
        return segments, 1

    mel_fb, dct_mat = build_mel_filterbank(sr=sr, n_fft=512, n_mels=26)
    freqs = np.fft.rfftfreq(512, d=1.0 / sr).astype(np.float32)

    vecs = []
    voiced_secs = []
    pitches = []
    for seg in segments:
        v, vsec, pst = extract_voiceprint(audio, sr, seg["raw_start"], seg["raw_end"], mel_fb, dct_mat, freqs)
        vecs.append(v)
        voiced_secs.append(vsec)
        pitches.append(pst)

    # Fill missing pitch dims with overall median pitch so missing pitch doesn't pull a voice to 0.0
    valid_pitches = [p for p in pitches if p is not None]
    med_pitch_scaled = ((float(np.median(valid_pitches)) / 5.5) * 1.45) if valid_pitches else 0.0
    for idx, v in enumerate(vecs):
        if v is not None and pitches[idx] is None:
            v[13] = med_pitch_scaled

    # Select reliable anchor segments (>= 0.65s of voiced speech)
    anchor_idx = [i for i, v in enumerate(vecs) if v is not None and voiced_secs[i] >= 0.65]
    if len(anchor_idx) < 4:
        anchor_idx = [i for i, v in enumerate(vecs) if v is not None and voiced_secs[i] >= 0.35]

    if len(anchor_idx) < 2:
        for seg in segments:
            seg["speaker"] = 1
        return segments, 1

    X = np.stack([vecs[i] for i in anchor_idx], axis=0)
    weights = np.array([math.sqrt(max(0.25, voiced_secs[i])) for i in anchor_idx], dtype=np.float32)
    anchor_pitches = [pitches[i] for i in anchor_idx]

    # Pairwise Euclidean distance matrix on anchor voiceprints
    diff = X[:, None, :] - X[None, :, :]
    dist_mat = np.sqrt(np.sum(diff * diff, axis=2) + 1e-12)

    # Evaluate K = 2..max_k
    max_k = min(max_speakers, max(1, len(anchor_idx) // 2))
    best_k = 1
    best_score = -1.0
    best_centroids = None

    for k in range(2, max_k + 1):
        init_labels = agglomerative_average_linkage(dist_mat, k)
        labels, centroids = weighted_kmeans_from_init(X, weights, init_labels, k)

        # Require every speaker cluster to be meaningful (not a 1-blip cough)
        valid_clusters = True
        for c in range(k):
            members = [anchor_idx[i] for i in range(len(anchor_idx)) if labels[i] == c]
            c_dur = sum(voiced_secs[m] for m in members)
            if len(members) < 2 and c_dur < 2.2:
                valid_clusters = False
                break
        if not valid_clusters:
            continue

        sil = compute_silhouette(dist_mat, labels, k)

        # Measure minimum acoustic separation between any two detected speaker centroids
        min_euclid = float("inf")
        min_mfcc_cos = float("inf")
        min_pitch_gap = float("inf")

        cluster_pitches = []
        for c in range(k):
            cp = [anchor_pitches[i] for i in range(len(anchor_idx)) if labels[i] == c and anchor_pitches[i] is not None]
            cluster_pitches.append(float(np.median(cp)) if cp else None)

        for a in range(k):
            for b in range(a + 1, k):
                d_euc = float(np.linalg.norm(centroids[a] - centroids[b]))
                min_euclid = min(min_euclid, d_euc)

                ma, mb = centroids[a, :13], centroids[b, :13]
                na, nb = float(np.linalg.norm(ma)), float(np.linalg.norm(mb))
                cos_d = 1.0 - float(np.dot(ma, mb) / max(na * nb, 1e-8))
                min_mfcc_cos = min(min_mfcc_cos, cos_d)

                if cluster_pitches[a] is not None and cluster_pitches[b] is not None:
                    min_pitch_gap = min(min_pitch_gap, abs(cluster_pitches[a] - cluster_pitches[b]))

        # Calibrated multi-speaker decision gate (avoids splitting a solo streamer while catching real 2+ voice convos)
        strong_euclid = (min_euclid >= 0.85 and sil >= 0.23)
        strong_pitch = (min_pitch_gap >= 3.0 and sil >= 0.19 and min_euclid >= 0.65)
        strong_timbre = (min_mfcc_cos >= 0.13 and sil >= 0.21 and min_euclid >= 0.72)

        if strong_euclid or strong_pitch or strong_timbre:
            penalized = sil - 0.045 * (k - 2)
            if penalized > best_score:
                best_score = penalized
                best_k = k
                best_centroids = centroids

    if best_k == 1 or best_centroids is None:
        for seg in segments:
            seg["speaker"] = 1
        return segments, 1

    # Viterbi decoding across all segments for smooth conversational speaker turns
    n_seg = len(segments)
    dp = np.full((n_seg, best_k), float("inf"), dtype=np.float64)
    back = np.zeros((n_seg, best_k), dtype=np.int32)

    # Emission cost for each segment to each speaker centroid
    emit_cost = np.zeros((n_seg, best_k), dtype=np.float64)
    for i in range(n_seg):
        if vecs[i] is not None:
            d = np.linalg.norm(best_centroids - vecs[i][None, :], axis=1)
            # Short utterances carry less acoustic confidence than longer turns
            conf = min(1.0, max(0.35, voiced_secs[i] / 1.0))
            emit_cost[i] = d * conf
        else:
            emit_cost[i] = 0.0

    dp[0] = emit_cost[0]
    for i in range(1, n_seg):
        gap = max(0.0, segments[i]["raw_start"] - segments[i - 1]["raw_end"])
        prev_text = segments[i - 1]["text"].rstrip()
        ends_sentence = bool(prev_text and prev_text[-1] in ".?!")

        # Lower switch barrier after a natural pause or sentence end; higher mid-sentence
        if gap >= 0.65:
            switch_pen = 0.06
        elif gap >= 0.30 or ends_sentence:
            switch_pen = 0.14
        else:
            switch_pen = 0.36

        for c in range(best_k):
            best_prev = 0
            best_val = float("inf")
            for p in range(best_k):
                pen = 0.0 if p == c else switch_pen
                val = dp[i - 1, p] + pen
                if val < best_val:
                    best_val = val
                    best_prev = p
            dp[i, c] = best_val + emit_cost[i, c]
            back[i, c] = best_prev

    seq = [0] * n_seg
    seq[n_seg - 1] = int(np.argmin(dp[n_seg - 1]))
    for i in range(n_seg - 2, -1, -1):
        seq[i] = int(back[i + 1, seq[i + 1]])

    # Remap speaker IDs in canonical order of first appearance (Speaker 1 talks first!)
    order_map = {}
    next_id = 1
    for i, raw_cid in enumerate(seq):
        if raw_cid not in order_map:
            order_map[raw_cid] = next_id
            next_id += 1
        segments[i]["speaker"] = order_map[raw_cid]

    return segments, len(order_map)


HALLUCINATION_PATTERNS = [
    re.compile(r"^(?:thanks? for watching|thank you for watching|please subscribe|subscribe to my channel)[.!\s]*$", re.I),
    re.compile(r"^(?:subtitles by|transcribed by|captions by|amara\.org).*$", re.I),
    re.compile(r"^(?:\[music\]|\(music\)|♪+|\[applause\]|\(applause\)|\[silence\])$", re.I),
]


def is_hallucinated_line(text, no_speech_prob=0.0, avg_logprob=0.0):
    t = text.strip()
    if not t:
        return True
    if no_speech_prob > 0.72 and avg_logprob < -1.05:
        return True
    for pat in HALLUCINATION_PATTERNS:
        if pat.match(t) and (no_speech_prob > 0.35 or avg_logprob < -0.65):
            return True
    # Filter degenerate 4x word/phrase repetition loops
    words = t.lower().split()
    if len(words) >= 8 and len(set(words)) <= 2:
        return True
    return False


def split_segment_by_words(seg):
    """Split a long Whisper segment at natural pause gaps or sentence turns for sharper speaker changes."""
    words = getattr(seg, "words", None)
    if not words or len(words) < 4:
        t = seg.text.strip()
        if not t:
            return []
        return [{"raw_start": float(seg.start), "raw_end": float(seg.end), "text": t}]

    chunks = []
    cur_words = []
    cur_start = None

    for idx, w in enumerate(words):
        w_text = (w.word or "")
        if not w_text.strip():
            continue
        w_start = float(w.start) if w.start is not None else float(seg.start)
        w_end = float(w.end) if w.end is not None else float(seg.end)

        if cur_start is None:
            cur_start = w_start

        if cur_words:
            prev_w = cur_words[-1]
            prev_end = float(prev_w.end) if prev_w.end is not None else w_start
            gap = w_start - prev_end
            prev_str = (prev_w.word or "").strip()
            ends_punct = bool(prev_str and prev_str[-1] in ".?!")
            cur_dur = prev_end - cur_start

            # Split on clear pause (>= 0.42s) OR sentence punctuation + short pause/length
            should_split = (
                (gap >= 0.42 and len(cur_words) >= 2 and cur_dur >= 0.55)
                or (ends_punct and gap >= 0.20 and len(cur_words) >= 3)
                or (ends_punct and cur_dur >= 5.0 and len(words) - idx >= 2)
            )
            if should_split:
                joined = "".join(cw.word for cw in cur_words).strip()
                if joined:
                    chunks.append({"raw_start": cur_start, "raw_end": prev_end, "text": joined})
                cur_words = []
                cur_start = w_start

        cur_words.append(w)

    if cur_words:
        last_end = float(cur_words[-1].end) if cur_words[-1].end is not None else float(seg.end)
        joined = "".join(cw.word for cw in cur_words).strip()
        if joined:
            chunks.append({"raw_start": cur_start, "raw_end": last_end, "text": joined})

    return chunks


def merge_same_speaker_turns(segments):
    """Merge tiny consecutive fragments from the same speaker while keeping speaker switches crystal clear."""
    if not segments:
        return []
    merged = [dict(segments[0])]
    for seg in segments[1:]:
        prev = merged[-1]
        gap = seg["raw_start"] - prev["raw_end"]
        combined_dur = seg["raw_end"] - prev["raw_start"]
        combined_len = len(prev["text"]) + 1 + len(seg["text"])
        if (
            seg.get("speaker") == prev.get("speaker")
            and gap <= 0.55
            and combined_dur <= 9.5
            and combined_len <= 220
        ):
            prev["raw_end"] = seg["raw_end"]
            prev["text"] = f"{prev['text']} {seg['text']}".strip()
        else:
            merged.append(dict(seg))
    return merged


def transcribe_audio(wav_path, start_offset_sec=0.0, detect_speakers=True, language="en", title="", platform="other"):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None, None, None, "faster-whisper library is not installed in this environment. Please install it with 'pip install faster-whisper'."

    is_render = bool(os.environ.get("RENDER") or os.environ.get("RENDER_SERVICE_ID"))
    use_english_only = (language or "en").lower() in ("en", "english")

    if is_render:
        model_name = "tiny.en" if use_english_only else "tiny"
        cpu_threads = 2
        beam_size = 2
    else:
        model_name = "base.en" if use_english_only else "base"
        cpu_threads = min(8, os.cpu_count() or 4)
        beam_size = 3

    loaded_model_name = model_name
    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=cpu_threads)
    except Exception as model_err:
        fallback_name = "tiny.en" if use_english_only else "tiny"
        if model_name != fallback_name:
            try:
                loaded_model_name = fallback_name
                model = WhisperModel(fallback_name, device="cpu", compute_type="int8", cpu_threads=1)
            except Exception:
                return None, None, None, f"Whisper model load error: {str(model_err)}"
        else:
            return None, None, None, f"Whisper model load error: {str(model_err)}"

    prompt_bits = ["Natural spoken conversation, livestream or podcast dialogue with proper punctuation."]
    clean_title = re.sub(r"[^\w\s,'-]", " ", title or "").strip()
    if clean_title:
        prompt_bits.append(f"Topic: {clean_title[:120]}.")
    initial_prompt = " ".join(prompt_bits)

    transcribe_kwargs = dict(
        beam_size=beam_size,
        best_of=1,
        temperature=(0.0, 0.2),
        condition_on_previous_text=False,
        no_speech_threshold=0.60,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
        repetition_penalty=1.1,
        vad_filter=True,
        vad_parameters=dict(
            threshold=0.42,
            min_speech_duration_ms=200,
            min_silence_duration_ms=350,
            speech_pad_ms=180
        ),
        word_timestamps=True,
        initial_prompt=initial_prompt
    )
    if use_english_only:
        transcribe_kwargs["language"] = "en"

    segments_gen, info = model.transcribe(wav_path, **transcribe_kwargs)

    total_sec = max(1.0, float(info.duration or 1.0))
    tot_str = format_ts(total_sec)
    emit_progress(20.0, f"Transcribing dialogue ({loaded_model_name}): 00:00 / {tot_str}")

    raw_segments = []
    for s in segments_gen:
        text_clean = (s.text or "").strip()
        if not is_hallucinated_line(
            text_clean,
            no_speech_prob=float(getattr(s, "no_speech_prob", 0.0) or 0.0),
            avg_logprob=float(getattr(s, "avg_logprob", 0.0) or 0.0)
        ):
            sub_chunks = split_segment_by_words(s)
            for ch in sub_chunks:
                if not is_hallucinated_line(ch["text"]):
                    raw_segments.append(ch)

        current_sec = min(total_sec, float(s.end))
        max_transcribe_pct = 86.0 if detect_speakers else 98.0
        pct = min(max_transcribe_pct, 20.0 + (current_sec / total_sec) * (max_transcribe_pct - 20.0))
        emit_progress(pct, f"Transcribing dialogue: {format_ts(current_sec)} / {tot_str}")

    speaker_count = 1 if raw_segments else 0
    if detect_speakers and raw_segments:
        emit_progress(90.0, "Analyzing voiceprints & detecting speakers...")
        raw_segments, speaker_count = diarize_segments(wav_path, raw_segments, max_speakers=4)
        raw_segments = merge_same_speaker_turns(raw_segments)
        emit_progress(97.0, f"Detected {speaker_count} speaker{'s' if speaker_count != 1 else ''} — formatting transcript...")
    else:
        for seg in raw_segments:
            seg["speaker"] = 1
        raw_segments = merge_same_speaker_turns(raw_segments)

    # Shift timestamps by start_offset_sec and compute speaker statistics
    speaker_stats = {}
    formatted_segments = []
    formatted_lines = []

    for seg in raw_segments:
        s_abs = seg["raw_start"] + start_offset_sec
        e_abs = max(s_abs, seg["raw_end"] + start_offset_sec)
        s_str = format_ts(s_abs)
        e_str = format_ts(e_abs)
        spk = int(seg.get("speaker") or 1)
        spk_label = f"Speaker {spk}"
        dur = max(0.1, seg["raw_end"] - seg["raw_start"])

        if spk not in speaker_stats:
            speaker_stats[spk] = {"id": spk, "label": spk_label, "count": 0, "durationSec": 0.0}
        speaker_stats[spk]["count"] += 1
        speaker_stats[spk]["durationSec"] += dur

        formatted_segments.append({
            "start": s_str,
            "end": e_str,
            "startSec": round(s_abs, 2),
            "endSec": round(e_abs, 2),
            "speaker": spk,
            "speakerLabel": spk_label,
            "text": seg["text"]
        })

        if detect_speakers and speaker_count >= 1:
            formatted_lines.append(f"[{s_str} - {e_str}] [{spk_label}] {seg['text']}")
        else:
            formatted_lines.append(f"[{s_str} - {e_str}] {seg['text']}")

    total_talk = sum(v["durationSec"] for v in speaker_stats.values()) or 1.0
    speakers_list = []
    sorted_ids = sorted(speaker_stats.keys())
    for spk_id in sorted_ids:
        st = speaker_stats[spk_id]
        raw_dur = st["durationSec"]
        share_pct = 100 if len(sorted_ids) == 1 else min(100, max(1, int(round((raw_dur / total_talk) * 100.0))))
        st["durationSec"] = round(raw_dur, 1)
        st["share"] = share_pct
        speakers_list.append(st)

    meta = {
        "language": getattr(info, "language", language) or "en",
        "model": loaded_model_name,
        "speakerCount": len(speakers_list),
        "speakers": speakers_list,
        "segments": formatted_segments
    }
    return "\n".join(formatted_lines), meta, None, None


def main():
    parser = argparse.ArgumentParser(description="Local Whisper AI + Speaker Detection for ULT Downloader")
    parser.add_argument("source", help="Media URL or local file path")
    parser.add_argument("--start", help="Start time (HH:MM:SS)", default="")
    parser.add_argument("--end", help="End time (HH:MM:SS)", default="")
    parser.add_argument("--full", help="Force transcribe full video/VOD", action="store_true")
    parser.add_argument("--no-speakers", help="Disable acoustic speaker diarization", action="store_true")
    parser.add_argument("--language", help="Language code ('en' or 'auto')", default="en")
    parser.add_argument("--title", help="Optional video title context for Whisper prompt", default="")
    args = parser.parse_args()

    source = args.source.strip()
    is_url = source.startswith("http://") or source.startswith("https://")
    platform = detect_platform(source) if is_url else "local"
    temp_dir = tempfile.gettempdir()
    temp_base = os.path.join(temp_dir, f"ult_whisper_{os.getpid()}")
    wav_path = None

    try:
        auto_capped = False
        start_offset_sec = 0.0
        cookies_rejected = False

        if is_url:
            is_vod = platform in ("twitch_vod", "kick_vod")
            is_yt = (platform == "youtube")
            is_render_host = bool(os.environ.get("RENDER") or os.environ.get("RENDER_SERVICE_ID"))
            start_time = args.start.strip()
            end_time = args.end.strip()
            is_full = args.full or end_time.lower() in ("full", "all", "inf")

            # Cap long VODs or Render YouTube runs to first 5 minutes when no explicit range or Full flag is set
            if (is_vod or (is_render_host and is_yt)) and not start_time and (not end_time or not is_full):
                start_time = "00:00:00"
                end_time = "00:05:00"
                auto_capped = True

            wav_path, start_offset_sec, cookies_rejected, dl_err = download_audio_to_wav(
                source, platform, start_time, end_time, is_full, temp_base
            )
            if dl_err or not wav_path:
                print(json.dumps({
                    "success": False,
                    "error": dl_err or "Audio stream download failed",
                    "cookiesRejected": cookies_rejected,
                    "platform": platform
                }))
                sys.exit(0)
        else:
            if not os.path.exists(source):
                print(json.dumps({"success": False, "error": "Source audio file not found"}))
                sys.exit(0)
            wav_path = convert_local_to_wav(source, temp_base)
            if not wav_path:
                print(json.dumps({"success": False, "error": "Failed to convert local audio to WAV"}))
                sys.exit(0)

        emit_progress(18.0, "Loading Whisper AI neural model...")
        transcript, meta, _, err_msg = transcribe_audio(
            wav_path,
            start_offset_sec=start_offset_sec,
            detect_speakers=not args.no_speakers,
            language=args.language,
            title=args.title,
            platform=platform
        )
        if err_msg:
            print(json.dumps({"success": False, "error": err_msg, "platform": platform}))
            sys.exit(0)

        if not transcript or not transcript.strip():
            transcript = "No spoken words or dialogue detected in this video section."

        notice = None
        if auto_capped:
            notice = "Transcribed the first 5 minutes for fast AI + speaker analysis. Pick 15m, 30m, a custom range, or Full Stream for longer sections."

        print(json.dumps({
            "success": True,
            "transcript": transcript,
            "segments": meta["segments"],
            "speakers": meta["speakers"],
            "speakerCount": meta["speakerCount"],
            "language": meta["language"],
            "model": meta["model"],
            "platform": platform,
            "source": "whisper-ai",
            "cookiesRejected": cookies_rejected,
            "notice": notice
        }))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e), "platform": platform}))
        sys.exit(0)
    finally:
        for leftover in glob.glob(f"{temp_base}*"):
            try:
                os.remove(leftover)
            except Exception:
                pass


if __name__ == "__main__":
    main()
