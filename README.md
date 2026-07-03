# Dyadia

AI-assisted learning platform (Bachelor Thesis). Monorepo:

- **`richter`** — Go backend (Connect RPC, PostgreSQL, FoundationDB, SeaweedFS S3, Gemini, Whisper/Piper via Speaches).
- **`heino`** — Next.js 16 frontend.
- **infra** — PostgreSQL, FoundationDB, SeaweedFS, Caddy (reverse proxy), Speaches (STT/TTS) — all via `podman compose`.

**Fully portable & config-driven:** every stateful dir is bind-mounted under `volumes/`,
and all config lives in committed files + `.env`. Moving the app to another machine is
just: copy `volumes/` + the two secret files → `podman compose up`. No manual DB steps.

## Prerequisites (every scenario)

- **OS: Linux or WSL2** — the stack is podman-native (rootless, `:U,Z` bind-mount flags;
  Docker does not support `:U`).
- `podman` + `podman compose` (rootless is fine).
- Ports **8080** (HTTP) and **8443** (HTTPS) free — Caddy publishes there, so no
  `sysctl`/low-port setup is needed even rootless.
- **GPU is optional** — only to transcribe *new* uploads faster (see
  [docs/infra/podman-gpu.md](docs/infra/podman-gpu.md)); **not needed** to serve seeded data.

---

## Scenario 1 — Run with the pre-seeded data (the fast path)

Run Dyadia with the demo dataset already processed (the "Tự học Machine Learning" course
— 24 lessons, transcripts, AI-generated exercises, ~558 attempts). Nothing is re-processed:
data travels in `volumes/`; the apps run as pulled images.

**Handed over separately (all gitignored):** the `volumes/` dataset + two secret files —
`golang/richter/richter.local.toml` and `typescript/heino/.env.local` (JWT_SECRET). The
public config `typescript/heino/.env` is committed.

```sh
# 1. Get a working copy (clone; for a git worktree see Scenario 3)
git clone <repo> dyadia && cd dyadia

# 2. Drop in the two secret files (compose hardcodes nothing — apps read these files)
cp /path/to/richter.local.toml golang/richter/richter.local.toml
cp /path/to/heino.env.local    typescript/heino/.env.local

# 3. Provide the data — extract the handover archive (Scenario 2) OR symlink it
tar -xzf volumes.tar.gz                 # → volumes/   (or: ln -s /path/to/volumes volumes)

# 4. Run (pulls the images; add "-f compose.gpu.yml" only if you want GPU)
podman compose -f compose.yml -f compose.dev.yml up -d
```

Open **http://localhost:8080** (or **https://localhost:8443** — self-signed, accept once)
and log in:

| Account | Email | Password | Shows |
|---|---|---|---|
| Teacher (owns ML course) | `carol@dyadia.local` | `Password123!` | Teacher analytics — 24 lessons, ~558 attempts |
| Student (in ML course) | `an@dyadia.local` | `Password123!` | Video + checkpoints + results |
| Multi-org user | `alice@dyadia.local` | `Password123!` | Owner/admin/teacher/student across 6 orgs |
| System admin | `admin@dyadia.local` | `changeme123` | Admin console: users, orgs, AI tasks |

~40 users across 8 orgs; regular users share `Password123!` (admin: `changeme123`).

**A copied-in `volumes/` is ready as-is** — the `fdb-init` sidecar auto-configures a
FoundationDB dir on `up`, Postgres is already migrated, and richter ensures the SeaweedFS
bucket on boot. **No manual DB step.** Config is mounted in, never baked: richter reads
`richter.base.toml` + `richter.local.toml` + `fdb.cluster`; heino reads `.env` (public) +
`.env.local` (secret). Images: `quay.io/tuyennguyentech/bachelor-thesis/{richter,heino}:0.0.2`
(refs in `.env`; pulling needs the quay repo public or `podman login quay.io`).

Stop with `podman compose -f compose.yml -f compose.dev.yml down` — this never deletes
`volumes/` (it is a bind mount / symlink).

## Scenario 2 — Package `volumes/` for handover (zip for Drive)

`volumes/` is gitignored and shipped separately. Build the archive **from the repo root,
with the stack stopped** (consistent snapshot) and **inside the container user namespace**
— the Postgres dir is owned by a container sub-uid your host user cannot otherwise read,
so a plain `zip`/`tar` fails with "Permission denied":

```sh
podman compose -f compose.yml -f compose.dev.yml down       # consistent snapshot
podman unshare tar -czf volumes.tar.gz --sparse volumes/    # readable + sparse-aware
```

- `podman unshare` runs `tar` in the rootless user namespace where the container sub-uids
  map to root, so it reads **every** volume (Postgres, FDB, SeaweedFS).
- `--sparse` + gzip keep it small: `volumes/` shows **~15 GB** on disk (SeaweedFS
  **preallocates** its volume files) but real content is only **~1.7 GB** → the archive is
  **~1–2 GB**, fine for one Drive upload.

Upload `volumes.tar.gz` to Drive. Restore on the other machine → Scenario 1 step 3.
Ownership self-heals on `up`: the `:U` bind-mount flag chowns each volume to its container
user, so extracting as your own user is fine (`:U` is podman-only).

## Scenario 3 — New checkout via git worktree

`git worktree` checks out only *tracked* files, so the gitignored inputs
(`richter.local.toml`, `heino/.env.local`, `volumes/`) do not follow it. Provision them —
**copy** the small secret files, **symlink** the big dataset:

```sh
git worktree add ../dyadia-wt <branch> && cd ../dyadia-wt
cp ../dyadia/golang/richter/richter.local.toml golang/richter/richter.local.toml
cp ../dyadia/typescript/heino/.env.local       typescript/heino/.env.local
ln -sr ../dyadia/volumes volumes    # ln -sr: link relative to the link's own dir
```

Then run as in Scenario 1. Notes:

- **Copy the config, don't symlink it** — compose bind-mounts `richter.local.toml` (`:z`),
  and SELinux cannot relabel a symlink's *target*, so a symlinked config stays read-denied
  in the container. `volumes` symlinks fine (it's an intermediate path component; podman
  relabels the real dirs inside).
- Both checkouts share compose project name `dyadia`, so run **one** stack at a time
  against a shared `volumes` (copy it instead to run concurrently).
- Remove a link with `rm volumes` (**no trailing slash** — `rm -r volumes/` follows the
  link and deletes the shared dataset).

## Scenario 4 — Build & push the images (maintainers)

Consumers just run pulled images. To build & publish, use `compose.build.yml` (build only):

```sh
podman compose -f compose.yml -f compose.build.yml build      # build both
podman compose -f compose.yml -f compose.build.yml push       # push to registry
```

Build definitions live under **`container/`** (`container/golang/richter.Dockerfile`,
`container/typescript/heino.Dockerfile`); build context is the repo root. The Dockerfiles
are multi-stage, run codegen themselves (`buf generate` + `sqlc generate`), and **hardcode
no versions** — every pin (Go/Node/buf/sqlc/pnpm/FDB/ffmpeg) is a build arg sourced from
`.env` (`DYADIA_*` / `FDB_VERSION`). Result:

- **richter** (~223 MB): Go (CGO + FoundationDB C client) + a static `ffmpeg` (for
  transcription audio extraction) on **distroless/cc**.
- **heino** (~191 MB): `next build` (`output: "standalone"`) on **distroless/nodejs**
  running `node server.js`. Committed `typescript/heino/.env` supplies `NEXT_PUBLIC_*`
  (inlined at build); secrets never enter the build.

---

## Develop (host-process loop)

For active development, run the apps as **host processes** (fast rebuilds, no image build)
joined to the container netns; base `compose.yml` keeps `richter`/`heino` as placeholders:

```sh
podman compose up -d                                   # infra only
./scripts/setup/environment.dev/container-shell.sh richter -- \
  go run ./golang/richter -c golang/richter/richter.base.toml,golang/richter/richter.local.toml
./scripts/setup/environment.dev/container-shell.sh heino -- pnpm -F heino dev
```

`compose.dev.yml` is the opt-in overlay that swaps the placeholders for the built images
(Scenario 1). See `CLAUDE.md` for the full dev workflow, codegen, and test commands.

## Rebuild the seed data from scratch

All seeding goes through the idempotent Go `richter seed` command (no Python touches the app):

```sh
# 1. (ML course only) Acquire gitignored source assets, then regenerate the ML spec:
./scripts/seed/download-assets.sh              # small demo videos
python3 scripts/seed/download-ml-videos.py     # ML playlist via yt-dlp
richter seed gen-ml-spec                        # → tu-hoc-ml.json + videos.json

# 2. Full clean rebuild on volumes + seed (real GPU Whisper + Gemini for the ML course):
GPU=1 ./scripts/setup/environment.dev/seed-reset.sh    # GPU=0 for CPU-only

# Or top up without a destructive reset (idempotent):
richter seed --dev
```

`seed-reset.sh` wipes the `volumes/` data dirs (keeping the model cache), brings the stack
up, runs goose migrations, and seeds — `fdb-init` configures the fresh FDB automatically.
If the ML videos are absent, `seed --dev` **warns and falls back to golden fixtures** — it
never errors. See [docs/infra/portable-local-data.md](docs/infra/portable-local-data.md)
for the full data-portability + seed details.
