-- name: AddOrganizationMember :one
INSERT INTO organization_members (
  organization_id,
  user_id,
  role,
  status
) VALUES (
  $1, $2, $3, $4
)
RETURNING *;

-- name: GetOrganizationMember :one
SELECT *
FROM organization_members
WHERE organization_id = $1 AND user_id = $2;

-- name: ListOrganizationMembers :many
SELECT *
FROM organization_members
WHERE organization_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: ListUserMemberships :many
SELECT *
FROM organization_members
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: UpdateOrganizationMemberRole :one
UPDATE organization_members
SET role = $3
WHERE organization_id = $1 AND user_id = $2
RETURNING *;

-- name: UpdateOrganizationMemberStatus :one
UPDATE organization_members
SET status = $3
WHERE organization_id = $1 AND user_id = $2
RETURNING *;

-- name: RemoveOrganizationMember :execrows
DELETE FROM organization_members
WHERE organization_id = $1 AND user_id = $2;

-- name: BulkAddOrganizationMembers :copyfrom
INSERT INTO organization_members (
  organization_id,
  user_id,
  role,
  status
) VALUES (
  $1, $2, $3, $4
);
