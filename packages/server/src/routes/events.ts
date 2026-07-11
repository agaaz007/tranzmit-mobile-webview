import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventBatch } from "@tranzmit/shared";
import { insertEvents, validatePublicKey } from "../db.js";
import { readBody } from "../middleware/body-parser.js";
import { publicIdentity, resolveEventIdentity } from "../identity.js";
import { logStatsigEvents } from "../statsig.js";
import { eventBatchIdempotency } from "../event-batch-idempotency.js";

const MAX_EVENTS_PER_BATCH = 50;

export async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const raw = await readBody(req, 64 * 1024); // 64KB max for events

  let payload: Partial<EventBatch>;

  try {
    payload = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  if (!payload.publicKey || !payload.sessionId || !Array.isArray(payload.events)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing required fields: publicKey, sessionId, events[]" }));
    return;
  }

  const batch = payload as EventBatch;
  const identity = resolveEventIdentity(batch);
  if (!identity) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing identity: provide userId or identity.identifiers" }));
    return;
  }

  if (batch.events.length === 0) {
    res.writeHead(204);
    res.end();
    return;
  }

  if (batch.events.length > MAX_EVENTS_PER_BATCH) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Max ${MAX_EVENTS_PER_BATCH} events per batch` }));
    return;
  }

  try {
    const valid = await validatePublicKey(batch.publicKey);
    if (!valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid public key" }));
      return;
    }

    await eventBatchIdempotency.run(raw, async () => {
      await insertEvents(
        batch.publicKey,
        identity.storageUserId,
        batch.sessionId,
        batch.events,
        publicIdentity(identity)
      );
      await logStatsigEvents({
        publicKey: batch.publicKey,
        identity,
        sessionId: batch.sessionId,
        events: batch.events,
      });
    });
  } catch (err) {
    console.error("[Tranzmit] Failed to insert events:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
    return;
  }

  res.writeHead(204);
  res.end();
}
