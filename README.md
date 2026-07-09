# Dyadia

AI-assisted learning platform (Bachelor Thesis).
Repo: <https://github.com/tuyennguyentech/bachelor-thesis>. Monorepo:

- **`richter`** — Go backend (Connect RPC; PostgreSQL, FoundationDB, SeaweedFS S3; Gemini + Whisper/Piper via Speaches).
- **`heino`** — Next.js 16 frontend.
- **infra** — PostgreSQL, FoundationDB, SeaweedFS, Caddy (reverse proxy), Speaches (STT/TTS), via `podman compose`.

**Flow:** browser → Caddy → `heino` (SSR) & `richter` (Connect RPC) → PostgreSQL / FoundationDB / SeaweedFS;
`richter` calls Gemini + Speaches for AI. All services run together on one machine.

**Portable & config-driven:** every stateful dir is bind-mounted under `volumes/`; all config lives
in committed files (root `.env` + `typescript/heino/.env`). Moving machines = copy `volumes/` + two
gitignored files → `podman compose up`. No manual DB steps.

## Prerequisites

- **OS: Linux or WSL2** — podman-native (rootless user namespaces; `volumes/` ownership is
  handled via `podman unshare`).
- `podman` + `podman compose` ([install guide](https://podman.io/docs/installation); rootless is fine).
- Ports **8080** (HTTP) and **8443** (HTTPS) free — Caddy publishes there (no low-port `sysctl`, even rootless).
- **GPU optional** — only to transcribe *new* uploads faster
  ([docs/infra/podman-gpu.md](docs/infra/podman-gpu.md)); not needed to serve seeded data.

Tool versions are pinned in the root `.env` / `compose.yml` (Go 1.26, Node 24, FoundationDB 7.3.69,
Postgres 18.3, Caddy 2.11) and baked into the images — nothing to install by hand beyond podman.

## Run with the pre-seeded data

The demo dataset is already processed (the "Tự học Machine Learning" course — 24 lessons,
transcripts, AI exercises, ~500 attempts). Nothing is re-processed: data travels in `volumes/`,
apps run as pulled images.

**Handed over separately (gitignored):** the `volumes/` dataset + two files —
`golang/richter/richter.local.toml` (the real secrets: DB password, S3 key, Gemini API key) and
`typescript/heino/.env.local`. JWT signing uses a committed demo value in `richter.base.toml`, so
`.env.local`'s `JWT_SECRET` just mirrors it. Public config (root `.env`, `typescript/heino/.env`) is committed.

```sh
# 1. Get a working copy (clone; for a git worktree see below)
git clone https://github.com/tuyennguyentech/bachelor-thesis.git dyadia && cd dyadia

# 2. Drop in the two gitignored files (compose hardcodes nothing — apps read these)
cp /path/to/richter.local.toml golang/richter/richter.local.toml
cp /path/to/heino.env.local    typescript/heino/.env.local

# 3. Provide the data — extract the handover archive OR symlink it.
#    MUST be `podman unshare tar`, NOT plain tar: it restores container-user
#    ownership; a host-owned extract breaks transcription (see "Handover" below).
podman unshare tar -xzf volumes.tar.gz  # → volumes/   (or: ln -s /path/to/volumes volumes)

# 4. Run (pulls the images; add "-f compose.gpu.yml" for GPU)
podman compose -f compose.yml -f compose.dev.yml up -d
```

Open **http://localhost:8080** (or **https://localhost:8443** — self-signed, accept once) and log in:

| Account | Email | Password | Shows |
|---|---|---|---|
| Teacher (owns ML course) | `carol@dyadia.local` | `Password123!` | Teacher analytics — 24 lessons, ~500 attempts |
| Student (in ML course) | `an@dyadia.local` | `Password123!` | Video + checkpoints + results |
| Multi-org user | `alice@dyadia.local` | `Password123!` | Owner/admin/teacher/student across orgs |
| System admin | `admin@dyadia.local` | `changeme123` | Admin console: users, orgs, AI tasks |

46 users across 8 orgs; regular users share `Password123!` (admin: `changeme123`).

**No manual DB step:** a copied-in `volumes/` is ready as-is — the `fdb-init` sidecar auto-configures
FoundationDB on `up`, Postgres is pre-migrated, and richter ensures the SeaweedFS bucket on boot.
Config is mounted, never baked: richter reads `richter.base.toml` + `richter.local.toml` +
`fdb.cluster`, plus `RICHTER_*` overrides from the root `.env`; heino reads `typescript/heino/.env`
(public) + `.env.local` (secret). Image refs (`…/richter:0.0.2`, `…/heino:0.0.2`) live in the root
`.env` (pulling needs the quay repo public or `podman login quay.io`).

**Operate** — always with the same `-f` files as the `up` command
(`podman compose -f compose.yml -f compose.dev.yml …`):
`… logs -f richter` (or any service) · `… restart <service>` · `… down` (never deletes `volumes/`).

## Handover: package `volumes/`

`volumes/` is gitignored and shipped separately. File ownership must survive the copy, so **both
directions run inside `podman unshare`** — follow these two commands and no ownership fixup is
ever needed:

```sh
# On the SOURCE machine — pack (stack stopped, from the repo root):
podman compose -f compose.yml -f compose.dev.yml down
podman unshare tar -czf volumes.tar.gz --sparse volumes/

# On the TARGET machine — unpack (= step 3 of "Run with the pre-seeded data"):
podman unshare tar -xzf volumes.tar.gz
```

`podman unshare` maps container sub-uids to root so `tar` can read every file when packing AND
recreate its owner when unpacking; `--sparse` skips SeaweedFS's preallocated-but-empty space.
Size scales with ingested media (mostly video, which gzips poorly) — check with
`podman unshare du -sh --apparent-size volumes/`.

**Troubleshooting — only if the archive was unpacked with plain `tar` (or copied with `cp -r`) by
mistake:** every transcription fails with a 500 (`PermissionError` in
`podman logs dyadia-speaches-1`), because the copy became host-owned and Speaches (uid 1000, the
only non-root service) can't write its model cache. The `:U` flag in `compose.yml` won't repair
it (the docker-compose provider silently strips it). Fix the bad copy in place on the target
machine — no re-copy needed:

```sh
podman unshare chown -R 1000:1000 volumes/hf-cache
```

## Git worktree checkout

`git worktree` checks out only tracked files, so **copy** the two secret files and **symlink** `volumes/`:

```sh
git worktree add ../dyadia-wt <branch> && cd ../dyadia-wt
cp ../dyadia/golang/richter/richter.local.toml golang/richter/richter.local.toml
cp ../dyadia/typescript/heino/.env.local       typescript/heino/.env.local
ln -sr ../dyadia/volumes volumes
```

- **Copy `richter.local.toml`, don't symlink it** — SELinux `:z` relabel can't follow a symlink's target.
- One stack at a time per shared `volumes` (compose project name `dyadia` is shared); remove the link
  with `rm volumes` (**no trailing slash** — `rm -r volumes/` deletes the shared dataset).
- If you want an **independent copy** of the data instead of the symlink, copy inside the user
  namespace: `podman unshare cp -a ../dyadia/volumes volumes`. A plain `cp -r` leaves it host-owned
  and breaks transcription (Speaches can't write its model cache — see "Handover" above).

## Build & push images (maintainers)

```sh
podman compose -f compose.yml -f compose.build.yml build
podman compose -f compose.yml -f compose.build.yml push
```

Dockerfiles are under `container/`; context is the repo root. Multi-stage, run codegen themselves
(`buf generate` + `sqlc generate`), and pin every version via build args from the root `.env`
(`DYADIA_*`, `FDB_VERSION`). Output: **richter** ~223 MB (distroless/cc, Go + FoundationDB C client
+ a static `ffmpeg`) and **heino** ~191 MB (distroless/nodejs, `next build` `output: "standalone"`).
`NEXT_PUBLIC_*` are inlined from the committed `heino/.env`; secrets never enter the build.

## Develop (host-process loop)

Run the apps as host processes joined to the container netns (fast rebuilds); base `compose.yml`
keeps `richter`/`heino` as placeholders:

```sh
podman compose up -d                                   # infra only
./scripts/setup/environment.dev/container-shell.sh richter -- \
  go run ./golang/richter -c golang/richter/richter.base.toml,golang/richter/richter.local.toml
./scripts/setup/environment.dev/container-shell.sh heino -- pnpm -F heino dev
```

`compose.dev.yml` is the overlay that swaps the placeholders for the built images. See `CLAUDE.md`
for the full dev/codegen/test workflow.

## Reseed the data from scratch

One command does everything — stops the stack, wipes `volumes/`, migrates, and seeds:

```sh
GPU=1 ./scripts/setup/environment.dev/seed-reset.sh    # GPU=0 = CPU-only (much slower Whisper)
```

Nothing else to run. It ends by seeding the admin + users/orgs/courses, the ML course through
the real Whisper+Gemini pipeline, and dense student attempts through the real submit flow —
idempotent, so re-running it is always safe. The model cache (`volumes/hf-cache`) is kept, so
resets don't re-download Whisper/Piper.

**Source videos** (gitignored, under `seed-assets/videos/`): if they are missing the seed just
**warns and falls back to golden fixtures** — the reset still succeeds. To seed the real ML
course, download them once beforehand:

```sh
./scripts/seed/download-assets.sh              # demo movies for the non-ML courses
python3 scripts/seed/download-ml-videos.py     # ML playlist (needs yt-dlp)
```

Rarely needed:

- **Top up in place** (stack already running, no wipe) — the same idempotent seed directly:
  ```sh
  ./scripts/setup/environment.dev/container-shell.sh richter -- \
    go run ./golang/richter/ -c golang/richter/richter.base.toml,golang/richter/richter.local.toml seed --dev
  ```
- **`SKIP_SEED=1 …/seed-reset.sh`** — reset infra only, seed later with the command above.
- **`… seed gen-ml-spec`** (same wrapper as above) — regenerates the committed ML course spec
  (`tu-hoc-ml.json` + `videos.json`) from the downloaded videos. Only needed after **changing
  the ML video set**; the spec is already committed, normal reseeds never run this.
- **`… seed gen-exercises --lesson-title "…"`** — (re)generate exercises for ONE lesson through
  the real generation service (`--kinds`, `--count`, `--difficulty`, `--force` — see `--help`).
- **`… seed rescale-fixtures`** — re-fit the demo (non-ML) fixture lessons to their real video
  durations, in place — repairs an older DB without a destructive reseed.
- Bare **`… seed`** (no `--dev`) creates only the admin account from `richter.base.toml`.

Full details: [docs/infra/portable-local-data.md](docs/infra/portable-local-data.md).
