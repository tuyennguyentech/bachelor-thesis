# `container/` — image build definitions

All Docker image builds for the stack live here, **grouped by language/ecosystem**,
with one `Dockerfile.<service>` per image. The **build context is always the repo
root** (declared as `context: .` in the compose files), so every `COPY` inside a
Dockerfile is repo-root-relative.

The `*.Dockerfile` suffix (not the `Dockerfile.*` prefix) is what editors like VS Code
recognize as a Dockerfile for syntax highlighting.

```
container/
  golang/richter.Dockerfile       # Go services
  typescript/heino.Dockerfile     # TypeScript/Node services
```

| Dockerfile | Image | Built by | Notes |
|-----|-------|----------|-------|
| `golang/richter.Dockerfile` | Go backend | `compose.build.yml` | CGO + FoundationDB C client → `distroless/cc` |
| `typescript/heino.Dockerfile` | Next.js frontend | `compose.build.yml` | `output: "standalone"` → `distroless/nodejs`, `node server.js` |

> Database migrations are **not** an image here — they are a developer step run with
> goose (`scripts/setup/environment.dev/goose.sh`), not automated by a sidecar.

## Build

```sh
# app images (richter + heino) — versions + build args come from .env
podman compose -f compose.yml -f compose.build.yml build
podman compose -f compose.yml -f compose.build.yml push
```

## Conventions (so this stays scalable)

- **Group by language, name by service:** a new Go service → `container/golang/<name>.Dockerfile`;
  a new Node service → `container/typescript/<name>.Dockerfile`. Point its `build:` block
  at that path (`dockerfile: container/<lang>/<name>.Dockerfile`) with `context: .`. The
  `*.Dockerfile` suffix keeps editor syntax highlighting working.
- **Context = repo root**, set in compose. Never `cd` into a service dir to build;
  `COPY` only the inputs an image needs (`.dockerignore` keeps the context small).
- **Reproducible, no local-env dependency.** Version pins + build-time env come from the
  single-source `.env`; the build never reads a gitignored local file (e.g.
  `typescript/heino/.env.local` is excluded via `.dockerignore`), so it builds identically
  on a fresh clone, git worktree, or CI.
- **No config baked in.** `NEXT_PUBLIC_*` is inlined at build from the committed public
  `typescript/heino/.env`; all runtime config is mounted / `env_file` at run
  (see `compose.dev.yml`).
