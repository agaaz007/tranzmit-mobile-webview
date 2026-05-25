import type { TranzmitIdentity } from "./identity.js";

export interface TranzmitEvent {
  event: string;
  timestamp: number;
  properties?: Record<string, unknown>;
  trigger?: string;
  variantId?: string;
}

export interface EventBatch {
  publicKey: string;
  userId?: string;
  identity?: TranzmitIdentity;
  traits?: Record<string, unknown>;
  privateTraits?: Record<string, unknown>;
  sessionId: string;
  events: TranzmitEvent[];
}

export type EventName =
  | "impression"
  | "dismissal"
  | "cta_click"
  | "conversion"
  | "page_view"
  | string;
