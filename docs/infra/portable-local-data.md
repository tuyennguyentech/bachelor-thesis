# Portable local data (`volumes/`)

The local stack keeps **all persistent data in bind mounts under `./volumes/`**
instead of anonymous/named podman volumes, so the entire pre-seeded dataset
travels with the repository folder. Hand the repo + `volumes/` to someone else
and they can run the project with the data already processed — no re-running the
AI pipeline.

## What lives where

| `volumes/` subdir | Container path | Contents |
|---|---|---|
| `postgres/` | postgres `/var/lib/postgresql` | all relational data (users, orgs, courses, lessons, chunks, interactions, attempts) |
| `seaweedfs/` | storage `/data` | uploaded lesson videos + generated TTS audio (S3 bucket `dyadia`) |
| `fdb-coordinator/`, `fdb-server-1/`, `fdb-server-2/` | `/var/fdb/data` | FoundationDB data (lesson transcripts + segments) |
| `caddy-data/`, `caddy-config/` | caddy `/data`, `/config` | Caddy local CA + autosave |
| `hf-cache/` | speaches `/home/ubuntu/.cache/huggingface/hub` | Whisper STT + Piper TTS model cache |

Mounts use `:U,Z` so podman re-chowns the data to the container user on each
machine (portable across different rootless UID maps) and relabels for SELinux.

**There are no named volumes** — everything, including the speaches model cache,
is a `volumes/` bind mount. The speaches image declares `USER ubuntu` (uid 1000),
so `:U` chowns the cache to 1000 and the runtime user can write it. Keeping the
cache in `volumes/` means the downloaded models travel with the dataset (no
re-download on a copied-in stack); on a brand-new empty dir, `speaches-init` pulls
them on first `up` (needs internet once).

`volumes/` is gitignored (large) — copy the folder separately.

> **Transfer size.** SeaweedFS pre-allocates its volume `.dat` files (≈1 GB each),
> so `volumes/seaweedfs` shows ~15 GB on disk while the *actual* content is only
> ~2 GB (`du --apparent-size volumes` to see the real size). Copy with a
> sparse-aware tool so you move the content, not the pre-allocated zeros:
> `rsync -aS volumes/ dest/`, or `tar --sparse -czf volumes.tgz volumes/`.

## Handing the project to someone else

They need three things:

1. **The repo** (tracked config travels with it: `.env`, `fdb.cluster`,
   `richter.base.toml`, `conf/`).
2. **The `volumes/` folder** (the pre-seeded data — copy it alongside the repo).
3. **The gitignored secret files** (they hold secrets, so they are not in git —
   hand them over with the data):
   - `golang/richter/richter.local.toml` — richter's DB/S3/Gemini settings +
     browser-facing storage `public_endpoint`.
   - `typescript/heino/.env.local` — heino's `JWT_SECRET` (must equal `[jwt].secret`
     in `richter.base.toml`). heino's public config (`RICHTER_BASE_URL`,
     `NEXT_PUBLIC_*`) is committed in `typescript/heino/.env`.

**Recommended run — pre-built images (no toolchain needed).** This is the fast path
for someone who just wants to run the seeded product; it pulls the public images
and needs only `podman` (see the README's "Run the app with the pre-seeded data").
CPU is fine — serving seeded data does no transcription:

```sh
podman compose -f compose.yml -f compose.dev.yml up -d
# GPU is optional (faster transcription of NEW uploads only): add -f compose.gpu.yml
```

**Alternative — run from source (development).** Only for active development. The
generated code and JS deps are gitignored, so regenerate/install them first (a code
build step, independent of the data), then run the apps as host processes:

```sh
buf generate                      # golang/buf/gen + typescript/buf/gen
sqlc generate                     # golang/sql/gen
./scripts/setup/environment.dev/container-shell.sh heino -- pnpm install

podman compose up -d              # infra only (richter/heino stay placeholders)
./scripts/setup/environment.dev/container-shell.sh richter -- \
  go run ./golang/richter/ -c golang/richter/richter.base.toml,golang/richter/richter.local.toml
./scripts/setup/environment.dev/container-shell.sh heino -- pnpm -F heino dev
```

Either way: because the FoundationDB data is copied in `volumes/fdb-*`, the cluster
comes up already configured — nothing to do, and the copied-in Postgres data dir is
already migrated. On a brand-new (empty) Postgres dir, run the goose migrations
explicitly — a developer step, not a sidecar (`container-shell.sh richter --
goose.sh dev up`). On a brand-new (empty) FDB data dir, FoundationDB starts
UNCONFIGURED and must be configured **once, at root**, by the operator (this is
intentionally not automated by a sidecar):

```sh
sudo podman exec dyadia-fdb-coordinator-1 fdbcli --exec "configure new single ssd"
```

Open the app at `http://localhost:8080` (or HTTPS at `https://localhost:8443` — a
self-signed local cert from Caddy's internal CA, so accept the browser warning
once). Log in as a seeded user (e.g. `carol@dyadia.local` / `Password123!`, teacher
of the demo course "Tự học Machine Learning").

## Ports & HTTPS (Caddy)

Caddy is the single entry point — one reverse proxy in front of everything. It
routes by path: `/api/richter/*` → `richter:8080`, `/api/storage/*` →
`storage:9000` (SeaweedFS S3), everything else → `heino:3000` (Next.js). The
browser therefore only ever talks to Caddy; `richter`/`storage` are never exposed
to it directly. Config: `conf/caddy/Caddyfile`.

| Access | Host port | Container port | Notes |
|---|---|---|---|
| HTTP  | `8080` | `80`  | Plain HTTP. Primary local URL. |
| HTTPS | `8443` | `443` | TLS from Caddy's **internal CA** (self-signed for `localhost`). |

- **Why 8080/8443 and not 80/443?** Both are unprivileged, so the stack runs
  rootless on any machine with **no `sysctl net.ipv4.ip_unprivileged_port_start`
  step** — it stays portable. Caddy still listens on `:80`/`:443` *inside* the
  container, so container-to-container traffic and the Playwright E2E suite (which
  use `http://caddy`) are unchanged; only the host publish differs.
- **The HTTPS cert is self-signed** (Caddy internal CA, persisted in
  `volumes/caddy-data`). Browsers show a one-time warning — accept it, or trust
  the root with `caddy trust`. There is no public domain in local dev.
- **Storage over HTTPS works on the same machine.** Presigned storage URLs use
  `public_endpoint = http://localhost:8080/...` (in `richter.local.toml`). On
  `https://localhost:8443` the browser still loads them because `http://localhost`
  is a *trustworthy origin* (secure-contexts spec) — not blocked as mixed content.
- **Remote access caveat.** If you expose the app to another machine (e.g. a
  VSCode-forwarded public URL), forward the **HTTP `8080`** port (the tunnel adds
  its own HTTPS) and set its visibility to *Public*. The app shell works, but
  lesson video/audio will not load remotely until `public_endpoint` points at the
  reachable public origin instead of `localhost` — presigned S3 signatures are
  bound to `storage:9000` (Caddy rewrites `Host`), so any reachable origin works.

## Rebuilding the data from scratch (reproducible)

A full clean rebuild — drop everything, recreate on `volumes/`, migrate, and run
the seed (real GPU Whisper + Gemini for the ML demo course) — is scripted:

```sh
# GPU (fast Whisper) by default; GPU=0 for CPU-only.
./scripts/setup/environment.dev/seed-reset.sh
```

`seed --dev` already includes the dense, diverse student attempts — generated
IN-PROCESS through the real submit flow (synthesized student auth → watch progress
→ SubmitAttempt), not a separate script and never a raw insert, so the teacher
analytics are consistent-by-construction.

The seed is **idempotent** end to end: re-running `seed --dev` skips
already-analyzed lessons, ON CONFLICT inserts, and upserts one attempt per
(student, lesson). To top up data without a destructive reset, skip
`seed-reset.sh` and run `seed --dev` directly against the running stack.

## Seeding goes through richter — no python touches the app

**All data that lands in the app is seeded by the Go `richter seed` command** —
never by a python script and never by a raw insert. The only remaining helper
scripts merely *acquire external assets* (download raw files); they do not write
to the database/S3/FDB.

| Command / script | Purpose | Touches the app? |
|---|---|---|
| `richter seed --dev` | Full dev seed: users, orgs, courses, lessons, real/fixture analysis, attempts (via the real submit flow) | Yes — the single app-seeding entry point |
| `richter seed gen-exercises --lesson-id … [--kinds …] [--force]` | (Re)generate exercises for one lesson in-process via the real generation service (was `gen-exercises.py`) | Yes — via richter |
| `richter seed gen-ml-spec` | (Re)generate the committed `tu-hoc-ml.json` + `videos.json` from the downloaded playlist videos (was `generate-ml-seed-data.py`) | No — writes source JSON only |
| `scripts/setup/environment.dev/seed-reset.sh` | Full clean rebuild on `volumes/` + `seed --dev` (runs goose migrations directly; waits for the operator to configure a fresh FDB at root) | Orchestration |
| `scripts/seed/download-ml-videos.py` | Download the ML playlist into `seed-assets/videos/ml/` (yt-dlp; idempotent). Pure acquisition — Go can't run yt-dlp | No — downloads files |
| `scripts/seed/download-assets.sh` | Download the small test/demo videos (idempotent) | No — downloads files |

Student **attempts are not a script** — they are seeded in-process by `seed --dev`
(`golang/richter/internal/seed/dev_attempts.go`) through the real submit flow.
