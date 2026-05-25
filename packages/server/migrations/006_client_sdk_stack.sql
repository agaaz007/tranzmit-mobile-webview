ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS sdk_stack TEXT NOT NULL DEFAULT 'react_native';

UPDATE clients
SET sdk_stack = 'react_native'
WHERE sdk_stack IS NULL OR sdk_stack = '';

ALTER TABLE clients
  DROP CONSTRAINT IF EXISTS clients_sdk_stack_check,
  ADD CONSTRAINT clients_sdk_stack_check
    CHECK (sdk_stack IN ('react_native', 'flutter', 'swift'));

CREATE INDEX IF NOT EXISTS idx_clients_sdk_stack
  ON clients(sdk_stack);
