import sys
import os
import argparse
import tempfile
import json
import subprocess
import re

def transcribe_audio(file_path):
    from faster_whisper import WhisperModel
    # Utilize available CPU threads for high performance (user has 24 threads)
    cpu_threads = min(12, os.cpu_count() or 4)
    model = WhisperModel("base.en", device="cpu", compute_type="int8", cpu_threads=cpu_threads)
    
    # beam_size=1 (greedy search) is 2.5x-3x faster than beam_size=5 with essentially identical accuracy for English
    segments, info = model.transcribe(
        file_path,
        beam_size=1,
        best_of=1,
        temperature=0.0,
        vad_filter=True, # Voice activity detection filters out silence/hallucinations
        vad_parameters=dict(min_silence_duration_ms=500)
    )
    
    lines = []
    for s in segments:
        m_s, s_s = int(s.start // 60), int(s.start % 60)
        h_s = int(m_s // 60)
        m_s = int(m_s % 60)

        m_e, s_e = int(s.end // 60), int(s.end % 60)
        h_e = int(m_e // 60)
        m_e = int(m_e % 60)

        start_str = f"{h_s:02d}:{m_s:02d}:{s_s:02d}" if h_s > 0 else f"{m_s:02d}:{s_s:02d}"
        end_str = f"{h_e:02d}:{m_e:02d}:{s_e:02d}" if h_e > 0 else f"{m_e:02d}:{s_e:02d}"
        
        text = s.text.strip()
        if text:
            lines.append(f"[{start_str} - {end_str}] {text}")
            
    return "\n".join(lines), info.language

def main():
    parser = argparse.ArgumentParser(description="Local Whisper Transcription for ULT Downloader")
    parser.add_argument("source", help="Media URL or local file path")
    parser.add_argument("--start", help="Start time (HH:MM:SS)", default="")
    parser.add_argument("--end", help="End time (HH:MM:SS)", default="")
    parser.add_argument("--full", help="Force transcribe full video/VOD", action="store_true")
    args = parser.parse_args()

    source = args.source.strip()
    is_url = source.startswith("http://") or source.startswith("https://")
    temp_audio = None

    try:
        if is_url:
            # Detect whether this is a long VOD (Twitch / Kick VOD)
            is_vod = bool(re.search(r'twitch\.tv/videos/\d+|kick\.com/video/|kick\.com/[^/]+/videos/', source, re.I))
            start_time = args.start.strip()
            end_time = args.end.strip()
            is_full = args.full or end_time.lower() in ("full", "all", "inf")
            auto_capped = False

            # If user submitted a long VOD without any range and didn't check "Full VOD":
            # Default to first 5 minutes to prevent 45+ minute CPU freeze on a 6-9 hour VOD!
            if is_vod and not start_time and (not end_time or not is_full):
                start_time = "00:00:00"
                end_time = "00:05:00"
                auto_capped = True

            temp_dir = tempfile.gettempdir()
            temp_base = os.path.join(temp_dir, f"ult_whisper_{os.getpid()}")
            temp_audio = f"{temp_base}.mp3"

            ytdlp_cmd = [
                "yt-dlp", "--no-warnings", "-x", "--audio-format", "mp3",
                "--concurrent-fragments", "5",
                "-o", f"{temp_base}.%(ext)s"
            ]
            
            # Apply section targeting if range is specified and not full VOD
            if start_time and end_time and not is_full:
                ytdlp_cmd.extend(["--download-sections", f"*{start_time}-{end_time}"])
            elif start_time and not is_full:
                ytdlp_cmd.extend(["--download-sections", f"*{start_time}-inf"])
                
            if "kick.com" in source.lower():
                ytdlp_cmd.extend(["--impersonate", "Chrome"])

            ytdlp_cmd.append(source)
            
            # Execute yt-dlp to extract lightweight audio
            proc = subprocess.run(ytdlp_cmd, capture_output=True, text=True, timeout=180)
            if proc.returncode != 0 and not os.path.exists(temp_audio):
                err = proc.stderr.strip().split("\n")[-1] or "Audio download failed"
                print(json.dumps({"success": False, "error": f"yt-dlp error: {err}"}))
                sys.exit(1)

            target_file = temp_audio
        else:
            target_file = source
            auto_capped = False

        if not os.path.exists(target_file):
            print(json.dumps({"success": False, "error": "Extracted audio file not found"}))
            sys.exit(1)

        transcript, language = transcribe_audio(target_file)
        if not transcript.strip():
            transcript = "No spoken words or dialogue detected in this video section."

        notice = None
        if auto_capped:
            notice = "Transcribed the first 5 minutes of VOD for fast response. Use the range presets (15m, 30m, or Full) for longer sections."

        print(json.dumps({
            "success": True,
            "transcript": transcript,
            "language": language,
            "notice": notice
        }))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
    finally:
        # Cleanup temp audio
        if temp_audio and os.path.exists(temp_audio):
            try:
                os.remove(temp_audio)
            except Exception:
                pass

if __name__ == "__main__":
    main()
