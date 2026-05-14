#!/usr/bin/env bash
# Download seed asset videos into seed-assets/videos/.
# Run once from the project root before running `richter seed`.
# Files are gitignored; re-run this script after a fresh clone.
set -euo pipefail

VIDEOS_DIR="seed-assets/videos"
mkdir -p "$VIDEOS_DIR"

declare -A VIDEOS=(
  ["big-buck-bunny.mp4"]="https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4"
  ["elephants-dream.mp4"]="https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4"
  ["sintel.mp4"]="https://archive.org/download/Sintel/sintel-2048-surround.mp4"
)

for filename in "${!VIDEOS[@]}"; do
  dest="$VIDEOS_DIR/$filename"
  if [[ -f "$dest" ]]; then
    echo "skip: $filename already exists"
    continue
  fi
  echo "downloading: $filename ..."
  curl -L "${VIDEOS[$filename]}" -o "$dest" --progress-bar
done

echo ""
echo "done:"
ls -lh "$VIDEOS_DIR"
