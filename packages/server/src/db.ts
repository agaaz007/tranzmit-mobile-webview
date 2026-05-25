import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function getPlacementsForKey(publicKey: string) {
  const result = await query<{
    id: string;
    trigger: string;
    enabled: boolean;
    status: "active" | "paused" | "archived";
    placement_id: string;
    default_variant_id: string;
    experiment_id: string | null;
    statsig_project_name: string | null;
    statsig_server_secret_env_var: string;
    spec: unknown;
    variants: Array<{
      id: string;
      variant_id: string;
      enabled: boolean;
      fallback_rank: number;
      status: "active" | "paused";
      spec: unknown;
    }>;
  }>(
    `SELECT
       p.id,
       p.id AS placement_id,
       p.trigger,
       (COALESCE(p.status, CASE WHEN p.enabled THEN 'active' ELSE 'paused' END) = 'active') AS enabled,
       COALESCE(p.status, CASE WHEN p.enabled THEN 'active' ELSE 'paused' END) AS status,
       p.variant_id AS default_variant_id,
       COALESCE(p.statsig_experiment_id, p.experiment_id) AS experiment_id,
       c.statsig_project_name,
       COALESCE(NULLIF(c.statsig_server_secret_env_var, ''), 'STATSIG_SERVER_SECRET') AS statsig_server_secret_env_var,
       CASE
         WHEN p.default_spec_id IS NOT NULL THEN default_spec.spec
         ELSE p.spec
       END AS spec,
       COALESCE(
         json_agg(
           json_build_object(
             'id', pv.id,
             'variant_id', COALESCE(pv.variant_key, pv.variant_id),
             'enabled', (COALESCE(pv.status, CASE WHEN pv.enabled THEN 'active' ELSE 'paused' END) = 'active'),
             'fallback_rank', pv.fallback_rank,
             'status', COALESCE(pv.status, CASE WHEN pv.enabled THEN 'active' ELSE 'paused' END),
             'spec', CASE
               WHEN pv.spec_id IS NOT NULL THEN variant_spec.spec
               ELSE pv.spec
             END
           )
           ORDER BY
             CASE WHEN COALESCE(pv.variant_key, pv.variant_id) = p.variant_id THEN 0 ELSE 1 END,
             pv.fallback_rank ASC,
             pv.created_at ASC
         ) FILTER (WHERE pv.id IS NOT NULL AND (pv.spec_id IS NULL OR variant_spec.id IS NOT NULL)),
         '[]'::json
       ) AS variants
     FROM placements p
     JOIN clients c ON c.public_key = p.public_key
     LEFT JOIN paywall_specs default_spec
       ON default_spec.id = p.default_spec_id
      AND default_spec.status <> 'archived'
     LEFT JOIN placement_variants pv
       ON pv.placement_id = p.id
      AND COALESCE(pv.status, CASE WHEN pv.enabled THEN 'active' ELSE 'paused' END) = 'active'
     LEFT JOIN paywall_specs variant_spec
       ON variant_spec.id = pv.spec_id
      AND variant_spec.status <> 'archived'
     WHERE p.public_key = $1
       AND COALESCE(p.status, CASE WHEN p.enabled THEN 'active' ELSE 'paused' END) <> 'archived'
     GROUP BY p.id, default_spec.spec, c.statsig_project_name, c.statsig_server_secret_env_var
     ORDER BY p.created_at DESC`,
    [publicKey]
  );
  return result.rows;
}

export async function getWorkspaceForPublicKey(publicKey: string): Promise<{
  id: string;
  public_key: string;
  secret_key: string;
  name: string;
} | null> {
  const result = await query<{
    id: string;
    public_key: string;
    secret_key: string;
    name: string;
  }>(
    "SELECT id, public_key, secret_key, name FROM clients WHERE public_key = $1",
    [publicKey]
  );
  return result.rows[0] || null;
}

export async function validatePublicKey(publicKey: string): Promise<boolean> {
  const result = await query<{ id: string }>(
    "SELECT id FROM clients WHERE public_key = $1",
    [publicKey]
  );
  return result.rows.length > 0;
}

export async function insertEvents(
  publicKey: string,
  userId: string,
  sessionId: string,
  events: Array<{ event: string; timestamp: number; properties?: Record<string, unknown> }>,
  identity?: unknown
) {
  const values: unknown[] = [];
  const placeholders: string[] = [];

  events.forEach((evt, i) => {
    const offset = i * 6;
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`
    );
    values.push(publicKey, userId, sessionId, evt.event, JSON.stringify(evt.properties || {}), JSON.stringify(identity || {}));
  });

  await query(
    `INSERT INTO events (public_key, user_id, session_id, event_name, properties, identity)
     VALUES ${placeholders.join(", ")}`,
    values
  );
}

export { pool };
