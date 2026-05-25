CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS secret_key TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

UPDATE clients
SET secret_key = 'sk_test_' || substr(md5(public_key || now()::text || random()::text), 1, 24)
WHERE secret_key IS NULL OR secret_key = '';

ALTER TABLE clients
  ALTER COLUMN secret_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_secret_key
  ON clients(secret_key);

CREATE TABLE IF NOT EXISTS paywall_specs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  spec JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT,
  UNIQUE(workspace_id, name)
);

ALTER TABLE placements
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  ADD COLUMN IF NOT EXISTS default_spec_id TEXT REFERENCES paywall_specs(id),
  ADD COLUMN IF NOT EXISTS statsig_experiment_id TEXT,
  ADD COLUMN IF NOT EXISTS targeting_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

UPDATE placements
SET
  status = CASE WHEN enabled THEN 'active' ELSE 'paused' END,
  statsig_experiment_id = COALESCE(statsig_experiment_id, experiment_id)
WHERE status IS NULL OR statsig_experiment_id IS NULL;

INSERT INTO paywall_specs (workspace_id, name, spec, status, created_by)
SELECT
  c.id,
  'Legacy ' || p.trigger || ' default',
  p.spec,
  'active',
  'migration'
FROM placements p
JOIN clients c ON c.public_key = p.public_key
WHERE p.default_spec_id IS NULL
ON CONFLICT (workspace_id, name) DO UPDATE SET
  spec = EXCLUDED.spec,
  status = 'active',
  updated_at = now();

UPDATE placements p
SET default_spec_id = ps.id
FROM clients c
JOIN paywall_specs ps
  ON ps.workspace_id = c.id
WHERE c.public_key = p.public_key
  AND ps.name = 'Legacy ' || p.trigger || ' default'
  AND p.default_spec_id IS NULL;

ALTER TABLE placement_variants
  ADD COLUMN IF NOT EXISTS variant_key TEXT,
  ADD COLUMN IF NOT EXISTS spec_id TEXT REFERENCES paywall_specs(id),
  ADD COLUMN IF NOT EXISTS weight INTEGER DEFAULT 50,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused'));

UPDATE placement_variants
SET
  variant_key = COALESCE(variant_key, variant_id),
  status = CASE WHEN enabled THEN 'active' ELSE 'paused' END
WHERE variant_key IS NULL OR status IS NULL;

INSERT INTO paywall_specs (workspace_id, name, spec, status, created_by)
SELECT
  c.id,
  'Legacy ' || p.trigger || ' ' || pv.variant_id,
  pv.spec,
  'active',
  'migration'
FROM placement_variants pv
JOIN placements p ON p.id = pv.placement_id
JOIN clients c ON c.public_key = p.public_key
WHERE pv.spec_id IS NULL
ON CONFLICT (workspace_id, name) DO UPDATE SET
  spec = EXCLUDED.spec,
  status = 'active',
  updated_at = now();

UPDATE placement_variants pv
SET spec_id = ps.id
FROM placements p
JOIN clients c ON c.public_key = p.public_key
JOIN paywall_specs ps ON ps.workspace_id = c.id
WHERE p.id = pv.placement_id
  AND ps.name = 'Legacy ' || p.trigger || ' ' || pv.variant_id
  AND pv.spec_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_paywall_specs_workspace_status
  ON paywall_specs(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_placements_workspace_trigger
  ON placements(public_key, trigger);

CREATE INDEX IF NOT EXISTS idx_placements_default_spec
  ON placements(default_spec_id);

CREATE INDEX IF NOT EXISTS idx_placement_variants_spec
  ON placement_variants(spec_id);
