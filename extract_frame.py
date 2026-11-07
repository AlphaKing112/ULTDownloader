#!/usr/bin/env python3
"""
extract_frame.py - Extract high-resolution thumbnail frames from YouTube, Twitch, or Kick at exact timestamps.
"""

import sys
import os
import re
import json
import base64
import argparse
import subprocess
from pathlib import Path

def parse_time_to_seconds(time_str):
    if not time_str:
        return 0
    time_str = str(time_str).strip()
    if re.match(r'^\d+(\.\d+)?$', time_str):
        return float(time_str)
    parts = time_str.split(':')
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        elif len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        elif len(parts) == 1:
            return float(parts[0])
    except ValueError:
        return 0
    return 0

def format_seconds_to_hhmmss(seconds):
    total = max(0, int(seconds or 0))
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    return f"{h:02d}:{m:02d}:{s:02d}"

def extract_yt_id(url):
    match = re.search(r'(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})', url)
    return match.group(1) if match else None

def get_base_ytdlp_cmd(url):
    cmd = ["yt-dlp", "--no-warnings"]
    url_lower = url.lower()
    
    if "kick.com" in url_lower:
        cmd.extend(["--impersonate", "Chrome"])
    elif "youtube.com" in url_lower or "youtu.be" in url_lower:
        cmd.extend(["--force-ipv4", "--concurrent-fragments", "5"])
        # Check if cookies exist
        cookies_txt = Path(__file__).parent / "cookies.txt"
        if cookies_txt.exists():
            cmd.extend(["--cookies", str(cookies_txt)])
        elif os.environ.get("YOUTUBE_COOKIES"):
            cmd.extend(["--cookies", str(Path(__file__).parent / "cookies_env.txt")])
        else:
            cmd.extend(["--extractor-args", "youtube:player_client=android_vr"])
    return cmd

def main():
    parser = argparse.ArgumentParser(description="Extract video frame at timestamp as JPG thumbnail")
    parser.add_argument("url", help="Media video URL (YouTube, Twitch, Kick)")
    parser.add_argument("-t", "--timestamp", default="", help="Timestamp (e.g. 01:24:32 or seconds)")
    parser.add_argument("-o", "--output", default="", help="Output JPG path")
    parser.add_argument("--title", default="", help="Video title for naming")
    parser.add_argument("--json", action="store_true", help="Output JSON on stdout")
    parser.add_argument("--base64", action="store_true", help="Include base64 data URI in JSON")
    args = parser.parse_args()

    url = args.url.strip()
    if not url:
        res = {"success": False, "error": "No URL provided"}
        if args.json:
            print(json.dumps(res))
        else:
            print("Error: No URL provided", file=sys.stderr)
        sys.exit(1)

    url_lower = url.lower()
    is_yt = "youtube.com" in url_lower or "youtu.be" in url_lower
    is_twitch = "twitch.tv" in url_lower
    is_kick = "kick.com" in url_lower

    seconds = parse_time_to_seconds(args.timestamp)
    time_str = format_seconds_to_hhmmss(seconds)

    # Output directory setup
    downloads_dir = Path(__file__).parent / "downloads"
    thumb_dir = downloads_dir / "thumbnails"
    thumb_dir.mkdir(parents=True, exist_ok=True)

    safe_title = re.sub(r'[^A-Za-z0-9_-]+', '_', args.title.strip() if args.title else "thumbnail").strip('_')
    if not safe_title:
        safe_title = "thumbnail"

    time_tag = time_str.replace(':', '-')
    output_filename = f"{safe_title}_{time_tag}.jpg"
    output_path = Path(args.output) if args.output else thumb_dir / output_filename
    output_path.parent.mkdir(parents=True, exist_ok=True)

    success = False
    error_msg = ""

    # 1. Fast path for YouTube default cover thumbnail if no timestamp given or timestamp is 00:00:00
    if is_yt and (not args.timestamp or seconds == 0):
        yt_id = extract_yt_id(url)
        if yt_id:
            import urllib.request
            maxres_url = f"https://img.youtube.com/vi/{yt_id}/maxresdefault.jpg"
            hq_url = f"https://img.youtube.com/vi/{yt_id}/hqdefault.jpg"
            try:
                urllib.request.urlretrieve(maxres_url, str(output_path))
                # Check if it was 404 placeholder (size < 2000 bytes)
                if output_path.stat().st_size < 2000:
                    urllib.request.urlretrieve(hq_url, str(output_path))
                if output_path.exists() and output_path.stat().st_size > 500:
                    success = True
            except Exception as e:
                pass

    # 2. Extract frame at specific timestamp using yt-dlp stream URL + ffmpeg
    if not success:
        ytdlp_cmd = get_base_ytdlp_cmd(url)
        ytdlp_cmd.extend(["-g", "-f", "bestvideo[height<=1080]/best[height<=1080]/best", url])

        try:
            stream_proc = subprocess.run(ytdlp_cmd, capture_output=True, text=True, timeout=25)
            stream_lines = [l.strip() for l in stream_proc.stdout.splitlines() if l.strip().startswith("http")]
            
            if stream_lines:
                stream_url = stream_lines[0]
                # Seek with ffmpeg
                ff_cmd = [
                    "ffmpeg",
                    "-ss", time_str,
                    "-i", stream_url,
                    "-frames:v", "1",
                    "-q:v", "2",
                    "-update", "1",
                    str(output_path),
                    "-y"
                ]
                ff_proc = subprocess.run(ff_cmd, capture_output=True, text=True, timeout=25)
                if output_path.exists() and output_path.stat().st_size > 1000:
                    success = True
                else:
                    error_msg = ff_proc.stderr[:300] or "FFmpeg could not capture frame from stream URL"
            else:
                error_msg = stream_proc.stderr[:300] or "Could not extract stream URL via yt-dlp"
        except subprocess.TimeoutExpired:
            error_msg = "Stream URL extraction timed out"
        except Exception as e:
            error_msg = str(e)

    # 3. Fallback: Download a 2-second snippet via yt-dlp --download-sections, then extract frame
    if not success:
        temp_clip = thumb_dir / f"temp_{os.getpid()}_{int(seconds)}.mp4"
        snippet_start = time_str
        snippet_end = format_seconds_to_hhmmss(seconds + 2)
        fallback_cmd = get_base_ytdlp_cmd(url)
        fallback_cmd.extend([
            "--download-sections", f"*{snippet_start}-{snippet_end}",
            "--force-keyframes-at-cuts",
            "-f", "bestvideo[height<=1080]/best",
            "-o", str(temp_clip),
            url
        ])

        try:
            fb_proc = subprocess.run(fallback_cmd, capture_output=True, text=True, timeout=40)
            if temp_clip.exists():
                ff_cmd = [
                    "ffmpeg",
                    "-ss", "00:00:00.5",
                    "-i", str(temp_clip),
                    "-frames:v", "1",
                    "-q:v", "2",
                    "-update", "1",
                    str(output_path),
                    "-y"
                ]
                subprocess.run(ff_cmd, capture_output=True, text=True, timeout=15)
                if output_path.exists() and output_path.stat().st_size > 1000:
                    success = True
            if temp_clip.exists():
                try:
                    temp_clip.unlink()
                except OSError:
                    pass
        except Exception as e:
            error_msg = f"{error_msg} | Fallback error: {str(e)}"

    if not success or not output_path.exists():
        result = {
            "success": False,
            "error": error_msg or "Failed to extract thumbnail frame at the specified timestamp."
        }
        if args.json:
            print(json.dumps(result))
        else:
            print(f"Error: {result['error']}", file=sys.stderr)
        sys.exit(1)

    result = {
        "success": True,
        "outputPath": str(output_path),
        "filename": output_path.name,
        "timestamp": time_str,
        "seconds": seconds,
        "size": output_path.stat().st_size
    }

    if args.base64:
        with open(output_path, "rb") as f:
            encoded = base64.b64encode(f.read()).decode("utf-8")
            result["dataUri"] = f"data:image/jpeg;base64,{encoded}"

    if args.json:
        print(json.dumps(result))
    else:
        print(f"[Success] Extracted thumbnail frame at {time_str} saved to: {output_path}")

if __name__ == "__main__":
    main()
