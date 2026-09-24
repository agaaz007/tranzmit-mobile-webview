-- Opt-in native fixed-split assignment per placement revision.
--
-- assignment_mode = 'statsig' (the default, and every existing row) keeps the
-- Statsig baseline/Autotune resolution byte-for-byte. 'fixed_split' serves by a
-- deterministic weighted hash over placement_revision_variants.weight with an
-- optional holdout, and never consults Statsig for that placement.
--
-- Additive and idempotent: columns use IF NOT EXISTS with constant defaults
-- (no table rewrite, and no UPDATE, so the immutable-row triggers from 007 are
-- not involved); constraints are dropped and re-added. Revisions remain
-- append-only: changing the mode means publishing a new revision.

ALTER TABLE placement_revisions
  ADD COLUMN IF NOT EXISTS assignment_mode TEXT NOT NULL DEFAULT 'statsig',
  ADD COLUMN IF NOT EXISTS holdout_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS assignment_salt TEXT;

ALTER TABLE placement_revisions
  DROP CONSTRAINT IF EXISTS placement_revisions_assignment_mode_check,
  ADD CONSTRAINT placement_revisions_assignment_mode_check
    CHECK (assignment_mode IN ('statsig', 'fixed_split')) NOT VALID,
  DROP CONSTRAINT IF EXISTS placement_revisions_holdout_percent_check,
  ADD CONSTRAINT placement_revisions_holdout_percent_check
    CHECK (
      holdout_percent >= 0
      AND holdout_percent <= 50
      AND (assignment_mode = 'fixed_split' OR holdout_percent = 0)
    ) NOT VALID,
  DROP CONSTRAINT IF EXISTS placement_revisions_assignment_salt_check,
  ADD CONSTRAINT placement_revisions_assignment_salt_check
    CHECK (
      assignment_salt IS NULL
      OR (assignment_mode = 'fixed_split' AND assignment_salt ~ '^[A-Za-z0-9._:-]{1,128}$')
    ) NOT VALID;

ALTER TABLE placement_revisions VALIDATE CONSTRAINT placement_revisions_assignment_mode_check;
ALTER TABLE placement_revisions VALIDATE CONSTRAINT placement_revisions_holdout_percent_check;
ALTER TABLE placement_revisions VALIDATE CONSTRAINT placement_revisions_assignment_salt_check;

-- Per-variant trait conditions for fixed_split (same semantics as a targeting
-- rule's "when"). NULL means eligible for every unit.
ALTER TABLE placement_revision_variants
  ADD COLUMN IF NOT EXISTS eligibility JSONB;

ALTER TABLE placement_revision_variants
  DROP CONSTRAINT IF EXISTS placement_revision_variants_eligibility_check,
  ADD CONSTRAINT placement_revision_variants_eligibility_check
    CHECK (eligibility IS NULL OR jsonb_typeof(eligibility) = 'object') NOT VALID;

ALTER TABLE placement_revision_variants
  VALIDATE CONSTRAINT placement_revision_variants_eligibility_check;
