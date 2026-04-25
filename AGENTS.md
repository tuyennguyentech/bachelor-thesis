# Repository Guidelines

## Project Structure & Module Organization
This repository is a mixed-language workspace. `golang/richter` contains the Go backend and RPC entrypoints, `golang/arthur` is a separate Go CLI/service, and `golang/sql/gen` is generated from `sql/queries` and `sql/migrations` via `sqlc`. Frontend code lives in `typescript/heino` (`src/app`, `src/components`, `public`). Shared protobuf definitions are under `proto`, with generated clients in `golang/buf/gen` and `typescript/buf/gen`. Dev environment docs and shell helpers live in `docs/` and `scripts/setup/environment.dev/`. Thesis assets are in `typst/`.

## Build, Test, and Development Commands
Use the commands that match the package you are editing:

- `make generate-protoc`: regenerate protobuf code for Go and TypeScript.
- `pnpm --filter heino dev`: start the Next.js app locally.
- `pnpm --filter heino build`: production build for the frontend.
- `pnpm --filter heino lint`: run ESLint for `typescript/heino`.
- `go test ./...`: run all Go tests in the workspace.
- `docker compose up -d`: start local dependencies such as FoundationDB, Postgres, and Caddy.

If you need container DNS from the host, use `./scripts/setup/environment.dev/dev-shell.sh`.

## Coding Style & Naming Conventions
Follow `.editorconfig`: spaces with 2-space indentation, LF line endings, and tabs only in `Makefile`. Keep Go code `gofmt`-clean and use package-oriented lowercase names. In TypeScript, prefer PascalCase for React components (`LoginForm.tsx` style), camelCase for helpers, and colocate UI primitives under `src/components/ui`. Do not hand-edit generated files in `golang/buf/gen`, `typescript/buf/gen`, or `golang/sql/gen`.

## Testing Guidelines
There are currently no committed frontend or Go test suites in this workspace, so contributors should add tests with new behavior where practical. Use Go’s standard `*_test.go` naming and place tests beside the code they cover. For frontend changes, at minimum run `pnpm --filter heino lint` and verify the affected flow locally.

## Commit & Pull Request Guidelines
Recent history uses Conventional Commit style, often with scopes: `feat(heino): ...`, `fix(dev-shell): ...`, `refactor(heino): ...`. Keep commit messages imperative and scoped to the changed area. PRs should include a short summary, linked issue or task, commands run for verification, and screenshots for UI changes in `typescript/heino`.

## Configuration & Generated Artifacts
Local configuration currently relies on `.env`, `fdb.cluster`, and service settings in `compose.yml`. Keep secrets out of Git. When changing SQL schemas, protobufs, or generated clients, commit both the source change and the regenerated artifacts in the same PR.
