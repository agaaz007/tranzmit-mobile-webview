# Safe Paywall Publishing V2 rollout

This is the production runbook for moving one Tranzmit environment from the legacy configuration tables to the additive V2 publisher. V2 does not delete or rewrite legacy configuration, and it does not modify the `events` table. Do not combine this rollout with legacy cleanup.

## Hard gates

Do not begin the production deploy until all of these are true:

- The Railway PostgreSQL volume has been resized to **at least 20 GB**. The current database is roughly 4 GB; do not attempt the migration on the old small-volume limit.
- Railway backup/PITR is enabled, a recovery point from immediately before the rollout is recorded, and its retention window covers the rollout.
- A restore drill from that backup has succeeded into a separate throwaway PostgreSQL service. Verify that the restored database starts, the four client rows exist, and historical events are queryable. Never run the drill against production.
- `PUBLIC_API_BASE_URL` is set on every process that migrates, backfills, compares, or serves configuration, and is the exact canonical public origin: `https://api.tranzmitai.com` (no trailing slash). A different origin changes immutable document URLs and hashes.
- Fresh, distinct values are present for `ADMIN_SECRET` and `DASHBOARD_PASSWORD`.

Record the volume size, recovery-point timestamp, restore target, restore result, deployed commit, and operator in the rollout ticket.

Run this against the throwaway restore, never production:

```bash
psql "$RESTORE_DATABASE_URL" --set ON_ERROR_STOP=1 \
  --command "SELECT COUNT(*) AS clients FROM clients" \
  --command "SELECT id, public_key, event_name, created_at FROM events ORDER BY id DESC LIMIT 1"
```

## Deployment order

The order is deliberate. Stop at the first failed check.

### 1. Deploy and verify auth hardening

Deploy the fail-closed admin/dashboard auth and CORS patch while every client still has `config_source = 'legacy'`. Verify:

```bash
curl --fail --silent --show-error "$PUBLIC_API_BASE_URL/health" | jq .

# Must be rejected.
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  "$PUBLIC_API_BASE_URL/admin/clients"

# Must return 200 with the admin credential.
curl --fail --silent --show-error \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  "$PUBLIC_API_BASE_URL/admin/clients" | jq .
```

Do not proceed if an unauthenticated admin request succeeds or the health probe is degraded.

### 2. Deploy V2; let the migration run as the Railway pre-deploy command

`railway.toml` runs `npm run migrate` before application startup. Migrations `007_paywall_publishing_v2.sql` (the V2 tables) and `008_paywall_release_preflight.sql` (recorded publish verdicts) are additive and serialized with a PostgreSQL advisory lock. The application must not start if migration fails.

Verify the migration and its idempotence from the release image or an equivalent one-off Railway command:

```bash
npm run migrate
npm run migrate
npm run build
npm test
```

Then verify the production database:

```sql
SELECT id, applied_at
FROM schema_migrations
WHERE id = '007_paywall_publishing_v2.sql';

SELECT public_key, project_key, environment_kind, management_status, config_source
FROM clients
ORDER BY project_key, environment_kind;

SELECT COUNT(*) AS legacy_specs FROM paywall_specs;
SELECT COUNT(*) AS legacy_events FROM events;
```

All four environments must still report `config_source = 'legacy'`. Both Influish environments must report `management_status = 'legacy_locked'`; they are backfilled and can later switch resolver source, but remain read-only in the dashboard throughout.

### 3. Backfill V2 without cutting over

Run from the deployed release with the production `DATABASE_URL` and canonical `PUBLIC_API_BASE_URL`:

```bash
npm run backfill:config-v2 | tee config-v2-backfill.json
npm run backfill:config-v2 | tee config-v2-backfill-rerun.json
```

The first run must report all four clients, all 74 legacy specs, and all 8 placements. It must also report:

```json
{
  "config_source_changed": false,
  "events_changed": false
}
```

The second run is the idempotence check. It must not move a pointer that was published manually after backfill. Do not cut over an environment while `blocking_validation_failures` is non-empty. Record and review `retained_validation_warnings`; these are preserved inactive or archived legacy rows and do not block a resolver cutover unless an operator confirms they can still be served.

Confirm the intentional HiAstro mapping:

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  "$PUBLIC_API_BASE_URL/admin/paywalls?public_key=pk_test_320da03ab659ffc56d58acd2" \
  | jq '[.[] | select(.paywall_key == "trial-reminder" or .paywall_key == "marriage") | {paywall_key,current_release_id}]'
```

`marriage-02` must be represented by `trial-reminder`, and `marriage-03` by `marriage`. Both must have a published release.

### 4. Require an exact comparator pass

Run the global comparison, then the HiAstro test comparison independently:

```bash
npm run compare:config-v2 | tee config-v2-compare-all.json
npm run compare:config-v2 -- pk_test_320da03ab659ffc56d58acd2 \
  | tee config-v2-compare-hiastro-test.json
```

Both commands must exit zero and print `"passed": true`. Preserve their legacy and V2 hashes in the rollout ticket. A mismatch, missing release, document-integrity inconsistency, or localization coverage failure blocks cutover.

### 5. Cut over HiAstro test first

Find and record the test environment ID:

```bash
TEST_CLIENT_ID="$({ curl --fail --silent --show-error \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  "$PUBLIC_API_BASE_URL/admin/v2/environments"; } \
  | jq -r '.[] | select(.public_key == "pk_test_320da03ab659ffc56d58acd2") | .id')"
test -n "$TEST_CLIENT_ID"
```

Cut over with compare-and-swap semantics:

```bash
curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  "$PUBLIC_API_BASE_URL/admin/v2/environments/$TEST_CLIENT_ID/source" \
  -d '{"source":"v2","expectedConfigSource":"legacy"}' | jq .
```

The endpoint reruns the comparator while holding the environment lock. It returns a conflict or validation error instead of switching on stale state.

Exercise the real SDK against the test public key and every active trigger. At minimum verify config fetch, both marriage variants, all three active locale tags (`en`, `hi`, and `hi-Latn`), CTA billing product IDs, close/fallback behavior, document integrity, and that historical published document URLs still load. Also verify a regional Latin-Hindi device locale such as `hi-Latn-IN` resolves through `hi-Latn`. A direct config smoke check is:

```bash
curl --fail --silent --show-error \
  -X POST \
  -H 'Content-Type: application/json' \
  "$PUBLIC_API_BASE_URL/v1/config" \
  -d '{"publicKey":"pk_test_320da03ab659ffc56d58acd2","userId":"config-v2-rollout-smoke"}' \
  | jq '{version, placements: [.placements[] | select(. != null) | {trigger, variantId, productIds: [.spec.products[]?.id], documentUrl: .spec.document.url, integrity: .spec.document.integrity}]}'
```

The public response intentionally contains only the selected variant. Verify the complete routing graph, including the marriage-02 and marriage-03 bindings, through `GET /admin/v2/placements?public_key=...` before relying on the selected-variant smoke result.

Leave test on V2 long enough to complete the agreed observation window. Check Railway errors, config resolution, document fetches, CTA events, and conversions. Do not edit live while test is under review.

After the HiAstro test checks pass, repeat the comparator, CAS source switch, and SDK smoke checks for Influish Demo (`pk_test_2a8a5f07d4b9fcf1cc77e024`). Its configuration remains `legacy_locked`; source cutover does not make it editable.

### 6. Manually verify and cut over HiAstro live

Immediately before live cutover:

1. Re-run `npm run compare:config-v2 -- pk_live_310bc7653631b8b924afbad3` and require an exit-zero `passed: true` result.
2. Open the live environment in `/config-dashboard` and inspect the exact stored HTML, localization, products, checkout, placement routing, and diffs. Do not regenerate HTML during promotion.
3. Confirm live product and checkout values are still live values. Promotion copies content only; it must not copy test billing data.
4. Complete real-device manual QA for `en`, `hi`, and `hi-Latn` (including a `hi-Latn-IN` fallback check), marriage-02/trial-reminder, marriage-03/marriage, CTA behavior, and dismiss/fallback behavior.

Find the live environment ID and perform the same CAS source switch:

```bash
LIVE_CLIENT_ID="$({ curl --fail --silent --show-error \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  "$PUBLIC_API_BASE_URL/admin/v2/environments"; } \
  | jq -r '.[] | select(.public_key == "pk_live_310bc7653631b8b924afbad3") | .id')"
test -n "$LIVE_CLIENT_ID"

curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  "$PUBLIC_API_BASE_URL/admin/v2/environments/$LIVE_CLIENT_ID/source" \
  -d '{"source":"v2","expectedConfigSource":"legacy"}' | jq .
```

Repeat the live SDK smoke tests immediately after the switch and monitor errors, config resolution, document fetches, CTA events, and conversions.

### 7. Cut over Influish Production last

Only after HiAstro live is stable, run the comparator and equivalent SDK checks for Influish Production (`pk_live_a1323f76d397778b6ed5eb04`), then apply the same CAS switch from `legacy` to `v2`. Keep `management_status = 'legacy_locked'`. Any Influish comparator or smoke-test failure leaves that environment on legacy and does not block rollback of another environment.

## Publishing a paywall from the dashboard

The intended day-to-day flow at `/config-dashboard` is: pick the paywall, drop its exported folder, press **Submit**, read the report, press **Publish**.

**Submit** does four things, in order:

1. Builds the exact document in the browser: resolves every `assets/...` reference, re-encodes images to WebP inside their size class, inlines them, tags the CTA with `data-tranzmit-action="cta"` if the export forgot to, optionally bakes the full-bleed flatten layer for legacy `.device` / `.screen` skeletons, and computes the SHA-256 integrity over the final bytes.
2. Composes the candidate through the SDK's real `renderDocument()` at **every configured locale** across the seven-device matrix, and audits each render in-frame.
3. Sends the candidate plus those verdicts to `POST /admin/paywalls/:bindingId/validate`, which returns a report without writing anything.
4. If nothing failed, creates the immutable candidate release and records the verdict against its exact content and products hash.

### The rendering harness is shared with authoring

Step 2 does not use a dashboard-specific renderer. `scripts/vendor-preview-harness.mjs` vendors two files out of the SDK repo's `templates/preview` into `packages/server/public/config-dashboard`:

- `responsive.mjs` — copied verbatim. It owns `RESPONSIVE_DEVICES` (320, 360, 375, 390, 412, 430 phone widths plus iPad, each with its own safe-area insets and DPR) and `injectResponsiveAudit()`, which checks horizontal overflow, painted text overflow, component-bound overflow, billing copy/price collisions, reminder/toggle collisions, insight collisions, CTA presence and fit, broken images, unresolved localization tokens, and forbidden bridge controls.
- `compose.bundle.js` — an esbuild bundle of the SDK's `renderDocument` and `resolveTheme`. `compose.ts` is deliberately free of react-native imports, so the same composer runs in the app, in the authoring harness, and here.

`preview-harness.json` records the SDK version and a hash per file, and `tests/preview-harness-vendoring.test.ts` fails when a vendored file drifts or when `REQUIRED_PROBE_WIDTHS` stops matching the phone widths the matrix renders. Re-vendor with:

```bash
TRANZMIT_RN_SDK=/path/to/tranzmit-react-native-sdk npm run vendor:preview-harness
```

This matters because a raw browser render is not what users see. It misses safe areas, the SDK wrapper CSS, localization, and the real usable height — the first entry in the harness's own `RESPONSIVE_LEARNINGS`. Measuring the raw file would pass paywalls that break on device.

Two consequences worth knowing:

- **The harness frame is on-screen during Submit, by necessity.** Chrome throttles rendering in off-screen cross-origin frames, and the sandbox makes the frame cross-origin, so an off-screen harness never receives a `requestAnimationFrame` and every render times out. It is `position: fixed` so scrolling cannot throttle it.
- **A render that does not report back is a failure**, never a pass.

The remaining checks live in `packages/server/src/paywall-preflight.ts`: spec schema, document bytes and integrity, localization coverage per locale, unresolved and remote assets, the CTA bridge, bridge actions, billing product IDs, the responsive authoring rules, and rendering coverage.

Three of them are the reason this exists at all:

- **Billing.** A live environment fails if it carries the sibling test environment's Billing Product ID, if any product ID is a placeholder, or if the document's `data-product-id` names a SKU this environment does not sell.
- **Device rendering.** A publish is refused unless every configured locale was rendered at all six phone widths. One locale proves nothing about the others: a missing token renders as an empty string and can change the layout.
- **Bridge actions.** `data-tranzmit-action` values outside `cta`, `dismiss`, `custom_action`, and `open_url` fail. That is how a `back` control reintroduced by a re-export is caught — it is markup the SDK will never route. A paywall can also set `metadata.forbidBackAction: "true"` to name the contract explicitly.

**Publish** then moves one pointer, and `POST /v1/config` serves the new release to every user in that environment within `CONFIG_TTL_SECONDS` (60s by default) plus whatever the SDK holds in its own cache. Document URLs stay content-addressed and immutable, so an old URL keeps returning its old payload.

`publishPaywallRelease` refuses to move a pointer without a recorded non-failing verdict for the release's exact content and products. Two deliberate exemptions:

- **Rollback** is never gated. The target already served real traffic, and requiring a fresh verdict would slow down the fastest way out of a bad publish.
- `PAYWALL_PUBLISH_PREFLIGHT=warn` logs instead of blocking, and `=off` disables the gate entirely, for incident response when no browser is available to measure a render. Leave it unset (`enforce`) otherwise.

Changing an environment's products invalidates the verdict, because the fingerprint covers products and checkout as well as content. Re-run Submit after editing billing fields.

## Rollback

Rollback is an environment pointer switch. It does not delete V2 revisions, releases, audit rows, or immutable document URLs. For the affected environment:

```bash
curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  "$PUBLIC_API_BASE_URL/admin/v2/environments/$LIVE_CLIENT_ID/source" \
  -d '{"source":"legacy","expectedConfigSource":"v2"}' | jq .
```

Use `TEST_CLIENT_ID` instead for test. Verify `/v1/config` immediately after rollback and record the cutover audit entry. Do not roll back by editing or deleting V2 rows, restoring the whole production database, or changing legacy tables unless a separate incident procedure requires it.

## Post-rollout invariants

- Keep `paywall_specs`, `placements`, and `placement_variants` intact until a separately reviewed cleanup migration.
- Never truncate, rewrite, or migrate `events` as part of V2 publishing.
- Keep both Influish environments `legacy_locked`; backfill exists to preserve their legacy data, not to make them dashboard-editable.
- Keep `PUBLIC_API_BASE_URL` stable. Changing it after publication changes document URL semantics for new revisions.
- Retain the pre-rollout backup/PITR recovery point through the full observation window.
