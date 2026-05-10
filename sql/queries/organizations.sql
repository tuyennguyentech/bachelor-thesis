-- name: CreateOrganization :one
INSERT INTO organizations (
  created_by,
  name,
  slug
) VALUES (
  $1, $2, $3
)
RETURNING *;

-- name: GetOrganizationByID :one
SELECT *
FROM organizations
WHERE id = $1;

-- name: GetOrganizationBySlug :one
SELECT *
FROM organizations
WHERE slug = $1;

-- name: ListOrganizations :many
SELECT *
FROM organizations
ORDER BY created_at DESC, id DESC
LIMIT $1 OFFSET $2;

-- name: ListOrganizationsByUser :many
SELECT *
FROM organizations
WHERE created_by = $1
ORDER BY created_at DESC, id DESC
LIMIT $2 OFFSET $3;

-- name: UpdateOrganization :one
UPDATE organizations
SET
  name = $2,
  slug = $3
WHERE id = $1
RETURNING *;

-- name: UpdateOrganizationStatus :one
UPDATE organizations
SET status = $2
WHERE id = $1
RETURNING *;

-- name: DeleteOrganization :execrows
DELETE FROM organizations
WHERE id = $1;

-- name: BulkCreateOrganizations :copyfrom
INSERT INTO organizations (
  created_by,
  name,
  slug,
  status
) VALUES (
  $1, $2, $3, $4
);
