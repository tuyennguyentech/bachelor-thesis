# Gemini response cassettes

This directory holds recorded Gemini responses ("cassettes") for the AI test
suite. It exists to solve one problem: the structured-generation pipeline
(transcript chunking + interaction-item generation) calls Gemini, and under the
parallel load of the E2E / integration suites that quickly exhausts the
free-tier per-minute and per-day quota — turning deterministic tests into flaky
"quota exceeded" failures.

## How it works

`internal/svc/ai/geminicache` is an on-disk cache keyed by
`sha256(model + prompt)`. When `ai.gemini_cache_dir` points here:

- **Cache hit** → the recorded response is replayed from disk, no network call,
  no quota spent.
- **Cache miss** → Gemini is called live, and a *successful, non-empty*
  response is recorded as `<sha256>.json`. Throttled/failed calls record
  nothing, so a cassette never masks a real response.

Because the test fixtures are deterministic (seed video → STT transcript →
prompt), a cassette recorded once stays valid until the model name or a prompt
template changes — at which point the key changes and the stale file is simply
never read again (a miss falls back to a live call). There is no invalidation
step and no expiry.

## Enabling it (opt-in)

It is **disabled by default everywhere** (`gemini_cache_dir = ""` in
`richter.base.toml`). Turn it on for a run that would otherwise burn quota by
pointing the knob at this directory — via env (preferred, no file edit):

```sh
RICHTER_AI_GEMINI_CACHE_DIR=<repo>/golang/richter/testdata/gemini-cassettes \
  go run ./golang/richter -c golang/richter/richter.base.toml,golang/richter/richter.test.toml
```

or in a local `richter.test.toml` (gitignored):

```toml
[ai]
# absolute path so it resolves regardless of the test process's cwd
gemini_cache_dir = "<repo>/golang/richter/testdata/gemini-cassettes"
```

## Why it is opt-in, not always-on

The cache is ideal for AI tests that assert on pipeline **state** (running /
done / recovered) — replay makes them deterministic *and* quota-free.

It is **deliberately off by default** because of one interaction: a test that
asserts on generated **content** (e.g. the `video-quiz-flow` "full pipeline"
test, which requires every interaction *type* to appear) freezes whatever the
first recording captured. Generation is non-deterministic and that heavy test
is already flaky on two axes (a render-timing race on the badge list, and a
concurrency race that can drop one item when all generations return instantly
from cache). Caching also **defeats Playwright `retries`** for it: once the
first attempt records an incomplete generation, every retry replays the same
incomplete data and fails identically. So enabling the cache there trades a
flaky-but-retry-passing test for a deterministic-failing one — a bad trade.

Enable the cache when you are iterating on the suite and want quota relief, and
warm it from a run you have confirmed passes. Leave it off for CI / final
validation so live generation + retries cover content-asserting tests.

## Warming / re-recording

1. Make sure Gemini quota is available.
2. Run the AI tests once with the cache dir set (they self-warm): the first
   successful chunking/generation call records its cassette here.
3. Commit the resulting `*.json` files so CI and other machines replay them and
   never spend quota.

To re-record after changing a prompt or the model: delete the affected `*.json`
(or all of them) and warm again.
