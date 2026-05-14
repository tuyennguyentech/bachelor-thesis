# testdata

Test fixtures for integration tests.

## edu-sample.mp4

A synthetic ~14-second educational lecture about binary search, generated from TTS audio.
Used by `TestAIPipelineFullFlow` to test the full Gemini AI pipeline.

**Not tracked in git** (binary file). Regenerate with:

```sh
espeak-ng -v en-us+f3 -s 150 -p 50 \
  "Binary search is an efficient algorithm for finding elements in a sorted array. It works by dividing the search interval in half each step. The time complexity is O log n, making it much faster than linear search." \
  --stdout 2>/dev/null | ffmpeg -y \
  -f s16le -ar 22050 -ac 1 -i pipe:0 \
  -f lavfi -i "color=c=0x1a1a2e:s=640x360" \
  -map 1:v -map 0:a \
  -shortest \
  -c:v mpeg4 -q:v 5 \
  -c:a aac -b:a 64k \
  -pix_fmt yuv420p \
  golang/richter/testdata/edu-sample.mp4
```

Run from the repository root. Requires `espeak-ng` and `ffmpeg`.
