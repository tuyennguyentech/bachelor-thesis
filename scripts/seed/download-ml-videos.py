#!/usr/bin/env python3
"""
Download the Machine Learning course playlist into seed-assets/videos/ml.

Uses yt-dlp (with a Node JS runtime for YouTube signature solving) and remuxes to
MP4. Idempotent: a lesson whose NN- prefixed file already exists is skipped, so the
script is safe to re-run after a partial download or a fresh clone.

Prerequisites (install yourself — the script does not install anything):
  - yt-dlp            : pipx install yt-dlp   (or pip install -U yt-dlp)
  - node              : the yt-dlp `--js-runtimes node` flag needs Node on PATH
  - ffmpeg            : for --merge-output-format mp4

Configuration (environment variables, all optional):
  ML_PLAYLIST_URL     : YouTube playlist URL (default: the course playlist below)
  ML_OUTPUT_DIR       : destination dir       (default: seed-assets/videos/ml)
  ML_MAX_HEIGHT       : max video height px   (default: 360 — keep seed files small)

Run from the project root:
  python3 scripts/seed/download-ml-videos.py
"""

import os
import re
import sys
import glob
import json
import shutil
import subprocess
import unicodedata

DEFAULT_PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLaKukjQCR56ZRh2cAkweftiZCF2sTg11_"

PLAYLIST_URL = os.environ.get("ML_PLAYLIST_URL", DEFAULT_PLAYLIST_URL)
OUTPUT_DIR = os.environ.get("ML_OUTPUT_DIR", "seed-assets/videos/ml")
MAX_HEIGHT = os.environ.get("ML_MAX_HEIGHT", "360")


def die(msg, detail=""):
    print(f"ERROR: {msg}", file=sys.stderr)
    if detail:
        print(detail, file=sys.stderr)
    sys.exit(1)


def require_tool(name, install_hint):
    if shutil.which(name) is None:
        die(f"'{name}' not found on PATH.", f"Install it first: {install_hint}")


def slugify(text):
    # Strip the recurring course-title boilerplate to get concise filenames.
    for junk in (
        "Tự học Machine Learning |",
        "| Thân Quang Khoát",
        "Self-Learning Machine Learning |",
        "| Than Quang Khoat",
        "Self-study Machine Learning |",
    ):
        text = text.replace(junk, "")
    text = text.replace("đ", "d").replace("Đ", "d")
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("utf-8")
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def main():
    require_tool("yt-dlp", "pipx install yt-dlp   (or: pip install -U yt-dlp)")
    require_tool("node", "install Node.js (https://nodejs.org) — needed by yt-dlp --js-runtimes node")
    require_tool("ffmpeg", "install ffmpeg from your package manager")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"Fetching playlist metadata: {PLAYLIST_URL}")
    meta_cmd = [
        "yt-dlp", "--js-runtimes", "node",
        "--flat-playlist", "--dump-single-json",
        PLAYLIST_URL,
    ]
    try:
        result = subprocess.run(meta_cmd, capture_output=True, text=True, check=True)
        playlist = json.loads(result.stdout)
    except subprocess.CalledProcessError as e:
        die("yt-dlp failed to fetch playlist metadata.", (e.stderr or "").strip())
    except json.JSONDecodeError as e:
        die("Could not parse yt-dlp JSON output.", str(e))

    entries = playlist.get("entries", [])
    if not entries:
        die("No videos found in the playlist (is the URL correct / public?).")

    print(f"Found {len(entries)} videos in the playlist.")
    failures = []

    for idx, entry in enumerate(entries, start=1):
        video_id = entry.get("id")
        title = entry.get("title", "")
        if not video_id:
            print(f"[{idx}/{len(entries)}] Skip: entry has no video id")
            continue

        # Idempotency: skip if ANY file with this lesson's NN- prefix already exists,
        # regardless of the exact slug (the committed files may use a different slug).
        existing = sorted(glob.glob(os.path.join(OUTPUT_DIR, f"{idx:02d}-*.mp4")))
        if existing:
            print(f"[{idx}/{len(entries)}] Skip: '{os.path.basename(existing[0])}' already present")
            continue

        dest_path = os.path.join(OUTPUT_DIR, f"{idx:02d}-{slugify(title)}.mp4")
        print(f"\n[{idx}/{len(entries)}] Downloading: '{title}'\n  -> {dest_path}")

        # Prefer <=MAX_HEIGHT mp4 to keep seed files small; fall back progressively.
        fmt_primary = (
            f"bestvideo[height<={MAX_HEIGHT}][ext=mp4]+bestaudio[ext=m4a]/"
            f"best[height<={MAX_HEIGHT}][ext=mp4]/best[height<=720][ext=mp4]/best"
        )
        download_cmd = [
            "yt-dlp", "--js-runtimes", "node",
            "-f", fmt_primary,
            "--merge-output-format", "mp4",
            "-o", dest_path,
            f"https://www.youtube.com/watch?v={video_id}",
        ]
        try:
            subprocess.run(download_cmd, check=True)
            print(f"  OK: {os.path.basename(dest_path)}")
            continue
        except subprocess.CalledProcessError as e:
            print(f"  primary format failed ({e}); retrying with permissive format...", file=sys.stderr)

        fallback_cmd = [
            "yt-dlp", "--js-runtimes", "node",
            "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "--merge-output-format", "mp4",
            "-o", dest_path,
            f"https://www.youtube.com/watch?v={video_id}",
        ]
        try:
            subprocess.run(fallback_cmd, check=True)
            print(f"  OK (fallback): {os.path.basename(dest_path)}")
        except subprocess.CalledProcessError as e:
            print(f"  FAILED: {title} ({video_id}): {e}", file=sys.stderr)
            failures.append((idx, title, video_id))

    print(f"\nDone. Downloaded into {OUTPUT_DIR}.")
    if failures:
        print(f"{len(failures)} video(s) failed — re-run to retry (idempotent):", file=sys.stderr)
        for idx, title, vid in failures:
            print(f"  [{idx}] {title} ({vid})", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
