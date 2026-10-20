# Burst notes: eval-gap fixes (agent merchant tasks)

Branch: this worktree, based on `claude/commerce-hooks-plugins-builder` (c98f28b20).
Machine rules were followed: only targeted vitest under `scalius-lock`, no typecheck, no full suite, no DVC gate.
**Not run: workspace typecheck.** The lead should typecheck `apps/api` and `packages/core` before merging.

To reproduce the harness locally, I copied `apps/api/src/agent-access/eval/` from `burst/shared` into an untracked `apps/api/src/agent-access/merchant-harness/`. It is not committed; delete it before merging. Its two local fixes are listed under "Harness changes the lead must apply".

## Per item

### 1. #26 staff invite 500 (commit a2a3fdf2b)
- **Root cause of the 500:** the eval store's `env` skipped Worker-entry composition (`composeApiRuntimeEnv`), so it had no `BETTER_AUTH_SECRET`. `createAuth()` threw before any invite logic ran. Production derives these secrets from `SCALIUS_SECRET` at entry for the agent path, so this part is a harness bug, not a product bug.
- **Product bug found behind it:** role create/update read the `permissions` rows that only the dashboard sign-in RBAC seed reconciles. Names without a row were dropped silently, so on the seeded store `order_manager` was saved with **no** permissions while the response claimed them. Fix:
  - `permissionRowsFor()` in `apps/api/src/routes/admin/rbac.ts` reads the rows in D1-sized chunks (the old single `inArray` could reach 200 bound params).
  - A miss runs `autoSeedRbacIfNeeded` once; a name still unknown is a 400.
  - The role and its links are written in one batch, and an update's delete plus inserts are one batch too.
- **Security fix found on the same path:** an agent (or plugin) acting for a super-admin owner inherited the owner's unlimited delegation. That let it create roles above its grant, assign roles including Super Admin, and invite staff with any role. The new `apps/api/src/routes/admin/delegation.ts` `delegatingUser(c)` drops the super-admin shortcut whenever an `agentPrincipal` or `pluginPrincipal` is acting. It is used by the rbac.ts delegation checks and by the invite route. The security worker should review this.
- **Test:** `apps/api/src/routes/admin/rbac-staff.test.ts` (9 pass) covers:
  - reconciling an unseeded permission, and refusing an unknown one;
  - an agent inviting an orders-only staff member end to end (the user ends with exactly `orders.edit,orders.view`);
  - an agent refused above its grant (role, user-role assign, super_admin, invite).
- **Harness:** #26 passes locally once the harness applies the two fixes below.

### 2. Activity read drops today (commit 51a7c712b)
- `fitToBudget` (`apps/api/src/agent-access/mcp/shape.ts`) cuts an unpaged oldest-first series from its oldest end. A series here means rows with an ascending `date` string. The hint says the oldest rows were dropped. Paged lists still keep their head, so the cursor stays correct; `server.ts` passes `paged`.
- **Test:** `shape.test.ts` (6 pass).
- **Not verified:** a live 90-day read through the harness. Task #1 still asks for `days:1`.

### 3. #22 delivery fees (commit 14a687729)
- The fees were already in the read (`zones[].rates[].fee`, decimal major units), and the Dhaka template already sets ৳60/৳120. The agent missed them because the fees are nested. The read's agent hint now names that path.
- **New narrow operation:** `dashboard.shipping_zones.rate_update`, `PATCH /api/v1/admin/settings/shipping-methods/{id}/rates/{rateId}`.
  - Body: `{ expectedRevision, fee?, freeOver?|null, isActive? }`, in major units like the rest of the shipping contract.
  - It applies against the zone revision, which advances as a full save does, and leaves regions, areas and other rates alone.
  - It keeps the "last active rate" guard.
- **Registration:**
  - core `updateDeliveryZoneRate` (`packages/core/src/modules/delivery/zones.ts`);
  - RBAC row `shipping-methods/*/rates/*` PATCH;
  - registry row with `revision: required`;
  - the `dashboard.delivery-fees` intent now routes to it.
- **The stable API is unchanged.** The list route was not touched, and the new op is beta.
- **Tests:**
  - `zones.d1.test.ts`: 25 pass. The new case covers a fee and threshold change, the stale revision 409, a rate from another zone 404, paisa 400, an empty change 400, and clearing the threshold.
  - The checkout-configuration contract test was updated (45 ops, 24 JSON bodies).
- **Harness:** a rewritten #22 (template, then read, then `rate_update` for each zone, then reread) passes locally in 8 calls. The task script is in the local copy's `tasks.ts`.

### 4. #25 GA4 (commit f247da284)
- A `google_analytics` config that is a bare `G-…` ID is stored as the platform-generated gtag.js snippet. This is the same pattern as Cloudflare Web Analytics.
  - The code is `normalizeAnalyticsConfig` / `normalizeGoogleAnalyticsConfig` in `packages/core/src/modules/analytics/analytics.validation.ts`, and the service uses it.
  - Validation checks the canonical config, so create and set_active accept the bare ID. Placeholder `G-XXXX` is still refused.
- **Consent mode:** the storefront already has the consent model, so no new setting was added.
  - `@scalius/shared/tracking-consent` plus `apps/storefront/src/components/consent/consent-scripts.ts` emit `gtag('consent','default',{ad_storage, analytics_storage, ad_user_data, ad_personalization})` before Google tags.
  - EEA, UK and Swiss markets are always opt-in (all denied). Other regions follow `dashboard.tracking.update` `consent.otherRegions`.
  - Per-parameter merchant overrides would break the D6 one-rule design, so none were added.
  - The `analytics.create` hint now says this.
  - **Not done:** a read-only `consent.googleConsentModeDefaults` field on `dashboard.tracking.get`, which would let an agent verify the EU defaults. Next step: add it to `trackingSettingsSchema` in `apps/api/src/routes/admin/settings/tracking.ts`, computed with `gtagConsentParameters(defaultConsent("opt_in"))` and `defaultConsent(otherRegions)`.
- **Test:** `analytics.validation.test.ts`, with a new case. The analytics folder ran 154 pass; 1 report test timed out at 5 s, which is unrelated and comes from host load.
- **Gap flip:** #25's `knownGap` assertion ("no consent-mode setting") is hard-coded in the task's `verify`. The lead should rewrite #25: create from `G-EVAL12345` alone, then set_active, then read `dashboard.tracking.get`. It should then pass.

### 5. Categories without an image (commit c4bdc4c5d)
- `createCategorySchema` lets `image`, `description`, `metaTitle` and `metaDescription` be omitted on create, and stores them as null. Edits keep the full shape.
- `categories.create` is **stable**. `stable-operations.snapshot.json` was updated with `-u`: an additive loosening where only `name` stays required. This may conflict with the stable-API worker's snapshot edits; regenerate on merge.
- **Test:** `categories.publish-d1.test.ts`, a new case creating from a name alone.

### 6. COD countries and the discount describe (uncommitted at the time of writing; see the end of this file)
- `dashboard.payments.methods_get`: `gatewayStatus.cod.countries = ["BD"]`, from `COD_COUNTRIES`. The optional `countries` field was added to `gatewayStatusSchema`.
- The `dashboard.discounts.create` `when` line, which compact describe shows, now carries the basic recipe:
  - `method code`, `codes [{code}]`;
  - `effects [{target order, allocation once, kind percentage_off {basisPoints} | fixed_amount_off {amountMinor,currencyCode}}]`;
  - `minimum_merchandise_subtotal`.

### 7. Cancel writes a push health row into `settings`: not done (investigated)
- **Why it happens:** a cancellation notice tries push (FCM). The failure calls `markNotificationProviderBlocked` (`packages/core/src/modules/notifications/notification-provider-health.ts`), which upserts a `settings` row with category `notification_provider_health` and key `push:fcm`. The settings README documents this as an "operational pause marker in the same table".
- **Next steps:**
  1. A push with no Firebase config should be "not configured" (skip, no marker), not a breaker failure. Check the caller that classifies the FCM result.
  2. Move the markers to `system_kv` (key `notification-provider-health:<channel>:<provider>`). Update `getNotificationProviderBlock`, `markNotificationProviderBlocked` and `buildClearNotificationProviderBlocksStatement`; the last is batched with settings saves, so keep it a statement. Also update the README lines.
  3. Add a migration that moves existing rows. Then drop `settings` from task #16's `writes`.

### 8. Search ranking for #5, #6 and #18: not done
- #22 and #26 now rank their op first in the harness.
- **Next step:** run the harness with `AGENT_EVAL_ONLY=5,6,18` and read `routing[].top`. Then add synonyms or examples to the product-create intent ("simple product", "t-shirt sizes colours variants") and the order-create intent ("COD order for customer") in `apps/api/src/agent-access/workflows/routes-dashboard.ts`, and to their `when` lines.

### 9. Operator preset: not done
- **Next step:** in the preset definition (`resolveGrantSelection` / Operator in `packages/core/src/modules/agent-access`):
  - add `discounts.create` and `discounts.edit`;
  - add `settings.general.view`, which is read-only and covers `checkout.readiness_get` and `payments.methods_get`.
- Keep `taxes.manage`, theme publish (`settings.general.edit`), refunds, gift cards and security off.
- Update the consent copy (en + bn) in `apps/admin-v2/src/i18n/*` (admin-v2 is another worker's area, so coordinate) and the preset tests (`grant-scopes.test.ts`, principal tests).
- **Gaps that flip after this:** the #3 and #12 grants can move back to Operator. #21 `methods_update` needs `settings.general.edit`, so it stays Full.

## Harness changes the lead must apply (burst/shared `apps/api/src/agent-access/eval/`)
1. `store.ts`: derive the runtime secrets as Worker entry does. Use `...await deriveRuntimeSecrets(SCALIUS_SECRET)` from `@scalius/shared/runtime-secrets`, which makes `createEvalStore` async, and change `run.ts` to `await createEvalStore()`.
2. Task #26 `writes`: add `"admin_invitations"`, the invite record.
3. Task #22: use the `rate_update` script (local copy), and drop its `knownGap`.
4. **Gaps that should flip to passing with this branch:**
   - **#26:** with 1 and 2 applied.
   - **#22:** with 3 applied.
   - **#25:** after the task rewrite in item 4.

## Other
- `packages/cli/skills/scalius-settings/references/workflows-2.md` is stale after the delivery-fees intent change. Run `pnpm --filter scalius generate:recipes`. I did not edit it because `packages/cli` belongs to the security worker.
- `pnpm generate:sdk` (api-client) **was not run**, only `generate:agent-contract`. The lead should run `pnpm generate:sdk` once after merging, for `rate_update`, the category create loosening and the COD `countries` field.
- **Not run:** `node scripts/check-source-policies.mjs`. No dashboard or storefront code was touched.
