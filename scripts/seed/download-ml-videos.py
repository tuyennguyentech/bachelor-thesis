#!/usr/bin/env python3
"""
Download Machine Learning course videos into seed-assets/videos/ml.
Uses yt-dlp to download and convert to MP4 format.
"""

import os
import sys
import json
import subprocess
import re
import unicodedata

PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLaKukjQCR56ZRh2cAkweftiZCF2sTg11_"
OUTPUT_DIR = "seed-assets/videos/ml"

def slugify(text):
    # Strip common parts of the course titles to get clean, concise filenames
    text = text.replace("Tự học Machine Learning |", "")
    text = text.replace("| Thân Quang Khoát", "")
    text = text.replace("Self-Learning Machine Learning |", "")
    text = text.replace("| Than Quang Khoat", "")
    text = text.replace("Self-study Machine Learning |", "")
    
    # Replace Vietnamese 'đ/Đ'
    text = text.replace('đ', 'd').replace('Đ', 'd')
    
    # Normalize unicode to convert accented characters to ascii equivalents
    text = unicodedata.normalize('NFKD', text)
    text = text.encode('ascii', 'ignore').decode('utf-8')
    
    # Convert to lowercase
    text = text.lower()
    
    # Replace any non-alphanumeric character sequences with a hyphen
    text = re.sub(r'[^a-z0-9]+', '-', text)
    
    return text.strip('-')

def main():
    # Make sure output directory exists
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    print("Fetching playlist metadata using yt-dlp...")
    # Fetching list of videos with metadata in JSON format
    cmd = [
        "yt-dlp",
        "--js-runtimes", "node",
        "--flat-playlist",
        "--dump-single-json",
        PLAYLIST_URL
    ]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        playlist = json.loads(result.stdout)
    except Exception as e:
        print(f"Error fetching playlist metadata: {e}", file=sys.stderr)
        if hasattr(e, 'stderr') and e.stderr:
            print(f"Details: {e.stderr}", file=sys.stderr)
        sys.exit(1)
        
    entries = playlist.get("entries", [])
    if not entries:
        print("No videos found in the playlist.", file=sys.stderr)
        sys.exit(1)
        
    print(f"Found {len(entries)} videos in the playlist.")
    
    for idx, entry in enumerate(entries, start=1):
        video_id = entry.get("id")
        title = entry.get("title", "")
        if not video_id:
            continue
            
        slug = slugify(title)
        filename = f"{idx:02d}-{slug}.mp4"
        dest_path = os.path.join(OUTPUT_DIR, filename)
        
        if os.path.exists(dest_path):
            print(f"[{idx}/{len(entries)}] Skip: '{filename}' already exists")
            continue
            
        print(f"\n[{idx}/{len(entries)}] Downloading: '{title}'")
        print(f"Target file: {dest_path}")
        
        # Download options:
        # - Target best MP4 or merge/remux to mp4 format
        # - Keep resolution <= 360p for seed data to avoid massive files and long download times.
        #   If not found, fallback to 720p or whatever is available, and merge/remux to mp4.
        download_cmd = [
            "yt-dlp",
            "--js-runtimes", "node",
            "-f", "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best[height<=720][ext=mp4]/best",
            "--merge-output-format", "mp4",
            "-o", dest_path,
            f"https://www.youtube.com/watch?v={video_id}"
        ]
        
        try:
            subprocess.run(download_cmd, check=True)
            print(f"Successfully downloaded: {filename}")
        except subprocess.CalledProcessError as e:
            print(f"Failed to download video {video_id}: {e}", file=sys.stderr)
            print("Retrying with simple fallback format configuration...")
            fallback_cmd = [
                "yt-dlp",
                "--js-runtimes", "node",
                "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
                "--merge-output-format", "mp4",
                "-o", dest_path,
                f"https://www.youtube.com/watch?v={video_id}"
            ]
            try:
                subprocess.run(fallback_cmd, check=True)
                print(f"Successfully downloaded (fallback): {filename}")
            except Exception as fe:
                print(f"Fallback also failed for video {video_id}: {fe}", file=sys.stderr)

    print("\nAll downloads finished!")

if __name__ == "__main__":
    main()
