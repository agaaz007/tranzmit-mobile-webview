export type {
  PaywallSpec,
  ProductSpec,
  AssetManifest,
} from "./spec.js";

export type {
  PlatformAdapter,
  PlatformMetadata,
} from "./adapter.js";

export type {
  PlacementConfig,
  ConfigResponse,
} from "./config.js";

export type {
  TranzmitIdentity,
  ConfigRequest,
} from "./identity.js";

export {
  resolveIdentity,
  stableJson,
  hashString,
} from "./identity.js";

export type {
  TranzmitEvent,
  EventBatch,
  EventName,
} from "./events.js";

export {
  DEFAULT_API_BASE_URL,
  createTranzmitClient,
  makeError,
  resolveApiBaseUrl,
  validatePublicKey,
  type InitConfig,
  type SharedClient,
  type TranzmitError,
} from "./client.js";
