import type { PaywallSpec, AssetManifest } from "./spec.js";

export interface PlacementConfig {
  trigger: string;
  enabled: boolean;
  placementId?: string;
  placement_id?: string;
  variantId: string;
  variantKey?: string;
  variant_key?: string;
  spec: PaywallSpec;
}

export interface ConfigResponse {
  version: string;
  placements: Record<string, PlacementConfig | null>;
  assets: AssetManifest;
  ttl: number;
  _meta?: {
    config_version: string;
    fetched_at: string;
    cache_ttl_seconds: number;
    document_delivery?: "inline" | "hosted" | "hosted+inline";
  };
}
