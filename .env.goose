# .env.goose — shared Goose migration base (env-AGNOSTIC).
#
# This is the BASE layer inherited by every environment. The goose.sh wrapper
# sources this file FIRST, then layers a per-env overlay (.env.dev / .env.test)
# on top — only GOOSE_DBSTRING differs per env, so it is the only thing the
# overlays carry. Everything common to all environments lives here.
#
# Why a wrapper instead of `goose -env`: container-shell.sh sources the runtime
# `.env` (for RICHTER_AI_*/FDB_*), and goose's own -env (godotenv) does NOT
# override variables already present in the environment. Keeping GOOSE_* out of
# the runtime `.env` and composing them here with `set -a` guarantees the right
# DB string always wins.
GOOSE_DRIVER=postgres
GOOSE_MIGRATION_DIR=./sql/migrations
# GOOSE_TABLE=custom.goose_migrations
