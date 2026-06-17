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
SELECT
  om.*,
  u.email     AS user_email,
  u.first_name AS user_first_name,
  u.last_name  AS user_last_name
FROM organization_members om
JOIN users u ON u.id = om.user_id
WHERE om.organization_id = $1
ORDER BY om.created_at DESC
LIMIT $2 OFFSET $3;

-- name: ListUserMemberships :many
SELECT
  om.*,
  o.name AS organization_name,
  o.slug AS organization_slug
FROM organization_members om
JOIN organizations o ON o.id = om.organization_id
WHERE om.user_id = $1
ORDER BY om.created_at DESC
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

-- name: CountOrganizationOwners :one
SELECT COUNT(*)::bigint
FROM organization_members
WHERE organization_id = $1
  AND role = 'owner'
  AND status = 'active';
