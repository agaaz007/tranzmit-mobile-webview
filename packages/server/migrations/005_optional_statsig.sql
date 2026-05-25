-- Statsig is fully optional per client. Allow NULL/empty env var so the
-- dashboard and admin API can clearly distinguish "Statsig off" from
-- "Statsig configured but env var missing on this host".
ALTER TABLE clients
  ALTER COLUMN statsig_server_secret_env_var DROP NOT NULL,
  ALTER COLUMN statsig_server_secret_env_var DROP DEFAULT;

-- Treat the legacy placeholder value the same as NULL so existing rows that
-- never opted in to Statsig render as "off" instead of "missing".
UPDATE clients
SET statsig_server_secret_env_var = NULL
WHERE statsig_project_name IS NULL
  AND statsig_server_secret_env_var = 'STATSIG_SERVER_SECRET';
