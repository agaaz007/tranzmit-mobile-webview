-- Publish preflight: the recorded result of validating one immutable release
-- against the exact environment binding it would be published into.
--
-- The row is keyed by the release plus a fingerprint of the content and the
-- environment products, so a report can never outlive the bytes it validated.
-- publishPaywallRelease() refuses to move a pointer without a matching passing
-- row, which is what makes the dashboard's Publish button safe to press.

CREATE TABLE IF NOT EXISTS paywall_release_preflights (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  release_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  products_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'warn', 'fail')),
  report JSONB NOT NULL,
  checked_by TEXT NOT NULL DEFAULT 'api',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT paywall_release_preflights_release_fk
    FOREIGN KEY (release_id, binding_id)
    REFERENCES paywall_environment_releases(id, binding_id)
    ON DELETE CASCADE
);

-- One current verdict per (release, exact bytes, exact products). Re-running
-- preflight replaces the previous verdict rather than accumulating rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_paywall_release_preflights_fingerprint
  ON paywall_release_preflights(release_id, content_hash, products_hash);

CREATE INDEX IF NOT EXISTS idx_paywall_release_preflights_binding
  ON paywall_release_preflights(binding_id, created_at DESC);
