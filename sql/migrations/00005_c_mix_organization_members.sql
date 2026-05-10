-- +goose Up
CREATE TYPE organization_role AS ENUM (
  'owner',
  'admin',
  'teacher',
  'student'
);

CREATE TYPE member_status AS ENUM (
  'active',
  'invited',
  'suspended'
);

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role organization_role NOT NULL DEFAULT 'student',
  status member_status NOT NULL DEFAULT 'invited',
  created_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  updated_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  PRIMARY KEY (organization_id, user_id)
);

CREATE OR REPLACE TRIGGER organization_members_set_updated_at
BEFORE UPDATE ON organization_members
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TRIGGER IF EXISTS organization_members_set_updated_at ON organization_members;

DROP TABLE IF EXISTS organization_members;

DROP TYPE IF EXISTS member_status;
DROP TYPE IF EXISTS organization_role;
