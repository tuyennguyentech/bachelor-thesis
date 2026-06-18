-- name: AddCourseMember :one
INSERT INTO course_members (course_id, user_id, role)
VALUES ($1, $2, $3)
ON CONFLICT (course_id, user_id) DO UPDATE
  SET role = EXCLUDED.role,
      updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
RETURNING *;

-- name: EnrollCourseMemberIfAbsent :one
-- Self-enrol insert that NEVER mutates an existing row (unlike AddCourseMember's
-- DO UPDATE SET role = EXCLUDED.role). On conflict it does a no-op update
-- (role = the existing row's own role) purely so RETURNING yields the existing
-- row in the same statement. This makes EnrollSelf atomic: concurrent calls
-- cannot silently promote/demote, and a pre-existing member's role is preserved.
INSERT INTO course_members (course_id, user_id, role)
VALUES ($1, $2, $3)
ON CONFLICT (course_id, user_id) DO UPDATE
  SET role = course_members.role
RETURNING *;

-- name: RemoveCourseMember :execrows
DELETE FROM course_members
WHERE course_id = $1 AND user_id = $2;

-- name: RemoveCourseMembershipsForUserInOrg :execrows
-- Cascade used when a user leaves / is removed from an organization: drop all of
-- their course memberships within that org so they can't retain course access
-- after losing org membership (the FK only links course_members → courses/users,
-- not org membership, so this must be done explicitly).
DELETE FROM course_members cm
USING courses c
WHERE cm.course_id = c.id
  AND c.organization_id = $1
  AND cm.user_id = $2;

-- name: GetCourseMember :one
SELECT *
FROM course_members
WHERE course_id = $1 AND user_id = $2;

-- name: ListCourseMembers :many
SELECT
  cm.*,
  u.email      AS user_email,
  u.first_name AS user_first_name,
  u.last_name  AS user_last_name
FROM course_members cm
JOIN users u ON u.id = cm.user_id
WHERE cm.course_id = $1
ORDER BY cm.created_at DESC
LIMIT $2 OFFSET $3;

-- name: IsCourseMember :one
SELECT EXISTS (
  SELECT 1
  FROM course_members
  WHERE course_id = $1 AND user_id = $2
) AS is_member;

-- name: ListUserCourseMemberships :many
SELECT *
FROM course_members
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: GetCourseAccessInfoByCourseID :one
SELECT c.id AS course_id, c.organization_id, c.owner_id
FROM courses c
WHERE c.id = $1;

-- name: GetCourseAccessInfoByLessonID :one
SELECT c.id AS course_id, c.organization_id, c.owner_id
FROM lessons l
JOIN course_modules cm ON cm.id = l.module_id
JOIN courses c ON c.id = cm.course_id
WHERE l.id = $1;

-- name: ListCoursesWithAccess :many
SELECT
  c.*,
  (
    cm.user_id IS NOT NULL
    OR c.owner_id = $2
    OR EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.organization_id = c.organization_id
        AND om.user_id = $2
        AND om.status = 'active'
        AND om.role IN ('owner', 'admin')
    )
  ) AS can_access
FROM courses c
LEFT JOIN course_members cm ON cm.course_id = c.id AND cm.user_id = $2
WHERE c.organization_id = $1
ORDER BY c.created_at DESC, c.id DESC
LIMIT $3 OFFSET $4;

-- name: ListCoursesWithAccessAndStatus :many
SELECT
  c.*,
  (
    cm.user_id IS NOT NULL
    OR c.owner_id = $2
    OR EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.organization_id = c.organization_id
        AND om.user_id = $2
        AND om.status = 'active'
        AND om.role IN ('owner', 'admin')
    )
  ) AS can_access
FROM courses c
LEFT JOIN course_members cm ON cm.course_id = c.id AND cm.user_id = $2
WHERE c.organization_id = $1 AND c.status = $3
ORDER BY c.created_at DESC, c.id DESC
LIMIT $4 OFFSET $5;

-- name: ListCoursesWithAccessAndTitleFilter :many
SELECT
  c.*,
  (
    cm.user_id IS NOT NULL
    OR c.owner_id = $2
    OR EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.organization_id = c.organization_id
        AND om.user_id = $2
        AND om.status = 'active'
        AND om.role IN ('owner', 'admin')
    )
  ) AS can_access
FROM courses c
LEFT JOIN course_members cm ON cm.course_id = c.id AND cm.user_id = $2
WHERE c.organization_id = $1 AND c.title ILIKE '%' || $3::text || '%'
ORDER BY c.created_at DESC, c.id DESC
LIMIT $4 OFFSET $5;

-- Draft-excluding variants: used for non-managers. A draft course is hidden
-- UNLESS the caller can access it (explicit course member, course owner, or org
-- owner/admin) — otherwise an enrolled student could open a still-draft course
-- directly (GetCourseById allows it) yet never find it in their list. Published/
-- archived courses are always listed. Filtering at the query level keeps LIMIT
-- counting only visible rows, so pagination isn't broken by hidden drafts.

-- name: ListCoursesWithAccessExcludingDraft :many
SELECT
  c.*,
  (
    cm.user_id IS NOT NULL
    OR c.owner_id = $2
    OR EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.organization_id = c.organization_id
        AND om.user_id = $2
        AND om.status = 'active'
        AND om.role IN ('owner', 'admin')
    )
  ) AS can_access
FROM courses c
LEFT JOIN course_members cm ON cm.course_id = c.id AND cm.user_id = $2
WHERE c.organization_id = $1
  AND (
    c.status != 'draft'
    OR cm.user_id IS NOT NULL
    OR c.owner_id = $2
    OR EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.organization_id = c.organization_id
        AND om.user_id = $2
        AND om.status = 'active'
        AND om.role IN ('owner', 'admin')
    )
  )
ORDER BY c.created_at DESC, c.id DESC
LIMIT $3 OFFSET $4;

-- name: ListCoursesWithAccessAndTitleFilterExcludingDraft :many
SELECT
  c.*,
  (
    cm.user_id IS NOT NULL
    OR c.owner_id = $2
    OR EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.organization_id = c.organization_id
        AND om.user_id = $2
        AND om.status = 'active'
        AND om.role IN ('owner', 'admin')
    )
  ) AS can_access
FROM courses c
LEFT JOIN course_members cm ON cm.course_id = c.id AND cm.user_id = $2
WHERE c.organization_id = $1 AND c.title ILIKE '%' || $3::text || '%'
  AND (
    c.status != 'draft'
    OR cm.user_id IS NOT NULL
    OR c.owner_id = $2
    OR EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.organization_id = c.organization_id
        AND om.user_id = $2
        AND om.status = 'active'
        AND om.role IN ('owner', 'admin')
    )
  )
ORDER BY c.created_at DESC, c.id DESC
LIMIT $4 OFFSET $5;
