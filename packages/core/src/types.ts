import type { ProductSpec, ConfigResponse, TranzmitIdentity } from "@tranzmit/shared";

export interface TranzmitConfig {
  publicKey: string;
  userId?: string;
  identifiers?: Record<string, string>;
  userTraits?: Record<string, unknown>;
  privateTraits?: Record<string, unknown>;
  apiBaseUrl?: string;
  onError?: (error: TranzmitError) => void;
  debug?: boolean;
}

export interface GateOptions {
  container?: HTMLElement;
  onCTA?: (product: ProductSpec) => void;
  onDismiss?: () => void;
  onImpression?: () => void;
}

export interface GateResult {
  shown: boolean;
  variantId?: string;
  dismiss: () => void;
}

export interface TranzmitError extends Error {
  name: "TranzmitError";
  code: string;
  recoverable: boolean;
}

export interface SDKState {
  config: TranzmitConfig | null;
  identity: TranzmitIdentity | null;
  configResponse: ConfigResponse | null;
  sessionId: string;
  initialized: boolean;
  initializing: boolean;
  pendingEvents: Array<{ event: string; timestamp: number; properties?: Record<string, unknown> }>;
  eventTimer: ReturnType<typeof setTimeout> | null;
  activePaywalls: Map<string, { dismiss: () => void }>;
}
