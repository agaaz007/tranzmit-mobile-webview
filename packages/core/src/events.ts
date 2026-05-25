import type { TranzmitConfig } from "./types.js";
import type { TranzmitIdentity } from "@tranzmit/shared";
import { resolveApiBaseUrl } from "./runtime.js";

interface QueuedEvent {
  event: string;
  timestamp: number;
  properties?: Record<string, unknown>;
}

const MAX_BATCH = 10;
const FLUSH_INTERVAL_MS = 2000;

let queue: QueuedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let currentConfig: TranzmitConfig | null = null;
let currentIdentity: TranzmitIdentity | null = null;
let sessionId = "";

export function initEvents(config: TranzmitConfig, sid: string, identity: TranzmitIdentity): void {
  currentConfig = config;
  currentIdentity = identity;
  sessionId = sid;
}

export function queueEvent(
  event: string,
  properties?: Record<string, unknown>
): void {
  if (!currentConfig) return;

  queue.push({ event, timestamp: Date.now(), properties });

  if (queue.length >= MAX_BATCH) {
    flush();
  } else if (!timer) {
    timer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }
}

export function flush(useBeacon = false): void {
  if (!currentConfig || queue.length === 0) return;

  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  const batch = queue.splice(0, queue.length);
  const payload = JSON.stringify({
    publicKey: currentConfig.publicKey,
    userId: currentConfig.userId,
    identity: currentIdentity || undefined,
    traits: currentConfig.userTraits || {},
    privateTraits: currentConfig.privateTraits || {},
    sessionId,
    events: batch,
  });

  const base = resolveApiBaseUrl(currentConfig.apiBaseUrl);
  const url = `${base}/v1/events`;

  if (useBeacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const sent = navigator.sendBeacon(url, payload);
    if (!sent) {
      queue.unshift(...batch);
    }
    return;
  }

  if (typeof fetch !== "function") {
    queue.unshift(...batch);
    return;
  }

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    keepalive: true,
    body: payload,
  }).catch(() => {
    queue.unshift(...batch);
  });
}

export function setupPageUnloadFlush(): void {
  if (typeof window === "undefined") return;
  if ((window as any).__tranzmitPagehideFlushInstalled) return;
  (window as any).__tranzmitPagehideFlushInstalled = true;
  window.addEventListener("pagehide", () => flush(true));
}
