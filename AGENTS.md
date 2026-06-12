# Dyadia — Project Instructions

Multi-service monorepo (Bachelor Thesis IT4995). Go backend (`richter`, `arthur` is a stub), Next.js 16 frontend (`heino`), Postgres, FoundationDB, Connect RPC, SeaweedFS (S3).

## Container Networking — ALL commands use this

Dev processes have no direct network access to compose containers. Always use:

```
./scripts/setup/environment.dev/container-shell.sh <service> -- <command>
```

Default container is `debug` (alpine/curl). Replace `<service>` with `richter`, `heino`, etc. to join that container's network namespace. Inside the shell, `postgres`, `fdb-coordinator`, `storage`, `richter` all resolve via aardvark-dns.

## Commands

| Action | Command |
|--------|---------|
| Start compose services | `podman compose up -d` |
| Proto codegen | `buf generate` (Makefile is empty — do NOT use `make`) |
| SQL codegen | `sqlc generate` |
| All Go tests | `go test ./...` |
| Go integ tests | `go test -tags=integ ./...` (compose must be up) |
| Go integ test script (BINDING) | `./scripts/setup/environment.dev/container-shell.sh richter -- ./scripts/test/golang/richter/test.sh -tags=integ -count=1 -v -run "TestXxx" -timeout 60s` — MUST run inside `container-shell.sh richter` (not raw shell) so the script sees the FDB cluster file via container DNS; the script itself sets `RICHTER_FDB_CLUSTER_FILE` to the absolute path of `./fdb.cluster` and appends `-args -config base,test`. Do NOT hand-craft `go test -tags=integ` with `RICHTER_FDB_CLUSTER_FILE` env — use the script |
| Heino dev | `pnpm --filter heino dev` |
| Heino build | `pnpm --filter heino build` |
| Heino lint | `pnpm --filter heino lint` |
| Heino E2E | `./scripts/setup/environment.dev/container-shell.sh heino -- pnpm -F heino test:e2e` |

## Verification after changes

```
go vet ./golang/richter/...
pnpm --filter heino exec tsc --noEmit
```

## User Feedback Rules

- Stay within the requested task. If another file or broader refactor is needed, explain why before expanding scope.
- If the user asks for "huong dan" or "hướng dẫn", answer with explanation only; do not edit files unless they explicitly say to implement.
- For risky or broad multi-file work, show the concrete plan/diff shape and checkpoint before continuing.
- Don't change pre-existing working code just to satisfy a new test; first verify whether the test assertion/setup is wrong.
- Prefer fixing the smallest coherent unit. Leave unrelated cleanup for a separate request.

## Starting Richter (config flags required)

```
# test DB (for Playwright E2E + integ tests)
./scripts/setup/environment.dev/container-shell.sh richter -- \
  go run ./golang/richter/ -c golang/richter/richter.base.toml,golang/richter/richter.test.toml

# dev DB
./scripts/setup/environment.dev/container-shell.sh richter -- \
  go run ./golang/richter/ -c golang/richter/richter.base.toml,golang/richter/richter.local.toml
```

Configs are comma-separated, merged left-to-right via viper `MergeInConfig`. Env vars prefixed `RICHTER_` (e.g. `RICHTER_LOG_LEVEL`).

## Seed

```
./scripts/setup/environment.dev/container-shell.sh richter -- \
  go run ./golang/richter/ -c ... seed --dev
```

`seed` creates admin user. `--dev` also inserts dev data (orgs, courses, etc.). Requires seed-asset videos (run `scripts/seed/download-assets.sh` first).

## DB Reset

```
./scripts/setup/environment.dev/container-shell.sh richter -- ./scripts/setup/environment.dev/goose.sh test reset
./scripts/setup/environment.dev/container-shell.sh richter -- ./scripts/setup/environment.dev/goose.sh test up
```

Run goose through `goose.sh <dev|test>`, which layers `.env.goose` (shared `GOOSE_DRIVER`/`GOOSE_MIGRATION_DIR`) under `.env.<target>` (`GOOSE_DBSTRING`). Do not use `goose -env` (it cannot override the env container-shell sourced from `.env`) and do not inline `GOOSE_DBSTRING`. Migration naming convention: `NNNNN_action_type_objects.sql` (see `docs/backend/migration-naming.md`).

## Test vs Dev DB

- `richter.test.toml` → DB `dyadia_test` + bucket `dyadia-test` — for tests
- `richter.local.toml` → DB `dyadia` + bucket `dyadia` — dev only
- Init script creates both roles/DBs: `scripts/init/postgresql/dev.sql`

## Architecture (key facts)

### DI pattern (`samber/do/v2`)
Each package exports `var Package = do.Package(do.Lazy(Constructor))`. `init()` calls `Package(internal.Injector)`. Retrieve with `do.Invoke[Type](injector)`. Scoped: `internal.Injector.Scope("module-name")`.

### Go workspace (`go.work`)
4 modules: `golang/richter`, `golang/arthur`, `golang/buf` (proto gen), `golang/sql` (sqlc gen).

### Richter entrypoints
`cmd/root.go` (Cobra) → `internal/api/server.go` (HTTP) → handlers in `internal/api/v1/` → business logic in `internal/svc/`. Proto ↔ SQL conversions in `internal/svc/mapper.go`.

### Connect RPC
gRPC-compatible, HTTP/1.1 + HTTP/2. Proto definitions in `proto/richter/v1/`. Validation via `connectrpc.com/validate` (Buf protovalidate).

### Search pattern
For admin list/search APIs, dispatch in the Go service layer:

- UUID input -> `GetById` by primary key
- Email input containing `@` -> `GetByEmail`
- Text input -> `GetBySlug` where applicable, otherwise empty result

Avoid `ILIKE '%...%'` leading-wildcard scans unless a proper trigram index is added.

### Frontend (heino)
- **Critical Next.js 16 breaking changes**: see `typescript/heino/AGENTS.md` — this is NOT the Next.js you know
- Middleware: `src/proxy.ts` exporting `proxy()` (not `middleware.ts`)
- Server RPC client: `src/lib/connect-client.ts` (reads `RICHTER_BASE_URL`)
- Browser RPC hook: `useRichterWebClient()` (reads `NEXT_PUBLIC_RICHTER_BASE_URL`)
- Auth: JWT cookies `dyadia_access` + `dyadia_refresh`, helpers `getSession()`, `requireAdmin()` in `src/lib/auth.ts`

### S3 storage
SeaweedFS via compose service `storage:9000`. Public endpoint differs between dev (`http://localhost/api/storage`) and test (`http://caddy/api/storage`).

### AI audio key path
Must be `lessons/<lessonID>/ai-audio/<uuid>.wav` (not `ai-generated/audio/`).

### Piper TTS
Piper TTS is the primary self-hosted TTS provider; VieNeu was rejected because it requires CUDA.

- Compose service: `piper-tts`
- Endpoint: `http://piper-tts:5000/tts?text=...&language=vi` -> WAV bytes
- Health: `http://piper-tts:5000/health`
- Languages: `vi` (vi-VN-vivos) and `en` (en-US-lessac)
- Go client: `golang/richter/internal/svc/ai/piper_tts.go`
- Output must be `audio/wav` with `.wav` object keys.

## Interaction System — Phase Progress

| Phase | Feature | Status |
|-------|---------|--------|
| 0 | MCQ refactor + registry pattern + UI redesign + feedback mode | Done |
| 1 | Fill-blank interaction + AI generation | Done |
| 2 | Listening + Reading interactions (audio upload, comprehension, dictation) | Done |
| 3 | Writing interaction (AI-graded essay via Gemini judge, async grading pipeline) | Not started |
| 4 | Code interaction (Monaco editor + sandboxed execution) | Not started |

Phase 3 introduces async grading pipeline (`LessonAttempt.status='pending_review'`). Phase 4 reuses it.
Multi-attempt support: Phase 0 single-attempt; Phases 1+ may differ — scope per interaction type.

## Current Project State

- Audio reading/listening pipeline is implemented in backend and frontend.
- Piper TTS replaced VieNeu and is expected to run on CPU-only dev/demo machines.
- Student Learning UI Phase 0 (MCQ refactor, registry, dynamic choice count, and full student UI) is successfully completed and verified on both Backend and Frontend via comprehensive tests (unit/integration and Playwright E2E).
- Historical active plan: heino auth silent refresh should live in `src/proxy.ts`, with `src/lib/auth.ts` read-only during Server Component rendering. Do not set cookies from Server Components.
- Historical video-player plan: remove any dummy `<video>` or global `document.querySelector("video")` monkey-patch; expose Vidstack's real video element via a React callback/state path.

## Generated Code — NEVER hand-edit

- `golang/buf/gen/` — protobuf Go
- `typescript/buf/gen/` — protobuf TypeScript
- `golang/sql/gen/` — sqlc Go

## Adding a New RPC Method

1. Add message + service to `proto/richter/v1/<entity>.proto` (protovalidate annotations)
2. Run `buf generate`
3. Implement handler in `golang/richter/internal/svc/<entity>/<entity>.go`
4. Add SQL to `sql/queries/<entity>.sql`, run `sqlc generate`
5. Add proto ↔ SQL mapping in `internal/svc/mapper.go`
6. Call from frontend via `connect-client.ts` (server) or `useRichterWebClient()` (client)

## Commit Style

Conventional Commits with scopes: `feat(heino):`, `fix(richter):`, `refactor(sql):`, etc.

Rules:
- NEVER use `git add .` or `git add -A` — always explicit file paths
- NEVER add `Co-Authored-By:` trailers
- Auto-commit only when: build clean + tests pass + coherent unit

## Background Processes

Never use `nohup ... &`, `cmd &`, or detached processes (orphan leaks). Before starting servers, check `ps aux` for orphan `richter`/`heino` processes from prior sessions.

When killing orphans: kill by command name (`go run ./golang/richter`, `pnpm --filter heino dev`, `next-server`), NOT by the shell that launched them. Never kill interactive `container-shell.sh bash` sessions — those belong to the user.

Project preference from prior sessions: Codex/agents should not start long-running `richter` or `heino` servers unless the current user explicitly asks. For Playwright, ask the user to start `richter` with `richter.test.toml` and `heino`; then run foreground tests. Go integration script `./scripts/test/golang/richter/test.sh` manages its own server.

### Foreground server pattern (BINDING)

When running servers or tests, ALWAYS follow these rules:
1. **Container shell required**: ALL servers and tests MUST run inside `container-shell.sh <service>` to be in the correct network namespace. Never run directly on host.
2. **Foreground only**: Servers must run in foreground (not background). Use `&` with PID tracking + `trap cleanup EXIT INT TERM` to auto-kill on script exit.
3. **Self-cleanup**: Always kill server processes when done. Track PIDs and kill on exit.
4. **No orphan processes**: After any server/test run, verify with `ps -eo pid,args | grep -E "richter-bin|heino.*dev|next-server" | grep -v grep | grep -v conmon`.

### E2E test prerequisites (BINDING)

Before running E2E tests, BOTH servers must be running with test config:
1. **Richter server**: `./scripts/setup/environment.dev/container-shell.sh richter -- go run ./golang/richter/ -c base,test` (or pre-built binary)
2. **Heino dev server**: `./scripts/setup/environment.dev/container-shell.sh heino -- pnpm -F heino dev`
3. **Wait for readiness**: Check HTTP 200/301/404 on `http://localhost:3000` before running tests
4. **Run E2E**: `./scripts/setup/environment.dev/container-shell.sh heino -- pnpm -F heino test:e2e`
5. **Cleanup**: Kill both servers after E2E completes

### BE test script (BINDING)

BE integration tests MUST use the existing script:
```
./scripts/setup/environment.dev/container-shell.sh richter -- ./scripts/test/golang/richter/test.sh -tags=integ -count=1 -timeout 600s
```
Do NOT hand-craft `go test -tags=integ` commands. The script handles FDB cluster file, config flags, and container namespace.

## Frontend Conventions (from past sessions)

### Auth details
- JWT claims: snake_case from Go protobuf JSON tags; `role` = 1 (NORMAL), 2 (ADMIN)
- Cookies: `dyadia_access` + `dyadia_refresh`, httpOnly, sameSite: lax
- Server-only auth helpers: `getSession()` (wrapped in `cache()`, includes silent refresh), `requireAdmin()`, `requireAnyUser()`, `requireOrgMember(orgId, ...roles)`

### Proto imports (TypeScript)
```ts
import { UserService, UserRole } from "buf/gen/richter/v1/users_pb"
```
Enum members use SHORT names: `UserRole.ADMIN` (NOT `USER_ROLE_ADMIN`).

### Pagination
```ts
const LIMIT = 20
const hasNext = res.users.length === LIMIT  // no total field
```
`limit`/`offset` are `number` (int32), not bigint. Proto must validate `limit: gte:1, lte:100`, `offset: gte:0`.

### Playwright E2E
- Run E2E from the `heino` container namespace:
  `./scripts/setup/environment.dev/container-shell.sh heino -- pnpm -F heino test:e2e`
- Test architecture uses Caddy by container DNS: `BASE_URL=http://caddy` in `typescript/heino/.env.test`.
  The browser context runs inside the `heino` container namespace and reaches the app through Caddy service DNS.
- Do NOT switch E2E to `localhost:3000` unless the test architecture is changed to provide equivalent Next rewrites/proxies for `/api/richter` and `/api/storage`.
- Caddy routes test traffic: `/api/richter/*` -> `richter:8080`, `/api/storage/*` -> `storage:9000`, all other paths -> `heino:3000`.
- Radix `DropdownMenuItem` with `asChild`+`Link` is flaky in Firefox — read `href` attribute instead of click-navigate
- After `revalidatePath`, wait for updated heading in-place — don't `page.goto` back
- Use `?q=` search param to find seed data (page 1 may not contain oldest records)

## Testing Rules (from past sessions)

### Test infrastructure checklist (before claiming "test broken")
1. Confirm richter is up with `richter.test.toml` (not local)
2. Reset + re-seed test DB (`goose.sh test reset` + `goose.sh test up` + `seed --dev`)
3. **Critical: restart richter AFTER goose reset** (schema OID cache invalidation)
4. Verify seed data matches test expectations

### Don't change working code to fix new tests
Fix the test assertion, not the pre-existing passing code.

### Test helper placement
Do not create standalone helper-only test files like `helpers_test.go` or `testmain_test.go`. Put shared helpers at the top of the most relevant existing test file unless the new file contains real test cases.

### DB seed: runs once, no upsert
INSERT + skip-on-duplicate only (NOT `ON CONFLICT DO UPDATE`). Tests must not create conflicting data with seed.

## Package & Dependency Rules

- Don't run `pnpm add`/`pnpm install` without asking user
- For shadcn/ui components, check/use the shadcn CLI from `typescript/heino/` first; installed components include button, input, label, badge, dialog, alert-dialog, select, table, avatar, skeleton, dropdown-menu, card, separator, field.
- Use `podman compose` (not `podman-compose`, not `docker compose`)
- No hardcoded env-specific values (URIs, hostnames) in source code
- All :many SQL queries must have `LIMIT $n OFFSET $m`
- Keep the established `auth` -> `users` package dependency for shared mappers; don't move it into a generic `svc` package without a clear reason.
