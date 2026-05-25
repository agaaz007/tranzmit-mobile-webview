CREATE TABLE IF NOT EXISTS placement_variants (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  placement_id TEXT NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  fallback_rank INTEGER DEFAULT 0,
  spec JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(placement_id, variant_id)
);

INSERT INTO placement_variants (placement_id, variant_id, enabled, fallback_rank, spec)
SELECT id, variant_id, true, 0, spec
FROM placements
ON CONFLICT (placement_id, variant_id) DO NOTHING;

ALTER TABLE events ADD COLUMN IF NOT EXISTS identity JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_placement_variants_placement ON placement_variants(placement_id);
CREATE INDEX IF NOT EXISTS idx_placement_variants_variant ON placement_variants(variant_id);
