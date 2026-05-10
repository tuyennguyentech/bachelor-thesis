-- +goose Up
CREATE TYPE organization_status AS ENUM (
  'active',
  'suspended',
  'archived'
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  created_by uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status organization_status NOT NULL DEFAULT 'active',
  created_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  updated_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE OR REPLACE TRIGGER organizations_set_updated_at
BEFORE UPDATE ON organizations
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TRIGGER IF EXISTS organizations_set_updated_at ON organizations;

DROP TABLE IF EXISTS organizations;

DROP TYPE IF EXISTS organization_status;
