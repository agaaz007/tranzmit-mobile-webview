import type { IncomingMessage, ServerResponse } from "node:http";
import { query } from "../db.js";
import { checkAdminAuth } from "../middleware/auth.js";

export async function handleUsage(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!checkAdminAuth(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const clientKey = url.searchParams.get("client");
  const period = url.searchParams.get("period") || "30d";

  const days = parseInt(period) || 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  if (clientKey) {
    const result = await query<{
      event_name: string;
      count: string;
      unique_users: string;
    }>(
      `SELECT event_name, COUNT(*)::text as count, COUNT(DISTINCT user_id)::text as unique_users
       FROM events
       WHERE public_key = $1 AND created_at >= $2
       GROUP BY event_name
       ORDER BY count DESC`,
      [clientKey, since]
    );

    const daily = await query<{ day: string; impressions: string; cta_clicks: string }>(
      `SELECT
         DATE(created_at)::text as day,
         COUNT(*) FILTER (WHERE event_name = 'impression')::text as impressions,
         COUNT(*) FILTER (WHERE event_name = 'cta_click')::text as cta_clicks
       FROM events
       WHERE public_key = $1 AND created_at >= $2
       GROUP BY DATE(created_at)
       ORDER BY day DESC
       LIMIT 30`,
      [clientKey, since]
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      client: clientKey,
      period: `${days}d`,
      summary: result.rows,
      daily: daily.rows,
    }));
    return;
  }

  // All clients summary
  const result = await query<{
    public_key: string;
    name: string;
    impressions: string;
    cta_clicks: string;
    conversions: string;
    unique_users: string;
  }>(
    `SELECT
       c.public_key,
       c.name,
       COUNT(*) FILTER (WHERE e.event_name = 'impression')::text as impressions,
       COUNT(*) FILTER (WHERE e.event_name = 'cta_click')::text as cta_clicks,
       COUNT(*) FILTER (WHERE e.event_name = 'conversion')::text as conversions,
       COUNT(DISTINCT e.user_id)::text as unique_users
     FROM clients c
     LEFT JOIN events e ON e.public_key = c.public_key AND e.created_at >= $1
     GROUP BY c.public_key, c.name
     ORDER BY impressions DESC`,
    [since]
  );

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    period: `${days}d`,
    clients: result.rows,
  }));
}
