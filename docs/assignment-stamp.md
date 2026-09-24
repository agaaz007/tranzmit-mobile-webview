# Assignment stamp and fixed-split assignment

Every `paywall_resolved` event records how each placement chose its variant and the probability of that choice, so a paywall readout can tell a randomized assignment from an adaptive or forced one. Placement revisions can also opt into a native **fixed split**, which is the only mechanism whose probabilities are exact and known at decision time.

Implementation: `packages/server/src/assignment.ts`. Spec: *PRD — Stamp the assignment propensity onto `paywall_resolved`* (2026-08-05). Where this deviates from the spec, see [Deviations from the spec](#deviations-from-the-spec).

## The stamp

`paywall_resolved.properties` keeps `intent`, `resolved` and `traits` exactly as before and gains:

- `assignment`: the decision for the **first** trigger listed in `resolved` (the same trigger `fallback-detector.ts` treats as the paywall placement).
- `other_assignments`: decisions for every further resolved trigger, in `resolved` order. Omitted when only one placement resolved.
- `assignment: null` when no placement resolved (all paused), so there is no decision to record.

Each decision:

| field | meaning |
|---|---|
| `schema_version` | `1` |
| `assignment_id` | `asg_` + 32 hex chars. Stable per unit × placement × revision (`legacy` for legacy routing). Dedupe and join key: the first row per `assignment_id` is the randomization; later rows are deterministic re-evaluations of the same draw. Recomputable as `sha256(JSON.stringify(["assignment-id-v1", placement_id, revision_id ?? "legacy", unit]))`. |
| `placement_id`, `revision_id`, `trigger` | what was decided. `revision_id` is null for legacy routing. |
| `chosen` | the served `variant_key`. Always equals the value `resolved` reports for this trigger. |
| `served` | false when the chosen variant's release was missing and the placement was served as `null`. |
| `mechanism` | the spec enum: `fixed_uniform`, `fixed_weighted`, `adaptive_bandit`, `holdout_forced`, `fallback_default` (`sticky_replay` is never emitted; see deviations). |
| `allocator` | which code path decided: `fixed_split_hash`, `statsig_baseline_holdout`, `statsig_autotune`, `static_default`. |
| `policy_id` | fixed split: `fixed_split:<salt>`; Statsig: the experiment id; static: `static:<placement_id>`. |
| `policy_version` | fixed split and static: `rev:<revision_id>` (revisions are immutable, so any allocation change is a new value). Statsig: `rev:<revision_id>\|statsig_lcut:<config sync time>` (`legacy\|...` for legacy routing); the Statsig config sync time changes whenever Statsig config, including Autotune allocation, changes. |
| `is_holdout` | true when the unit is in a holdout and was forced to the default variant. |
| `holdout_probability` | P(unit is in the holdout layer). Exact for fixed split, `0` when no holdout exists, `null` when a Statsig baseline split exists (the SDK does not expose it). |
| `probability_source` | `exact`: every `candidates[].probability` is a number and they sum to 1. `unknown`: every probability is `null`. |
| `unit_type` | the randomization unit: `user_id`, `stable_id` (anonymous device) or `storage_id`. Same unit as the Statsig `userID` and the event's `user_id` column. |
| `candidates[]` | every active routing arm: `variant_key`, `probability` (P(served \| the layer the unit landed in)), `weight` (raw stored weight when weights drive serving, else `null`), `eligible` (`false` = could not have been served to this unit, `null` = not observable). |
| `fallback_reason` | only on `fallback_default`: `no_eligible_variant`, `variant_not_in_routing`, `no_experiment_for_traits`, `statsig_unavailable`, `statsig_error`, `statsig_no_variant`. |
| `statsig` | Statsig paths only: `baseline` and `experiment` evaluations with `experiment_id`, `status`, the raw `variant_id` (and `use_autotune`), `rule_id`, `group_name`, `reason` and `config_sync_time` exactly as the SDK reports them. |

Probabilities are never rounded (1/3 is logged as `0.3333333333333333`) and never invented: when the allocator does not expose a probability, the stamp says `null`.

## Mechanisms and what a readout may assume

| allocator / mechanism | probabilities | what a readout may assume |
|---|---|---|
| `fixed_split_hash` / `fixed_uniform`, `fixed_weighted` | exact | Randomized with known, constant propensities within a `policy_version`. **Supports unbiased intent-to-treat readouts** (dedupe by `assignment_id`; compare arms within the same `policy_version` and eligibility set, or reweight by `1/probability`). |
| `fixed_split_hash` / `holdout_forced` | chosen = 1, `holdout_probability` exact | The holdout is itself randomized with probability `holdout_probability`, so holdout vs. treated is also an unbiased ITT comparison. |
| `fixed_split_hash` / `fallback_default` (`no_eligible_variant`) | chosen = 1 | Not randomized: the unit's traits matched no positive-weight arm. Exclude from arm comparisons. |
| `statsig_autotune` / `adaptive_bandit` | `null` | Adaptive allocation with unlogged propensities. **Not usable for unbiased readouts or off-policy correction.** The label is also used for plain Statsig A/B experiments, because the server cannot tell them apart. |
| `statsig_baseline_holdout` / `holdout_forced` | chosen = 1, `holdout_probability` `null` | Forced to the baseline variant, but the holdout share lives in the Statsig console, so holdout vs. autotune cannot be reweighted from this stamp. |
| `statsig_autotune` / `fallback_default` | chosen = 1 | Statsig failed or returned nothing usable; the default was served. Exclude. |
| `static_default` / `fixed_uniform` | chosen = 1 | The placement has no experiment; it always serves its default. |

## Enabling fixed split on a placement

Fixed split is a V2 placement-revision setting, so the environment must already be on `config_source = 'v2'`. Revisions are immutable: create a new revision and publish it. The admin API accepts camelCase or snake_case:

```bash
curl --fail --silent --show-error -X POST \
  -H "Authorization: Bearer $ADMIN_SECRET" -H 'Content-Type: application/json' \
  "$PUBLIC_API_BASE_URL/admin/placements/$PLACEMENT_ID/revisions" \
  -d '{
    "status": "active",
    "defaultBindingId": "'"$CONTROL_BINDING_ID"'",
    "defaultVariantKey": "control",
    "assignmentMode": "fixed_split",
    "holdoutPercent": 0,
    "assignmentSalt": "marriage-exp-2026-09",
    "variants": [
      {"variantKey": "control",     "bindingId": "'"$CONTROL_BINDING_ID"'", "weight": 1},
      {"variantKey": "marriage-01", "bindingId": "'"$M1_BINDING_ID"'", "weight": 1, "eligibility": {"intent": ["marriage"]}},
      {"variantKey": "marriage-02", "bindingId": "'"$M2_BINDING_ID"'", "weight": 1, "eligibility": {"intent": ["marriage"]}},
      {"variantKey": "marriage-03", "bindingId": "'"$M3_BINDING_ID"'", "weight": 1, "eligibility": {"intent": ["marriage"]}}
    ]
  }' | jq .
# then review GET .../revisions/<id>/diff and publish with expectedCurrentRevisionId (CAS), as for any revision
```

How it assigns: two independent SHA-256 draws per unit. A unit whose holdout draw falls under `holdoutPercent / 100` gets the default variant. Everyone else gets a weighted rendezvous hash over the **eligible** arms (weight > 0 and matching `eligibility`), so P(arm) = weight / sum of eligible weights, exactly. Adding or removing an arm only moves units into or out of that arm. Statsig is not consulted for the placement (neither baseline nor experiment); other placements in the environment are unaffected.

Validation (422 `Invalid assignment settings` with per-field `details.errors`):

- `assignmentMode` is `statsig` (default; the revision behaves exactly as before) or `fixed_split`. `holdoutPercent`, `assignmentSalt` and `eligibility` are rejected on `statsig` revisions instead of being silently ignored.
- Every variant needs an explicit integer `weight` from 0 to 100 (no silent clamping), and at least one active variant needs weight > 0.
- `holdoutPercent` is 0–50 with at most two decimals (stored exactly as `NUMERIC(5,2)`).
- `eligibility` is a non-empty object of trait conditions, with the same semantics as a targeting rule's `when` (all keys must match; arrays are any-of). The default variant cannot be restricted, because it serves the holdout and every fallback.
- `statsigExperimentId` and `targetingRules` must be empty: express intent targeting as eligibility.
- `assignmentSalt` is optional (`A-Z a-z 0-9 . _ : -`, up to 128 characters). Omitted, the placement id is used, so publishing an unrelated revision keeps every unit on its arm. **Change the salt to re-randomize** (for example when a new experiment starts on the same placement).

Publishing re-checks the positive-weight and default-eligibility rules, including for revisions written outside the API. The cutover comparator (`compare:config-v2`) never reports a fixed-split revision as equal to legacy routing, so cut an environment over in Statsig mode first. The config dashboard has no fixed-split controls yet, but saving an edit to a fixed-split revision keeps its settings.

To turn it off, publish (or roll back to) a `statsig` revision.

## Rollout switch

`PAYWALL_ASSIGNMENT_STAMP` controls the stamp: unset or `on` stamps every environment, `off` stamps none, and any other value is a comma-separated allowlist of public keys (for example `pk_live_310bc7653631b8b924afbad3` to stamp HiAstro first, as spec section 5 asks). It does not affect serving.

## Acceptance checks

These are the spec's checks, adapted to the multi-placement event and to `null` probabilities. Expand every decision first:

```sql
with decisions as (
  select e.id, e.created_at, e.properties->>'resolved' as resolved, d
  from events e,
       jsonb_array_elements(
         jsonb_build_array(e.properties->'assignment')
         || coalesce(e.properties->'other_assignments', '[]'::jsonb)) d
  where e.event_name = 'paywall_resolved'
    and e.created_at > now() - interval '1 day'
    and jsonb_typeof(d) = 'object'
)
select
  -- B: exact probabilities sum to 1
  (select count(*) from decisions where d->>'probability_source' = 'exact'
     and abs(1 - (select sum((c->>'probability')::numeric) from jsonb_array_elements(d->'candidates') c)) > 1e-6) as b_bad,
  -- C: chosen is an eligible candidate
  (select count(*) from decisions where not exists (
     select 1 from jsonb_array_elements(d->'candidates') c
      where c->>'variant_key' = d->>'chosen' and (c->>'eligible')::boolean)) as c_bad,
  -- D: chosen agrees with resolved, for every trigger
  (select count(*) from decisions where not exists (
     select 1 from unnest(string_to_array(resolved, ', ')) r
      where regexp_replace(r, ' \(baseline\)$', '') = (d->>'trigger') || '=' || (d->>'chosen'))) as d_bad,
  -- E: mechanism from the enum
  (select count(*) from decisions where coalesce(d->>'mechanism', '') not in
     ('fixed_uniform','fixed_weighted','adaptive_bandit','sticky_replay','holdout_forced','fallback_default')) as e_bad;
```

- **A**: `select count(*) from events where event_name = 'paywall_resolved' and created_at > now() - interval '1 day' and properties->>'resolved' <> '' and jsonb_typeof(properties->'assignment') is distinct from 'object'` must be 0.
- **F**: realized vs. declared allocation for fixed split, first row per `assignment_id`, per `policy_version` and eligibility set. Every row with `n >= 1000` must have `gap < 0.03`. Check the holdout share against `holdout_probability` the same way.

```sql
with first_decisions as (
  select distinct on (d->>'assignment_id') d
  from events e,
       jsonb_array_elements(
         jsonb_build_array(e.properties->'assignment')
         || coalesce(e.properties->'other_assignments', '[]'::jsonb)) d
  where e.event_name = 'paywall_resolved'
    and jsonb_typeof(d) = 'object'
    and d->>'allocator' = 'fixed_split_hash'
  order by d->>'assignment_id', e.created_at, e.id
), randomized as (
  select d->>'policy_version' as policy_version, d->>'chosen' as chosen, d->'candidates' as candidates,
         (select string_agg(c->>'variant_key', ',' order by c->>'variant_key')
            from jsonb_array_elements(d->'candidates') c where (c->>'eligible')::boolean) as eligible_set
  from first_decisions
  where d->>'mechanism' in ('fixed_uniform', 'fixed_weighted')
)
select policy_version, eligible_set, c->>'variant_key' as arm,
       (c->>'probability')::numeric as declared,
       avg((chosen = c->>'variant_key')::int) as realized,
       abs(avg((chosen = c->>'variant_key')::int) - (c->>'probability')::numeric) as gap,
       count(*) as n
from randomized, jsonb_array_elements(candidates) c
where (c->>'eligible')::boolean
group by 1, 2, 3, 4
order by 1, 2, 3;
```

## Deviations from the spec

- **Several placements per event.** The spec assumes one decision per event, but `/v1/config` resolves every placement at once. `assignment` holds the first trigger (so checks A–E work unchanged for it) and `other_assignments` holds the rest, rather than emitting extra events or logging a decision twice.
- **`probability`, `weight` and `eligible` can be `null`.** The spec types them as required numbers and booleans. Statsig Autotune, the Statsig baseline split, and which arms a Statsig experiment contains are not visible to the server, and the brief forbids inventing them, so they are `null` and `probability_source: "unknown"`. Check B applies only to `probability_source = 'exact'`. The stored V2 weights are reported only for fixed split; for Statsig placements they do not drive serving.
- **Holdout representation.** Following spec rule 3, holdout rows log the chosen arm at probability 1 (conditional on the holdout). The added `holdout_probability` records the chance of being in the holdout, which the spec's shape could not express.
- **No `sticky_replay`.** Fixed split is a deterministic hash, so every re-resolve of the same unit × revision reproduces the original draw with the same probabilities. Nothing is persisted per user; dedupe on `assignment_id` instead. Statsig assignments are evaluated fresh on each request.
- **Added fields.** `schema_version`, `assignment_id`, `revision_id`, `served`, `allocator`, `holdout_probability`, `probability_source`, `unit_type`, `fallback_reason` and `statsig`.
- **Not in the config response.** `/v1/config` responses are byte-for-byte unchanged, so client events do not carry `assignment_id`. Join client events on `user_id` + placement and time, or recompute `assignment_id`.
- **Default on.** The spec asks for a flag; `PAYWALL_ASSIGNMENT_STAMP` is that flag, but it defaults to on because every `paywall_resolved` must carry the stamp.
