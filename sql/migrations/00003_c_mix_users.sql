-- +goose Up
CREATE TYPE user_role AS ENUM (
  'normal',
  'admin'
);

CREATE TYPE user_status AS ENUM (
  'pending',
  'active',
  'disabled'
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  first_name text NOT NULL,
  middle_name text,
  last_name text NOT NULL,
  role user_role NOT NULL DEFAULT 'normal',
  status user_status NOT NULL DEFAULT 'pending',
  created_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  updated_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE OR REPLACE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TRIGGER IF EXISTS users_set_updated_at ON users;

DROP TABLE IF EXISTS users;

DROP TYPE IF EXISTS user_status;
DROP TYPE IF EXISTS user_role;
