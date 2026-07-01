# Dyadia

AI-assisted learning platform (Bachelor Thesis). Monorepo:

- **`richter`** — Go backend (Connect RPC, PostgreSQL, FoundationDB, SeaweedFS S3, Gemini, Whisper/Piper via Speaches).
- **`heino`** — Next.js 16 frontend.
- **infra** — PostgreSQL, FoundationDB, SeaweedFS, Caddy (reverse proxy), Speaches (STT/TTS), all via `podman compose`.

---

## Run the app with the pre-seeded data

This is the fast path for someone who just wants to **run Dyadia with the demo
dataset already processed** (the "Tự học Machine Learning" course — 24 lessons,
transcripts, AI-generated exercises, and ~558 student attempts). Nothing is
re-processed: the data travels in `.volumes/` and the apps run as containers.

### Prerequisites

- `podman` + `podman compose` (rootless is fine). See `docs/infra/podman-gpu.md`
  if you want GPU for new transcriptions — **not needed** to serve seeded data.
- The **`.volumes/` data folder** (the pre-seeded dataset — handed over
  separately; it is gitignored). Either copy it into the repo, or symlink it.
- The **gitignored config files** (handed over with the data — the only config not
  in git): `golang/richter/richter.local.toml` and `typescript/heino/.env`.
- Ports **8080** (HTTP) and **8443** (HTTPS) free — Caddy is published on these
  unprivileged host ports, so there is no `sysctl`/low-port setup needed, even
  rootless.

### Steps (run pre-built images)

```sh
# 1. Get the repo (clone or copy).
git clone <repo> dyadia && cd dyadia

# 2. Drop in the gitignored config files (NOTHING is hardcoded in compose — the
#    apps read these centralized files, exactly as when running locally):
cp /path/to/richter.local.toml golang/richter/richter.local.toml
cp /path/to/heino.env          typescript/heino/.env

# 3. Provide the pre-seeded data — symlink OR copy the .volumes folder:
ln -s /path/to/.volumes .volumes        # symlink (share data in place), or:
# rsync -aS /path/to/.volumes/ .volumes/ # copy (sparse-aware; ~2 GB real content)

# 4. Run — CPU is fine (serving seeded data needs no GPU). compose.dev.yml PULLS
#    the images (it does not build them):
podman compose -f compose.yml -f compose.dev.yml up -d
```

> **GPU is optional** — only needed to transcribe *new* uploads faster. To enable
> it, add the overlay: `-f compose.gpu.yml` (requires nvidia-container-toolkit +
> CDI — see [docs/infra/podman-gpu.md](docs/infra/podman-gpu.md)).

The images are published at **`quay.io/tuyennguyentech/bachelor-thesis/richter:0.0.2`**
and **`.../heino:0.0.2`** — the defaults in `.env` (`DYADIA_RICHTER_IMAGE` /
`DYADIA_HEINO_IMAGE`). `compose.dev.yml` runs them and **mounts the config in** —
`richter` gets `richter.base.toml` + `richter.local.toml` (`-c`) + `fdb.cluster`;
`heino` runs the Next standalone server and reads `typescript/heino/.env`. No
config is injected in the compose files; everything comes from the centralized
files above. (Pulling needs the quay repo to be public, or `podman login quay.io`.)

Open **http://localhost:8080** (or HTTPS **https://localhost:8443** — a
self-signed local cert, so accept the browser warning once) and log in with a
seeded account:

| Suggested account | Email | Password | What it demonstrates |
|---|---|---|---|
| Teacher — owns the flagship ML course | `carol@dyadia.local` | `Password123!` | Teacher analytics on rich data (24 lessons, ~558 attempts) |
| Student — enrolled in the ML course | `an@dyadia.local` | `Password123!` | Student flow: video + checkpoints + results (member of 3 orgs) |
| Multi-org user — **owner / admin / teacher / student** across 6 orgs | `alice@dyadia.local` | `Password123!` | Per-organization role scoping |
| System admin | `admin@dyadia.local` | `changeme123` | Admin console: all users, orgs, and AI tasks |

> The seed has **~40 users across 8 organizations**. All regular users share the
> password `Password123!` (admin uses `changeme123`). **Most users belong to
> several organizations with a different role in each** (owner, admin, teacher, or
> student) — e.g. log in as `alice` to see one account own one org, administer
> another, teach in several, and learn as a student in yet another.

> **FoundationDB note.** A copied/symlinked `.volumes/fdb-*` is already
> configured — nothing to do. Only a **brand-new, empty** FDB data dir needs a
> one-time configure, run at root:
> `sudo podman exec dyadia-fdb-coordinator-1 fdbcli --exec "configure new single ssd"`.
> Postgres migrations run automatically (the `migrate` init container).

### Stopping

```sh
podman compose -f compose.yml -f compose.dev.yml down
```

`.volumes/` is never deleted by `down`/`rm` (it is a bind mount / symlink). See
[docs/infra/portable-local-data.md](docs/infra/portable-local-data.md) for the
full data-portability details (transfer size, ownership, etc.).

### Build & push the images (maintainers)

Consumers above just **run** pulled images. To build and publish them, use
`compose.build.yml` (build only — no runtime config):

```sh
# Image refs + all build-tool versions live in .env (DYADIA_*). Then:
podman compose -f compose.yml -f compose.build.yml build      # build both images
podman compose -f compose.yml -f compose.build.yml push       # push to the registry
```

The Dockerfiles (`golang/richter/Dockerfile`, `typescript/heino/Dockerfile`) are
multi-stage and run **code generation themselves** (`buf generate` + `sqlc
generate`), so a fresh checkout with no generated code builds cleanly. Both ship
as small production images:

- **richter** (~88 MB): latest Go (CGO + FoundationDB C client) → stripped binary
  on **distroless/cc**.
- **heino** (~190 MB): `next build` with `output: "standalone"` → **distroless/nodejs**
  running `node server.js` (no pnpm/devDeps at runtime — the official, smallest way
  to ship Next.js). To build it, `typescript/heino/.env` must be present (its
  `NEXT_PUBLIC_*` is inlined at build time).

Build-tool versions (Go/Node/buf/sqlc/pnpm/FDB) are single-sourced in `.env` and
passed to the Dockerfiles as build args.

---

## Develop (host-process loop)

For active development you usually run the apps as **host processes** (fast
rebuilds, no image build) joined to the container network namespace. Here the
base `compose.yml` keeps `richter`/`heino` as lightweight placeholders and you
run the real processes via `container-shell.sh`:

```sh
podman compose up -d                                   # infra only (placeholders for richter/heino)
./scripts/setup/environment.dev/container-shell.sh richter -- \
  go run ./golang/richter -c golang/richter/richter.base.toml,golang/richter/richter.local.toml
./scripts/setup/environment.dev/container-shell.sh heino -- pnpm -F heino dev
```

`compose.dev.yml` is the opt-in overlay that **replaces those placeholders with
the built container images** (the run-with-seed-data path above). See
`CLAUDE.md` for the full development workflow, build/codegen commands, and test
instructions.

## Rebuild the seed data from scratch

**All seeding goes through the Go `richter seed` command (idempotent); no Python
touches the app.** The only Python is *asset acquisition* (downloading raw videos).

```sh
# 1. (ML course only) Acquire source assets — these are gitignored, not in the repo:
./scripts/seed/download-assets.sh              # small demo videos (curl, idempotent)
python3 scripts/seed/download-ml-videos.py     # ML playlist via yt-dlp (idempotent)
#   then regenerate the committed ML course spec from the downloaded videos:
richter seed gen-ml-spec                       # → tu-hoc-ml.json + videos.json

# 2. Full clean rebuild on .volumes + seed (GPU Whisper + Gemini for the ML course):
GPU=1 ./scripts/setup/environment.dev/seed-reset.sh    # GPU=0 for CPU-only

# Or, to top up without a destructive reset (idempotent — skips analyzed lessons,
# upserts one attempt per student/lesson):
richter seed --dev
#   manual exercise (re)gen for one lesson, through the real generation service:
richter seed gen-exercises --lesson-title "…" --kinds single_choice,fill_blank
```

If the ML videos are absent, `seed --dev` **warns and falls back to golden
fixtures** — it never errors. See
[docs/infra/portable-local-data.md](docs/infra/portable-local-data.md) for the
full data-portability + seed details.
