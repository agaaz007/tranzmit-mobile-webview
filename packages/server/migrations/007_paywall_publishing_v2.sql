CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Clients remain the environment boundary. V2 only makes the relationship
-- between a customer's test and live rows explicit.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS project_key TEXT,
  ADD COLUMN IF NOT EXISTS environment_kind TEXT,
  ADD COLUMN IF NOT EXISTS management_status TEXT,
  ADD COLUMN IF NOT EXISTS config_source TEXT;

UPDATE clients
SET
  project_key = COALESCE(
    project_key,
    CASE
      WHEN lower(name) LIKE '%hiastro%' THEN 'hiastro'
      WHEN lower(name) LIKE '%influish%' THEN 'influish'
      ELSE COALESCE(
        NULLIF(
          trim(BOTH '-' FROM regexp_replace(
            regexp_replace(lower(name), '(production|testing|tesitng|test|demo|live)', '', 'g'),
            '[^a-z0-9]+', '-', 'g'
          )),
          ''
        ),
        lower(public_key)
      )
    END
  ),
  environment_kind = COALESCE(
    environment_kind,
    CASE WHEN public_key LIKE 'pk_live_%' THEN 'live' ELSE 'test' END
  ),
  management_status = COALESCE(
    management_status,
    CASE WHEN lower(name) LIKE '%influish%' THEN 'legacy_locked' ELSE 'editable' END
  ),
  config_source = COALESCE(config_source, 'legacy');

ALTER TABLE clients
  ALTER COLUMN project_key SET NOT NULL,
  ALTER COLUMN environment_kind SET NOT NULL,
  ALTER COLUMN management_status SET NOT NULL,
  ALTER COLUMN config_source SET NOT NULL,
  ALTER COLUMN management_status SET DEFAULT 'editable',
  ALTER COLUMN config_source SET DEFAULT 'legacy';

ALTER TABLE clients
  DROP CONSTRAINT IF EXISTS clients_environment_kind_check,
  ADD CONSTRAINT clients_environment_kind_check
    CHECK (environment_kind IN ('test', 'live')) NOT VALID,
  DROP CONSTRAINT IF EXISTS clients_management_status_check,
  ADD CONSTRAINT clients_management_status_check
    CHECK (management_status IN ('editable', 'legacy_locked')) NOT VALID,
  DROP CONSTRAINT IF EXISTS clients_config_source_check,
  ADD CONSTRAINT clients_config_source_check
    CHECK (config_source IN ('legacy', 'v2')) NOT VALID;

ALTER TABLE clients VALIDATE CONSTRAINT clients_environment_kind_check;
ALTER TABLE clients VALIDATE CONSTRAINT clients_management_status_check;
ALTER TABLE clients VALIDATE CONSTRAINT clients_config_source_check;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_project_environment
  ON clients(project_key, environment_kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_id_project
  ON clients(id, project_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_public_id_project
  ON clients(public_key, id, project_key);

CREATE TABLE IF NOT EXISTS paywalls (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_key TEXT NOT NULL,
  paywall_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_key, paywall_key),
  UNIQUE(id, project_key)
);

CREATE TABLE IF NOT EXISTS paywall_content_revisions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  paywall_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  content JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  document_cache_key TEXT NOT NULL,
  document_revision TEXT NOT NULL,
  document_hash TEXT NOT NULL,
  document_payload JSONB NOT NULL,
  document_integrity TEXT NOT NULL,
  legacy_spec_id TEXT,
  legacy_version INTEGER,
  legacy_updated_at TIMESTAMPTZ,
  legacy_fingerprint TEXT,
  legacy_status TEXT,
  legacy_name TEXT,
  created_by TEXT NOT NULL DEFAULT 'api',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT paywall_content_revisions_paywall_fk
    FOREIGN KEY (paywall_id, project_key)
    REFERENCES paywalls(id, project_key),
  UNIQUE(paywall_id, revision_number),
  UNIQUE(paywall_id, legacy_spec_id, legacy_fingerprint),
  UNIQUE(id, project_key, paywall_id)
);

CREATE TABLE IF NOT EXISTS paywall_environment_bindings (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  client_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  paywall_id TEXT NOT NULL,
  current_release_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT paywall_environment_bindings_client_fk
    FOREIGN KEY (client_id, project_key)
    REFERENCES clients(id, project_key),
  CONSTRAINT paywall_environment_bindings_paywall_fk
    FOREIGN KEY (paywall_id, project_key)
    REFERENCES paywalls(id, project_key),
  UNIQUE(client_id, paywall_id),
  UNIQUE(id, client_id, project_key, paywall_id),
  UNIQUE(id, client_id, project_key)
);

CREATE TABLE IF NOT EXISTS paywall_environment_releases (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  binding_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  paywall_id TEXT NOT NULL,
  release_number INTEGER NOT NULL CHECK (release_number > 0),
  content_revision_id TEXT NOT NULL,
  products JSONB NOT NULL,
  checkout JSONB,
  legacy_spec_id TEXT,
  legacy_fingerprint TEXT,
  created_by TEXT NOT NULL DEFAULT 'api',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT paywall_environment_releases_binding_fk
    FOREIGN KEY (binding_id, client_id, project_key, paywall_id)
    REFERENCES paywall_environment_bindings(id, client_id, project_key, paywall_id),
  CONSTRAINT paywall_environment_releases_content_fk
    FOREIGN KEY (content_revision_id, project_key, paywall_id)
    REFERENCES paywall_content_revisions(id, project_key, paywall_id),
  UNIQUE(binding_id, release_number),
  UNIQUE(binding_id, legacy_spec_id, legacy_fingerprint),
  UNIQUE(id, binding_id)
);

ALTER TABLE paywall_environment_bindings
  DROP CONSTRAINT IF EXISTS paywall_environment_bindings_current_release_fk,
  ADD CONSTRAINT paywall_environment_bindings_current_release_fk
    FOREIGN KEY (current_release_id, id)
    REFERENCES paywall_environment_releases(id, binding_id)
    NOT VALID;
ALTER TABLE paywall_environment_bindings
  VALIDATE CONSTRAINT paywall_environment_bindings_current_release_fk;

ALTER TABLE placements
  ADD COLUMN IF NOT EXISTS client_id TEXT,
  ADD COLUMN IF NOT EXISTS project_key TEXT,
  ADD COLUMN IF NOT EXISTS current_revision_id TEXT;

-- New V2 placement identities do not need placeholder copies of a paywall.
-- Existing legacy rows retain their values and continue serving unchanged.
ALTER TABLE placements
  ALTER COLUMN variant_id DROP NOT NULL,
  ALTER COLUMN spec DROP NOT NULL;

UPDATE placements p
SET client_id = c.id,
    project_key = c.project_key
FROM clients c
WHERE c.public_key = p.public_key
  AND (p.client_id IS NULL OR p.project_key IS NULL);

ALTER TABLE placements
  ALTER COLUMN client_id SET NOT NULL,
  ALTER COLUMN project_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_placements_id_client_project
  ON placements(id, client_id, project_key);

ALTER TABLE placements
  DROP CONSTRAINT IF EXISTS placements_client_project_fk,
  ADD CONSTRAINT placements_client_project_fk
    FOREIGN KEY (client_id, project_key)
    REFERENCES clients(id, project_key)
    NOT VALID;
ALTER TABLE placements VALIDATE CONSTRAINT placements_client_project_fk;

ALTER TABLE placements
  DROP CONSTRAINT IF EXISTS placements_public_client_project_fk,
  ADD CONSTRAINT placements_public_client_project_fk
    FOREIGN KEY (public_key, client_id, project_key)
    REFERENCES clients(public_key, id, project_key)
    NOT VALID;
ALTER TABLE placements VALIDATE CONSTRAINT placements_public_client_project_fk;

CREATE TABLE IF NOT EXISTS placement_revisions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  placement_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'archived')),
  default_binding_id TEXT NOT NULL,
  default_variant_key TEXT NOT NULL,
  statsig_experiment_id TEXT,
  targeting_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  legacy_fingerprint TEXT,
  created_by TEXT NOT NULL DEFAULT 'api',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT placement_revisions_placement_fk
    FOREIGN KEY (placement_id, client_id, project_key)
    REFERENCES placements(id, client_id, project_key),
  CONSTRAINT placement_revisions_default_binding_fk
    FOREIGN KEY (default_binding_id, client_id, project_key)
    REFERENCES paywall_environment_bindings(id, client_id, project_key),
  UNIQUE(placement_id, revision_number),
  UNIQUE(placement_id, legacy_fingerprint),
  UNIQUE(id, placement_id),
  UNIQUE(id, placement_id, client_id, project_key)
);

CREATE TABLE IF NOT EXISTS placement_revision_variants (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  placement_revision_id TEXT NOT NULL,
  placement_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  variant_key TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused')),
  weight INTEGER NOT NULL DEFAULT 50 CHECK (weight >= 0 AND weight <= 100),
  fallback_rank INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT placement_revision_variants_revision_fk
    FOREIGN KEY (placement_revision_id, placement_id, client_id, project_key)
    REFERENCES placement_revisions(id, placement_id, client_id, project_key)
    ON DELETE CASCADE,
  CONSTRAINT placement_revision_variants_binding_fk
    FOREIGN KEY (binding_id, client_id, project_key)
    REFERENCES paywall_environment_bindings(id, client_id, project_key),
  UNIQUE(placement_revision_id, variant_key)
);

ALTER TABLE placements
  DROP CONSTRAINT IF EXISTS placements_current_revision_fk,
  ADD CONSTRAINT placements_current_revision_fk
    FOREIGN KEY (current_revision_id, id)
    REFERENCES placement_revisions(id, placement_id)
    NOT VALID;
ALTER TABLE placements VALIDATE CONSTRAINT placements_current_revision_fk;

CREATE TABLE IF NOT EXISTS config_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_key TEXT NOT NULL,
  client_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('paywall', 'placement', 'migration')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_pointer_id TEXT,
  to_pointer_id TEXT,
  actor TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT config_audit_log_client_fk
    FOREIGN KEY (client_id, project_key)
    REFERENCES clients(id, project_key)
);

CREATE INDEX IF NOT EXISTS idx_paywall_content_project_hash
  ON paywall_content_revisions(project_key, content_hash);
CREATE INDEX IF NOT EXISTS idx_paywall_content_document_key
  ON paywall_content_revisions(document_cache_key);
CREATE INDEX IF NOT EXISTS idx_paywall_bindings_client
  ON paywall_environment_bindings(client_id, paywall_id);
CREATE INDEX IF NOT EXISTS idx_paywall_releases_binding_created
  ON paywall_environment_releases(binding_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_placement_revisions_placement
  ON placement_revisions(placement_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_placement_revision_variants_revision
  ON placement_revision_variants(placement_revision_id, fallback_rank, variant_key);
CREATE INDEX IF NOT EXISTS idx_config_audit_entity
  ON config_audit_log(client_id, entity_type, entity_id, created_at DESC);

-- Revision, release, and audit rows are append-only. Exact no-op updates are
-- tolerated so idempotent backfill upserts can safely rediscover a legacy row.
CREATE OR REPLACE FUNCTION reject_immutable_config_write()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paywall_content_revisions_immutable ON paywall_content_revisions;
CREATE TRIGGER paywall_content_revisions_immutable
  BEFORE UPDATE OR DELETE ON paywall_content_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_config_write();

DROP TRIGGER IF EXISTS paywall_environment_releases_immutable ON paywall_environment_releases;
CREATE TRIGGER paywall_environment_releases_immutable
  BEFORE UPDATE OR DELETE ON paywall_environment_releases
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_config_write();

DROP TRIGGER IF EXISTS placement_revisions_immutable ON placement_revisions;
CREATE TRIGGER placement_revisions_immutable
  BEFORE UPDATE OR DELETE ON placement_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_config_write();

DROP TRIGGER IF EXISTS placement_revision_variants_immutable ON placement_revision_variants;
CREATE TRIGGER placement_revision_variants_immutable
  BEFORE UPDATE OR DELETE ON placement_revision_variants
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_config_write();

DROP TRIGGER IF EXISTS config_audit_log_immutable ON config_audit_log;
CREATE TRIGGER config_audit_log_immutable
  BEFORE UPDATE OR DELETE ON config_audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_config_write();

-- Pointer moves and the environment cutover use the client row as their lock
-- order boundary. This makes a legacy/V2 comparison and concurrent publish
-- serialize even when SQL is issued outside the HTTP application.
CREATE OR REPLACE FUNCTION lock_config_owner_for_pointer_write()
RETURNS trigger AS $$
DECLARE
  owner_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'paywall_environment_bindings' THEN
    owner_id := NEW.client_id;
  ELSE
    owner_id := NEW.client_id;
  END IF;
  PERFORM 1 FROM clients WHERE id = owner_id FOR SHARE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paywall_binding_pointer_owner_lock ON paywall_environment_bindings;
CREATE TRIGGER paywall_binding_pointer_owner_lock
  BEFORE UPDATE OF current_release_id ON paywall_environment_bindings
  FOR EACH ROW EXECUTE FUNCTION lock_config_owner_for_pointer_write();

DROP TRIGGER IF EXISTS placement_pointer_owner_lock ON placements;
CREATE TRIGGER placement_pointer_owner_lock
  BEFORE UPDATE OF current_revision_id ON placements
  FOR EACH ROW EXECUTE FUNCTION lock_config_owner_for_pointer_write();

-- Once an environment is locked or cut over, every legacy write path is
-- rejected at the database boundary, including old scripts that bypass HTTP.
CREATE OR REPLACE FUNCTION reject_frozen_legacy_config_write()
RETURNS trigger AS $$
DECLARE
  old_owner_id TEXT;
  new_owner_id TEXT;
  owner_id TEXT;
  owner_status TEXT;
  owner_source TEXT;
BEGIN
  IF TG_TABLE_NAME = 'paywall_specs' THEN
    IF TG_OP <> 'INSERT' THEN old_owner_id := OLD.workspace_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_owner_id := NEW.workspace_id; END IF;
  ELSIF TG_TABLE_NAME = 'placements' THEN
    IF TG_OP <> 'INSERT' THEN old_owner_id := OLD.client_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_owner_id := NEW.client_id; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      SELECT p.client_id INTO old_owner_id
        FROM placements p WHERE p.id = OLD.placement_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT p.client_id INTO new_owner_id
        FROM placements p WHERE p.id = NEW.placement_id;
    END IF;
  END IF;

  FOREACH owner_id IN ARRAY ARRAY[old_owner_id, new_owner_id] LOOP
    IF owner_id IS NULL THEN CONTINUE; END IF;
    SELECT management_status, config_source
      INTO owner_status, owner_source
      FROM clients
     WHERE id = owner_id
     FOR SHARE;

    IF owner_status = 'legacy_locked' THEN
      RAISE EXCEPTION 'legacy config is read-only for client %', owner_id
        USING ERRCODE = '55000';
    END IF;

    IF owner_source = 'v2' THEN
      -- Keep the placement-only field references inside their own branch.
      -- NEW is a polymorphic record here; referencing NEW.enabled while this
      -- trigger is running for paywall_specs raises 42703 before boolean
      -- short-circuiting can protect it.
      IF TG_TABLE_NAME = 'placements' AND TG_OP = 'INSERT' THEN
        IF NEW.enabled = false
           AND NEW.status = 'paused'
           AND NEW.spec IS NULL
           AND NEW.default_spec_id IS NULL
           AND NEW.variant_id IS NULL
           AND NEW.experiment_id IS NULL
           AND NEW.statsig_experiment_id IS NULL
           AND NEW.current_revision_id IS NULL
           AND NEW.targeting_rules = '[]'::jsonb THEN
          CONTINUE;
        END IF;
      END IF;
      RAISE EXCEPTION 'legacy config is read-only for client %', owner_id
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paywall_specs_reject_frozen_write ON paywall_specs;
CREATE TRIGGER paywall_specs_reject_frozen_write
  BEFORE INSERT OR UPDATE OR DELETE ON paywall_specs
  FOR EACH ROW EXECUTE FUNCTION reject_frozen_legacy_config_write();

DROP TRIGGER IF EXISTS placements_reject_frozen_write ON placements;
CREATE TRIGGER placements_reject_frozen_write
  BEFORE INSERT OR DELETE OR UPDATE OF
    public_key, client_id, project_key, trigger, enabled, variant_id, experiment_id, spec, status,
    default_spec_id, statsig_experiment_id, targeting_rules
  ON placements
  FOR EACH ROW EXECUTE FUNCTION reject_frozen_legacy_config_write();

DROP TRIGGER IF EXISTS placement_variants_reject_frozen_write ON placement_variants;
CREATE TRIGGER placement_variants_reject_frozen_write
  BEFORE INSERT OR UPDATE OR DELETE ON placement_variants
  FOR EACH ROW EXECUTE FUNCTION reject_frozen_legacy_config_write();
