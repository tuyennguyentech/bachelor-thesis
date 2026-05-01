# Migration Naming Convention

This project uses `goose` for migration execution and `sqlc` for query code generation. Migration file names must stay stable after they are shared or applied.

## Format

```text
NNNNN_<action>_<type>_<objects>.sql
```

Example:

```text
00001_c_ext_citext.sql
00002_c_mix_identity.sql
00003_u_tbl_users_add_status.sql
00004_d_idx_users_email_old.sql
```

## Parts

`NNNNN` is the zero-padded migration order. Use increasing numbers such as `00001`, `00002`, `00003`.

`action` describes the main operation:

```text
c  create
u  update
d  delete
```

`type` describes the main database object type:

```text
ext      extension
enum     enum type
fn       function or procedure
tbl      table
idx      index
trg      trigger
view     view or materialized view
seed     seed data
mix      multiple related object types
```

`objects` describes the affected domain or object group in `snake_case`.

## Mix Migrations

Use `mix` when a migration creates or changes multiple object types that belong to one tightly related domain.

Good examples:

```text
00002_c_mix_identity.sql
00003_c_mix_course.sql
00004_c_mix_content.sql
```

For example, `00002_c_mix_identity.sql` may contain user and organization enum types, tables, indexes, and triggers because they are part of the same identity module.

Avoid using `mix` for unrelated changes. Split unrelated domains into separate migration files.

## Recommended Ordering

Create shared dependencies before dependent tables:

```text
00001_c_ext_base.sql
00002_c_fn_common.sql
00003_c_mix_identity.sql
00004_c_mix_course.sql
00005_c_mix_content.sql
```

Extensions, common functions, and enum types should appear before tables that use them.

## Rules

Do not rename a migration after it has been applied or shared.

Keep `-- +goose Up` and `-- +goose Down` sections explicit.

Keep generated `sqlc` files out of manual edits.

Prefer type-safe PostgreSQL enums over free-form text for stable roles, statuses, and object types.
