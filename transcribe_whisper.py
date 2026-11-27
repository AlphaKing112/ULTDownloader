import sys
import os
import re
import math
import json
import wave
import glob
import uuid
import argparse
import tempfile
import subprocess
import urllib.parse
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
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


def resolve_lowest_hls_variant(master_url):
    """
    Parse an HLS master.m3u8 playlist and select either a dedicated AUDIO-only track
    or the lowest-bandwidth video+audio variant (e.g. Kick 160p30 at 230kbps vs 1080p60 at 8.18Mbps — 35x smaller!).
    """
    if not master_url or ".m3u8" not in master_url.lower():
        return master_url, None

    text = ""
    try:
        from curl_cffi import requests as cf_requests
        r = cf_requests.get(master_url, impersonate="chrome", timeout=15)
        if r.status_code == 200:
            text = r.text
    except Exception:
        pass

    if not text:
        try:
            req = urllib.request.Request(master_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                text = resp.read().decode("utf-8", errors="replace")
        except Exception:
            return master_url, None

    if "#EXT-X-STREAM-INF" not in text and "#EXT-X-MEDIA" not in text:
        return master_url, None

    lines = [l.strip() for l in text.splitlines() if l.strip()]

    # 1. Prefer dedicated AUDIO-only media track if present
    for line in lines:
        if line.startswith("#EXT-X-MEDIA:") and "TYPE=AUDIO" in line and "URI=" in line:
            uri_m = re.search(r'URI="([^"]+)"', line)
            if uri_m:
                return urllib.parse.urljoin(master_url, uri_m.group(1)), "Audio-Only HLS"

    # 2. Otherwise pick the lowest BANDWIDTH variant (same AAC audio, tiny video payload)
    variants = []
    for idx, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF:"):
            bw_m = re.search(r"BANDWIDTH=(\d+)", line)
            res_m = re.search(r"RESOLUTION=([0-9]+x[0-9]+)", line)
            bw = int(bw_m.group(1)) if bw_m else 999_999_999
            res_label = res_m.group(1) if res_m else ""
            if idx + 1 < len(lines) and not lines[idx + 1].startswith("#"):
                variants.append((bw, res_label, urllib.parse.urljoin(master_url, lines[idx + 1])))

    if variants:
        variants.sort(key=lambda v: v[0])
        best_bw, best_res, best_url = variants[0]
        kbps = max(1, best_bw // 1000)
        label = f"{best_res} ({kbps} kbps)" if best_res else f"{kbps} kbps"
        return best_url, label

    return master_url, None


def fetch_kick_direct_stream(source):
    """Resolve Kick clips/VODs via Kick JSON API or Kick VOD webpage og:video (.m3u8) using curl_cffi."""
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
            pass

    vod_m = re.search(r"(?:kick\.com/video/|kick\.com/[^/]+/videos?/|kick\.com/videos/|[?&]video=)([0-9a-f-]{12,})", source, re.I)
    if vod_m:
        vod_uuid = vod_m.group(1)
        try:
            r = cf_requests.get(
                f"https://kick.com/api/v1/video/{vod_uuid}",
                impersonate="chrome",
                timeout=15,
                headers={"Accept": "application/json"}
            )
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict) and data.get("source"):
                    return data.get("source")
        except Exception:
            pass

        # Newer Kick UUIDv7 VODs return 404 on api/v1/video/ but embed og:video master.m3u8 directly in the VOD page HTML
        try:
            r_page = cf_requests.get(source, impersonate="chrome", timeout=20)
            if r_page.status_code == 200 and r_page.text:
                html = r_page.text.replace("\\/", "/").replace("\\u0026", "&")
                og_m = re.search(r'<meta[^>]+property=["\']og:video["\'][^>]+content=["\'](https://[^"\']+\.m3u8[^"\']*)["\']', html, re.I)
                if not og_m:
                    og_m = re.search(r'content=["\'](https://[^"\']+\.m3u8[^"\']*)["\'][^>]+property=["\']og:video["\']', html, re.I)
                if og_m:
                    return og_m.group(1)
                hls_m = re.search(r'https://stream\.kick\.com/[^\s"\'<>\\]+\.m3u8[^\s"\'<>\\]*', html, re.I)
                if hls_m:
                    return hls_m.group(0)
        except Exception:
            pass
    return None


def fetch_twitch_audio_only_stream(source):
    """Resolve Twitch VOD's Audio_Only (or lowest 160p) HLS URL via yt-dlp -g for ultra-fast direct FFmpeg seeking."""
    cmd = [
        "yt-dlp", "--no-warnings", "--no-playlist",
        "-f", "Audio_Only/audio_only/160p/worstaudio/worst",
        "-g", source
    ]
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
        if res.returncode == 0 and res.stdout.strip():
            url = res.stdout.strip().splitlines()[0].strip()
            if url.startswith("http"):
                return url
    except Exception:
        pass
    return None


def download_audio_to_wav(source, platform, start_time, end_time, is_full, temp_base):
    """
    Download the smallest speech-clear audio stream for YouTube, Twitch, or Kick
    and convert directly to 16 kHz mono 16-bit PCM WAV.
    """
    wav_path = f"{temp_base}_clean.wav"
    start_sec = parse_timestamp_to_seconds(start_time) if not is_full else 0.0
    end_sec = parse_timestamp_to_seconds(end_time) if (end_time and not is_full) else 0.0
    has_range = (not is_full) and (start_sec > 0 or end_sec > start_sec)
    target_dur = (end_sec - start_sec) if (has_range and end_sec > start_sec) else 0.0
    is_long_target = is_full or target_dur > 180.0

    # Skip heavy per-frame dynaudnorm on long (>3m) VODs for 2x faster FFmpeg pass while keeping crisp speech bandpass
    speech_filter = "highpass=f=80,lowpass=f=7600" if is_long_target else "highpass=f=80,lowpass=f=7600,dynaudnorm=f=200:g=15:p=0.9:m=6"

    raw_audio_file = None
    cookies_rejected = False
    last_err_line = ""

    def stream_direct_via_ffmpeg(stream_url, label=""):
        nonlocal last_err_line
        # If master HLS playlist, select audio-only or lowest-bandwidth variant (up to 35x smaller!)
        target_url, variant_label = resolve_lowest_hls_variant(stream_url)
        if variant_label:
            emit_progress(10.0, f"Streaming {label or 'low-bandwidth'} audio ({variant_label})...")
        else:
            emit_progress(10.0, f"Streaming {label or 'direct'} audio via FFmpeg...")

        ff_cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
        if has_range and start_sec > 0:
            ff_cmd.extend(["-ss", f"{start_sec:.3f}"])
        ff_cmd.extend(["-i", target_url])
        if has_range and end_sec > start_sec:
            ff_cmd.extend(["-t", f"{(end_sec - start_sec):.3f}"])
        ff_cmd.extend([
            "-vn", "-ac", "1", "-ar", "16000", "-sample_fmt", "s16",
            "-af", speech_filter,
            wav_path
        ])
        timeout_sec = 420 if is_long_target else 180
        res = subprocess.run(ff_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout_sec)
        if res.returncode == 0 and os.path.exists(wav_path) and os.path.getsize(wav_path) > 1024:
            return wav_path
        if res.stderr:
            last_err_line = res.stderr.strip().splitlines()[-1]
        return None

    def run_ytdlp(use_cookies=True):
        nonlocal last_err_line, cookies_rejected
        for old in glob.glob(f"{temp_base}_raw.*"):
            try:
                os.remove(old)
            except Exception:
                pass

        # Always select lowest-bandwidth speech-clear audio track (never affects normal video downloads!)
        if platform == "twitch_vod":
            fmt = "Audio_Only/audio_only/160p/worstaudio/worst"
        elif platform.startswith("twitch"):
            fmt = "worstaudio/worst[height<=360]/worst/ba/best"
        elif platform == "youtube":
            # 48-64 kbps audio-only (~3x smaller than 160kbps, 0 video bytes, crystal-clear speech!)
            fmt = "wa[abr>=40]/ba[abr<=70]/ba[ext=m4a]/ba/worstaudio/worst"
        else:
            fmt = "worstaudio/worst[height<=360]/ba/bestaudio/worst"

        cmd = [
            "yt-dlp", "--no-warnings", "--no-playlist",
            "--js-runtimes", "deno" if os.path.exists("/usr/local/bin/deno") else "node",
            "-f", fmt,
            "--concurrent-fragments", "6",
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
                emit_progress(8.0, "Fetching low-bandwidth audio manifest...")
            elif any(k in line_str for k in ("Downloading 1 format", "Opening", "[download]", "Destination")) and last_stage < 11.0:
                last_stage = 11.0
                emit_progress(11.0, "Downloading compact speech audio...")

        proc.wait(timeout=360 if is_long_target else 210)
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

    emit_progress(5.0, f"Connecting to {platform_label} compact audio stream...")

    # Fast Path 1: Kick VODs -> resolve HLS master.m3u8 -> lowest 160p variant (~35x smaller!) -> FFmpeg fast seek
    if platform == "kick_vod":
        kick_url = fetch_kick_direct_stream(source)
        if kick_url:
            direct_wav = stream_direct_via_ffmpeg(kick_url, label="Kick VOD")
            if direct_wav:
                return direct_wav, start_sec, cookies_rejected, None

    # Fast Path 2: Twitch VODs -> resolve Audio_Only HLS track directly -> FFmpeg fast seek (0 video downloaded!)
    if platform == "twitch_vod":
        tw_audio_url = fetch_twitch_audio_only_stream(source)
        if tw_audio_url:
            direct_wav = stream_direct_via_ffmpeg(tw_audio_url, label="Twitch Audio-Only")
            if direct_wav:
                return direct_wav, start_sec, cookies_rejected, None

    raw_audio_file = run_ytdlp(use_cookies=True)

    # Automatic YouTube cookieless retry if cookies were rejected/expired
    if not raw_audio_file and platform == "youtube" and cookies_rejected:
        emit_progress(7.0, "YouTube cookies rejected; retrying with cookieless client...")
        raw_audio_file = run_ytdlp(use_cookies=False)

    # Kick direct API/webpage fallback via curl_cffi + FFmpeg if yt-dlp failed on Kick
    if not raw_audio_file and platform.startswith("kick"):
        emit_progress(9.0, "Using direct Kick stream extractor...")
        kick_url = fetch_kick_direct_stream(source)
        if kick_url:
            direct_wav = stream_direct_via_ffmpeg(kick_url, label="Kick")
            if direct_wav:
                return direct_wav, start_sec, cookies_rejected, None

    if not raw_audio_file:
        detail = last_err_line or f"Could not download {platform_label} audio stream"
        return None, start_sec, cookies_rejected, detail

    # Condition downloaded audio into clean 16kHz mono PCM WAV for Whisper + acoustic speaker analysis
    emit_progress(14.0, "Preparing 16kHz speech audio...")
    try:
        ff_cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", raw_audio_file,
            "-vn", "-ac", "1", "-ar", "16000", "-sample_fmt", "s16",
            "-af", speech_filter,
            wav_path
        ]
        res = subprocess.run(ff_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=240)
        if res.returncode != 0 or not os.path.exists(wav_path) or os.path.getsize(wav_path) <= 1024:
            ff_simple = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", raw_audio_file, "-vn", "-ac", "1", "-ar", "16000", "-sample_fmt", "s16",
                wav_path
            ]
            res2 = subprocess.run(ff_simple, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=240)
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
    res = subprocess.run(ff_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
    if res.returncode == 0 and os.path.exists(wav_path) and os.path.getsize(wav_path) > 1024:
        return wav_path
    return None


def get_wav_duration_seconds(wav_path):
    try:
        with wave.open(wav_path, "rb") as wf:
            sr = wf.getframerate() or 16000
            return wf.getnframes() / float(sr)
    except Exception:
        return 0.0


class WaveSegmentReader:
    """Low-RAM disk-streaming WAV slice reader (<2 MB RAM even on multi-hour VODs!)."""
    def __init__(self, wav_path):
        self.wf = wave.open(wav_path, "rb")
        self.sr = self.wf.getframerate()
        self.nch = self.wf.getnchannels()
        self.nframes = self.wf.getnframes()

    def read_slice(self, start_sec, end_sec, max_sec=12.0):
        # Cap individual segment read to 12s (more than enough for a rock-solid voiceprint, keeps RAM tiny)
        eff_end = min(end_sec, start_sec + max_sec)
        i0 = max(0, min(self.nframes, int(start_sec * self.sr)))
        i1 = max(i0, min(self.nframes, int(eff_end * self.sr)))
        count = i1 - i0
        if count <= 0:
            return np.zeros(0, dtype=np.float32)
        self.wf.setpos(i0)
        raw = self.wf.readframes(count)
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if self.nch > 1:
            samples = samples.reshape(-1, self.nch).mean(axis=1)
        return samples

    def close(self):
        try:
            self.wf.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()


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

    n_mfcc = 13
    k = np.arange(1, n_mfcc + 1)[:, None]
    n = np.arange(n_mels)[None, :]
    dct = np.cos(np.pi * k * (n + 0.5) / float(n_mels)).astype(np.float32) * math.sqrt(2.0 / n_mels)
    return fb, dct


def extract_voiceprint_from_slice(seg, sr, mel_fb, dct_mat, freqs):
    """Extract a speaker-discriminative acoustic voiceprint (MFCCs 1..13, F0 pitch, spectral timbre)."""
    if len(seg) < int(0.18 * sr):
        return None, 0.0, None

    emphasized = np.empty_like(seg)
    emphasized[0] = seg[0]
    emphasized[1:] = seg[1:] - 0.97 * seg[:-1]

    win_len = 400
    hop = 160
    n_fft = 512
    n_frames = 1 + (len(emphasized) - win_len) // hop
    if n_frames < 5:
        return None, 0.0, None

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
    mfccs = log_mel @ dct_mat.T
    mfcc_mean = np.mean(mfccs, axis=0)

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

    # Fundamental frequency (F0) via normalized autocorrelation (65Hz - 380Hz)
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
        lag_min = int(sr / 380.0)
        lag_max = int(sr / 65.0)
        active_indices = np.where(p_rms > p_thresh)[0]
        if len(active_indices) > 60:
            active_indices = active_indices[np.linspace(0, len(active_indices) - 1, 60, dtype=int)]
        for idx in active_indices:
            xf = p_frames[idx] - np.mean(p_frames[idx])
            f_xf = np.fft.rfft(xf, n=1024)
            ac = np.fft.irfft(f_xf * np.conj(f_xf), n=1024)[:lag_max + 1]
            if ac[0] <= 1e-8:
                continue
            ac_norm = ac / ac[0]
            window_ac = ac_norm[lag_min:lag_max + 1]
            best_rel = int(np.argmax(window_ac))
            if float(window_ac[best_rel]) >= 0.42:
                best_lag = lag_min + best_rel
                f0_hz = sr / float(best_lag)
                f0_semitones.append(12.0 * math.log2(f0_hz / 100.0))

    pitch_st = float(np.median(f0_semitones)) if len(f0_semitones) >= 3 else None

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

    for c in range(k):
        mask = labels == c
        if np.any(mask):
            w = weights[mask][:, None]
            centroids[c] = np.sum(X[mask] * w, axis=0) / np.sum(w)
    return labels, centroids


def agglomerative_average_linkage(dist_mat, k):
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
    Low-RAM streaming acoustic speaker diarization (<2 MB RAM, fast even on 1-hour+ VODs).
    Caps clustering anchors to <=80 evenly stratified segments so clustering always finishes in <0.1s.
    """
    if not segments:
        return segments, 0

    try:
        with WaveSegmentReader(wav_path) as reader:
            sr = reader.sr
            if reader.nframes < sr:
                for seg in segments:
                    seg["speaker"] = 1
                return segments, 1

            mel_fb, dct_mat = build_mel_filterbank(sr=sr, n_fft=512, n_mels=26)
            freqs = np.fft.rfftfreq(512, d=1.0 / sr).astype(np.float32)

            vecs = []
            voiced_secs = []
            pitches = []
            for seg in segments:
                audio_slice = reader.read_slice(seg["raw_start"], seg["raw_end"])
                v, vsec, pst = extract_voiceprint_from_slice(audio_slice, sr, mel_fb, dct_mat, freqs)
                vecs.append(v)
                voiced_secs.append(vsec)
                pitches.append(pst)
    except Exception:
        for seg in segments:
            seg["speaker"] = 1
        return segments, 1

    valid_pitches = [p for p in pitches if p is not None]
    med_pitch_scaled = ((float(np.median(valid_pitches)) / 5.5) * 1.45) if valid_pitches else 0.0
    for idx, v in enumerate(vecs):
        if v is not None and pitches[idx] is None:
            v[13] = med_pitch_scaled

    anchor_idx = [i for i, v in enumerate(vecs) if v is not None and voiced_secs[i] >= 0.65]
    if len(anchor_idx) < 4:
        anchor_idx = [i for i, v in enumerate(vecs) if v is not None and voiced_secs[i] >= 0.35]

    if len(anchor_idx) < 2:
        for seg in segments:
            seg["speaker"] = 1
        return segments, 1

    # Cap clustering anchors to <=80 stratified across the timeline (prevents O(N^3) slowdown on 1h+ VODs!)
    if len(anchor_idx) > 80:
        buckets = np.array_split(anchor_idx, 80)
        selected = []
        for b in buckets:
            if len(b) > 0:
                best_in_bucket = max(b, key=lambda idx: voiced_secs[idx])
                selected.append(int(best_in_bucket))
        anchor_idx = selected

    X = np.stack([vecs[i] for i in anchor_idx], axis=0)
    weights = np.array([math.sqrt(max(0.25, voiced_secs[i])) for i in anchor_idx], dtype=np.float32)
    anchor_pitches = [pitches[i] for i in anchor_idx]

    diff = X[:, None, :] - X[None, :, :]
    dist_mat = np.sqrt(np.sum(diff * diff, axis=2) + 1e-12)

    max_k = min(max_speakers, max(1, len(anchor_idx) // 2))
    best_k = 1
    best_score = -1.0
    best_centroids = None

    for k in range(2, max_k + 1):
        init_labels = agglomerative_average_linkage(dist_mat, k)
        labels, centroids = weighted_kmeans_from_init(X, weights, init_labels, k)

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

    emit_cost = np.zeros((n_seg, best_k), dtype=np.float64)
    for i in range(n_seg):
        if vecs[i] is not None:
            d = np.linalg.norm(best_centroids - vecs[i][None, :], axis=1)
            conf = min(1.0, max(0.35, voiced_secs[i] / 1.0))
            emit_cost[i] = d * conf
        else:
            emit_cost[i] = 0.0

    dp[0] = emit_cost[0]
    for i in range(1, n_seg):
        gap = max(0.0, segments[i]["raw_start"] - segments[i - 1]["raw_end"])
        prev_text = segments[i - 1]["text"].rstrip()
        ends_sentence = bool(prev_text and prev_text[-1] in ".?!")

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
    words = t.lower().split()
    if len(words) >= 8 and len(set(words)) <= 2:
        return True
    return False


def split_segment_by_words(seg):
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


def upload_chunk_to_groq(mp3_path, api_key, language="en", prompt=""):
    """Upload a compact 32kbps MP3 chunk to Groq whisper-large-v3-turbo using stdlib multipart HTTP."""
    boundary = f"----ULTBoundary{uuid.uuid4().hex}"
    fields = [
        ("model", "whisper-large-v3-turbo"),
        ("response_format", "verbose_json"),
        ("temperature", "0"),
        ("timestamp_granularities[]", "segment"),
    ]
    if (language or "en").lower() in ("en", "english"):
        fields.append(("language", "en"))
    if prompt:
        fields.append(("prompt", prompt[:220]))

    parts = []
    for k, v in fields:
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode("utf-8"))

    with open(mp3_path, "rb") as f:
        file_bytes = f.read()
    filename = os.path.basename(mp3_path)
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: audio/mpeg\r\n\r\n".encode("utf-8")
    )
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(parts)

    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": "ULTDownloader/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def transcribe_via_groq(wav_path, api_key, language="en", title="", temp_base=""):
    """
    Ultra-fast cloud transcription via Groq whisper-large-v3-turbo (~200x real-time!).
    Splits long VODs into 10-min 32kbps MP3 chunks (~2.4 MB each) and uploads up to 3 in parallel.
    """
    total_sec = get_wav_duration_seconds(wav_path)
    if total_sec <= 0.2:
        return [], language or "en", None

    chunk_sec = 600.0  # 10-minute chunks (~2.4 MB at 32kbps MP3)
    n_chunks = max(1, int(math.ceil(total_sec / chunk_sec)))
    chunk_files = []

    emit_progress(20.0, f"Encoding {n_chunks} compact chunk{'s' if n_chunks > 1 else ''} for Groq Turbo AI...")
    try:
        for i in range(n_chunks):
            c_start = i * chunk_sec
            c_path = f"{temp_base}_groq_{i}.mp3"
            ff_cmd = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-ss", f"{c_start:.3f}", "-i", wav_path,
                "-t", f"{chunk_sec:.3f}",
                "-ac", "1", "-ar", "16000", "-b:a", "32k",
                c_path
            ]
            res = subprocess.run(ff_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
            if res.returncode == 0 and os.path.exists(c_path) and os.path.getsize(c_path) > 256:
                chunk_files.append((i, c_start, c_path))

        if not chunk_files:
            return None, None, "Could not encode audio chunks for Groq"

        clean_groq_title = re.sub(r"[^\w\s,'-]", " ", title or "").strip()[:120]
        prompt = f"Natural livestream or podcast conversation. {clean_groq_title}".strip()
        emit_progress(32.0, f"Transcribing via Groq Whisper Large-v3-Turbo ({len(chunk_files)} chunk{'s' if len(chunk_files) > 1 else ''})...")

        chunk_results = {}
        detected_lang = language or "en"
        completed = 0

        with ThreadPoolExecutor(max_workers=min(3, len(chunk_files))) as pool:
            fut_map = {
                pool.submit(upload_chunk_to_groq, c_path, api_key, language, prompt): (idx, c_start)
                for idx, c_start, c_path in chunk_files
            }
            for fut in as_completed(fut_map):
                idx, c_start = fut_map[fut]
                data = fut.result()
                if data.get("language"):
                    detected_lang = data["language"]
                segs = []
                for s in data.get("segments") or []:
                    txt = (s.get("text") or "").strip()
                    if not is_hallucinated_line(
                        txt,
                        no_speech_prob=float(s.get("no_speech_prob") or 0.0),
                        avg_logprob=float(s.get("avg_logprob") or 0.0),
                    ):
                        segs.append({
                            "raw_start": c_start + float(s.get("start") or 0.0),
                            "raw_end": c_start + float(s.get("end") or 0.0),
                            "text": txt,
                        })
                chunk_results[idx] = segs
                completed += 1
                pct = 32.0 + (completed / float(len(chunk_files))) * 54.0
                emit_progress(pct, f"Groq Turbo AI: finished chunk {completed}/{len(chunk_files)}...")

        all_segments = []
        for idx in sorted(chunk_results.keys()):
            all_segments.extend(chunk_results[idx])
        return all_segments, detected_lang, None
    except Exception as e:
        return None, None, str(e)
    finally:
        for _, _, c_path in chunk_files:
            try:
                os.remove(c_path)
            except Exception:
                pass


def transcribe_via_local_whisper(wav_path, language="en", title="", detect_speakers=True):
    """Optimized local faster-whisper with BatchedInferencePipeline for long VODs and optional local GPU support."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None, None, None, "faster-whisper library is not installed in this environment."

    is_render = bool(os.environ.get("RENDER") or os.environ.get("RENDER_SERVICE_ID"))
    use_english_only = (language or "en").lower() in ("en", "english")
    wav_dur = get_wav_duration_seconds(wav_path)
    is_long_audio = wav_dur > 180.0

    # Auto-detect NVIDIA GPU locally ONLY if cuBLAS + cuDNN 9 native libraries are actually loadable (avoids C++ abort!)
    device = "cpu"
    compute_type = "int8"
    if not is_render:
        try:
            import ctypes
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                if sys.platform == "win32":
                    ctypes.CDLL("cublas64_12.dll")
                    ctypes.CDLL("cudnn_ops64_9.dll")
                else:
                    ctypes.CDLL("libcublas.so.12")
                    ctypes.CDLL("libcudnn_ops.so.9")
                device = "cuda"
                compute_type = "float16"
        except Exception:
            device = "cpu"
            compute_type = "int8"

    if is_render:
        model_name = "tiny.en" if use_english_only else "tiny"
        cpu_threads = 2
        beam_size = 1 if is_long_audio else 2
    else:
        model_name = "base.en" if use_english_only else "base"
        cpu_threads = min(8, os.cpu_count() or 4)
        beam_size = 1 if is_long_audio else 3

    loaded_model_name = model_name
    model = None
    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type, cpu_threads=cpu_threads)
    except Exception as first_err:
        # If CUDA DLLs (cuBLAS/cuDNN) are missing locally, fall back cleanly to CPU int8
        if device == "cuda":
            device = "cpu"
            compute_type = "int8"
            try:
                model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=cpu_threads)
            except Exception as cpu_err:
                first_err = cpu_err
        if model is None:
            fallback_name = "tiny.en" if use_english_only else "tiny"
            if model_name != fallback_name:
                try:
                    loaded_model_name = fallback_name
                    model = WhisperModel(fallback_name, device="cpu", compute_type="int8", cpu_threads=1)
                except Exception:
                    return None, None, None, f"Whisper model load error: {str(first_err)}"
            else:
                return None, None, None, f"Whisper model load error: {str(first_err)}"

    prompt_bits = ["Natural spoken conversation, livestream or podcast dialogue with proper punctuation."]
    clean_title = re.sub(r"[^\w\s,'-]", " ", title or "").strip()
    if clean_title:
        prompt_bits.append(f"Topic: {clean_title[:120]}.")
    initial_prompt = " ".join(prompt_bits)

    use_batched = is_long_audio
    segments_gen = None
    info = None
    mode_tag = f"{loaded_model_name}{'·GPU' if device == 'cuda' else ''}"

    if use_batched:
        try:
            from faster_whisper import BatchedInferencePipeline
            batched = BatchedInferencePipeline(model=model)
            batch_size = 16 if device == "cuda" else (4 if is_render else 8)
            batch_kwargs = dict(
                batch_size=batch_size,
                beam_size=1,
                best_of=1,
                temperature=0.0,
                condition_on_previous_text=False,
                no_speech_threshold=0.60,
                log_prob_threshold=-1.0,
                compression_ratio_threshold=2.4,
                repetition_penalty=1.1,
                without_timestamps=False,
                word_timestamps=False,
                vad_filter=True,
                vad_parameters=dict(threshold=0.42, min_speech_duration_ms=200, min_silence_duration_ms=350, speech_pad_ms=180),
                initial_prompt=initial_prompt,
            )
            if use_english_only:
                batch_kwargs["language"] = "en"
            segments_gen, info = batched.transcribe(wav_path, **batch_kwargs)
            mode_tag = f"{mode_tag}·Batched"
        except Exception:
            use_batched = False

    if not use_batched:
        transcribe_kwargs = dict(
            beam_size=beam_size,
            best_of=1,
            temperature=0.0 if is_long_audio else (0.0, 0.2),
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
            word_timestamps=not is_long_audio,
            initial_prompt=initial_prompt
        )
        if use_english_only:
            transcribe_kwargs["language"] = "en"
        segments_gen, info = model.transcribe(wav_path, **transcribe_kwargs)

    total_sec = max(1.0, float(getattr(info, "duration", 0.0) or wav_dur or 1.0))
    tot_str = format_ts(total_sec)
    emit_progress(20.0, f"Transcribing dialogue ({mode_tag}): 00:00 / {tot_str}")

    raw_segments = []
    for s in segments_gen:
        text_clean = (s.text or "").strip()
        if not is_hallucinated_line(
            text_clean,
            no_speech_prob=float(getattr(s, "no_speech_prob", 0.0) or 0.0),
            avg_logprob=float(getattr(s, "avg_logprob", 0.0) or 0.0)
        ):
            if not is_long_audio:
                sub_chunks = split_segment_by_words(s)
                for ch in sub_chunks:
                    if not is_hallucinated_line(ch["text"]):
                        raw_segments.append(ch)
            else:
                raw_segments.append({"raw_start": float(s.start), "raw_end": float(s.end), "text": text_clean})

        current_sec = min(total_sec, float(s.end))
        max_transcribe_pct = 86.0 if detect_speakers else 98.0
        pct = min(max_transcribe_pct, 20.0 + (current_sec / total_sec) * (max_transcribe_pct - 20.0))
        emit_progress(pct, f"Transcribing ({mode_tag}): {format_ts(current_sec)} / {tot_str}")

    return raw_segments, getattr(info, "language", language) or "en", mode_tag, None


def transcribe_audio(wav_path, start_offset_sec=0.0, detect_speakers=True, language="en", title="", platform="other", temp_base=""):
    groq_key = os.environ.get("GROQ_API_KEY", "").strip()
    raw_segments = None
    detected_lang = language or "en"
    loaded_model_name = ""
    source_tag = "whisper-ai"

    # Prefer Groq Cloud Whisper Large-v3-Turbo if GROQ_API_KEY is configured (~200x real-time!)
    if groq_key:
        g_segs, g_lang, g_err = transcribe_via_groq(wav_path, groq_key, language=language, title=title, temp_base=temp_base)
        if g_err is None and g_segs is not None:
            raw_segments = g_segs
            detected_lang = g_lang or detected_lang
            loaded_model_name = "groq/whisper-large-v3-turbo"
            source_tag = "groq-whisper"
        else:
            emit_progress(19.0, "Groq Turbo unavailable — falling back to local Whisper AI...")

    if raw_segments is None:
        emit_progress(18.0, "Loading Whisper AI neural model...")
        raw_segments, detected_lang, loaded_model_name, err_msg = transcribe_via_local_whisper(
            wav_path, language=language, title=title, detect_speakers=detect_speakers
        )
        if err_msg:
            return None, None, err_msg

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
        "language": detected_lang or "en",
        "model": loaded_model_name,
        "source": source_tag,
        "speakerCount": len(speakers_list),
        "speakers": speakers_list,
        "segments": formatted_segments
    }
    return "\n".join(formatted_lines), meta, None


def main():
    parser = argparse.ArgumentParser(description="Whisper AI + Low-Bandwidth Audio + Speaker Detection for ULT Downloader")
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

            # Cap long VODs or Render YouTube runs to first 60 seconds when no explicit range or Full flag is set
            if (is_vod or (is_render_host and is_yt)) and not start_time and (not end_time or not is_full):
                start_time = "00:00:00"
                end_time = "00:01:00"
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

        transcript, meta, err_msg = transcribe_audio(
            wav_path,
            start_offset_sec=start_offset_sec,
            detect_speakers=not args.no_speakers,
            language=args.language,
            title=args.title,
            platform=platform,
            temp_base=temp_base
        )
        if err_msg:
            print(json.dumps({"success": False, "error": err_msg, "platform": platform}))
            sys.exit(0)

        if not transcript or not transcript.strip():
            transcript = "No spoken words or dialogue detected in this video section."

        notice = None
        if auto_capped:
            notice = "Transcribed the first 60 seconds for fast AI + speaker analysis. Pick 30s, 1m, 2m, a custom range, or Full Stream for other sections."

        print(json.dumps({
            "success": True,
            "transcript": transcript,
            "segments": meta["segments"],
            "speakers": meta["speakers"],
            "speakerCount": meta["speakerCount"],
            "language": meta["language"],
            "model": meta["model"],
            "platform": platform,
            "source": meta["source"],
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
