import type { ReactNode } from "react";
import type { PlacementConfig, ProductSpec } from "@tranzmit/shared";

export type PresentationMode = "modal" | "sheet" | "inline";

export interface TranzmitProviderProps {
  publicKey: string;
  userId?: string;
  identifiers?: Record<string, string>;
  userTraits?: Record<string, unknown>;
  privateTraits?: Record<string, unknown>;
  apiBaseUrl?: string;
  onError?: (error: Error) => void;
  debug?: boolean;
  children: ReactNode;
}

export interface GateOptions {
  onCTA?: (product: ProductSpec) => void;
  onDismiss?: () => void;
  onImpression?: () => void;
  presentation?: PresentationMode;
}

export interface GateResult {
  shown: boolean;
  variantId?: string;
  dismiss: () => void;
}

export interface ReportConversionData {
  trigger?: string;
  variantId?: string;
  productId?: string;
  revenue?: number;
  currency?: string;
  [key: string]: unknown;
}

export interface TranzmitContextValue {
  isReady: boolean;
  ready: boolean;
  gate: (trigger: string, options?: GateOptions) => GateResult;
  track: (event: string, properties?: Record<string, unknown>) => void;
  reportConversion: (data: ReportConversionData) => void;
  refreshConfig: () => Promise<void>;
  flush: () => Promise<void>;
  getPlacement: (trigger: string) => PlacementConfig | null;
}

export interface ActivePaywall {
  id: string;
  trigger: string;
  placement: PlacementConfig;
  presentation: PresentationMode;
  options: GateOptions;
  shownAt: number;
}
