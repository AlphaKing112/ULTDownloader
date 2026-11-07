import sys
import os
import argparse
import tempfile
import json
import subprocess

def transcribe_audio(file_path):
    from faster_whisper import WhisperModel
    # Load model with int8 quantization on CPU - fast and low memory
    model = WhisperModel("base.en", device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        file_path,
        beam_size=5,
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
    args = parser.parse_args()

    source = args.source.strip()
    is_url = source.startswith("http://") or source.startswith("https://")
    temp_audio = None

    try:
        if is_url:
            # Extract lightweight audio using yt-dlp
            temp_dir = tempfile.gettempdir()
            temp_base = os.path.join(temp_dir, f"ult_whisper_{os.getpid()}")
            temp_audio = f"{temp_base}.mp3"

            ytdlp_cmd = ["yt-dlp", "--no-warnings", "-x", "--audio-format", "mp3", "-o", f"{temp_base}.%(ext)s"]
            
            # If user specified a section for long VODs
            if args.start and args.end:
                ytdlp_cmd.extend(["--download-sections", f"*{args.start}-{args.end}"])
            elif args.start:
                ytdlp_cmd.extend(["--download-sections", f"*{args.start}-inf"])
                
            if "kick.com" in source.lower():
                ytdlp_cmd.extend(["--impersonate", "Chrome"])

            ytdlp_cmd.append(source)
            
            # Execute yt-dlp to extract audio
            proc = subprocess.run(ytdlp_cmd, capture_output=True, text=True, timeout=120)
            if proc.returncode != 0 and not os.path.exists(temp_audio):
                err = proc.stderr.strip().split("\n")[-1] or "Audio download failed"
                print(json.dumps({"success": False, "error": f"yt-dlp error: {err}"}))
                sys.exit(1)

            target_file = temp_audio
        else:
            target_file = source

        if not os.path.exists(target_file):
            print(json.dumps({"success": False, "error": "Extracted audio file not found"}))
            sys.exit(1)

        transcript, language = transcribe_audio(target_file)
        if not transcript.strip():
            transcript = "No spoken words or dialogue detected in this video section."

        print(json.dumps({"success": True, "transcript": transcript, "language": language}))

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

