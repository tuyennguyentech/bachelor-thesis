-- name: CreateUser :one
INSERT INTO users (
  email,
  password_hash,
  first_name,
  middle_name,
  last_name
) VALUES (
  $1, $2, $3, $4, $5
)
RETURNING *;

-- name: CreateUserWithRoleAndStatus :one
INSERT INTO users (
  email,
  password_hash,
  first_name,
  middle_name,
  last_name,
  role,
  status
) VALUES (
  $1, $2, $3, $4, $5, $6, $7
)
RETURNING *;

-- name: GetUserByID :one
SELECT *
FROM users
WHERE id = $1;

-- name: GetUserByEmail :one
SELECT *
FROM users
WHERE email = $1;

-- name: ListUsers :many
SELECT *
FROM users
ORDER BY created_at DESC, id DESC
LIMIT $1 OFFSET $2;

-- name: UpdateUserProfile :one
UPDATE users
SET
  first_name = $2,
  middle_name = $3,
  last_name = $4
WHERE id = $1
RETURNING *;

-- name: UpdateUserPassword :one
UPDATE users
SET password_hash = $2
WHERE id = $1
RETURNING *;

-- name: UpdateUserRole :one
UPDATE users
SET role = $2
WHERE id = $1
RETURNING *;

-- name: UpdateUserStatus :one
UPDATE users
SET status = $2
WHERE id = $1
RETURNING *;

-- name: DeleteUser :execrows
DELETE FROM users
WHERE id = $1;
