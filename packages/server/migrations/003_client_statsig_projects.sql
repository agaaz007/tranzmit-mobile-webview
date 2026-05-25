ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS statsig_project_name TEXT,
  ADD COLUMN IF NOT EXISTS statsig_server_secret_env_var TEXT NOT NULL DEFAULT 'STATSIG_SERVER_SECRET';

UPDATE clients
SET statsig_server_secret_env_var = 'STATSIG_SERVER_SECRET'
WHERE statsig_server_secret_env_var IS NULL OR statsig_server_secret_env_var = '';

CREATE INDEX IF NOT EXISTS idx_clients_statsig_secret_env
  ON clients(statsig_server_secret_env_var);
