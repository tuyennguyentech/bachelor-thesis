-- CREATE EXTENSION IF NOT EXISTS citext;
  -- WITH
  --   SCHEMA public
  --   CASCADE;
CREATE ROLE dyadia_test WITH
  LOGIN
  PASSWORD 'dyadia_test';

CREATE DATABASE dyadia_test
  WITH OWNER = dyadia_test;
