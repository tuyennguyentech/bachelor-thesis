-- +goose Up
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT,
  password TEXT,
  email TEXT
);

-- +goose Down
DROP TABLE IF EXISTS users RESTRICT;
