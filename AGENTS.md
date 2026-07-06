# Scalius Commerce

Root agent context is intentionally small. Treat this file as a router, not a codebase tour. If a fact needs more than one line, put it in a focused doc and link it here only when it is a recurring landmine.

## Load First

- Current remediation queue: `audit/REMEDIATION_TRACKER.md`
- Verification/deploy playbook: `audit/VERIFICATION_PLAYBOOK.md`
- Platform goal, release bar, and orchestration rules: `docs/codex/PLATFORM-GOAL.md`
- Codex doc index and update rules: `docs/codex/README.md`
- Architecture map when boundaries are unclear: `docs/ARCHITECTURE.md`
- Historical full agent notes only when a missing landmine blocks you: `docs/codex/AGENTS-REFERENCE.md`

## Non-Negotiables

- Use `pnpm` from the repo root. Deploy through `pnpm run deploy*`, not pnpm's package deploy behavior.
- Use `pnpm ops:check` for read-only production API ops smokes; add `--queues` when queue metadata matters. It intentionally runs Wrangler through `pnpm --dir apps/api`, so do not rely on root-level `pnpm exec wrangler`.
- Never hand-edit generated files: `apps/admin-v2/src/routeTree.gen.ts` and `packages/api-client/src/generated/**`.
- After API contract changes, run `pnpm generate:sdk`. After schema changes, run `pnpm db:generate`.
- Do not touch `.dev.vars`, `.env*`, or other secret-bearing files.
- Keep Cloudflare bindings and Worker `Env` declarations synchronized, then run `pnpm check:env`.
- `@scalius/database` and `@scalius/shared` use subpath imports such as `@scalius/database/schema`; avoid root imports.
- Storefront code may import shared/api-client packages, but must not import `@scalius/core` or `@scalius/database` without an explicit architecture decision.

## High-Risk Landmines

- D1 is the authority for auth, setup, checkout, payment, inventory, scanner tokens, and customer sessions. KV/cache rows are hints unless a domain doc proves otherwise.
- Checkout/order/payment writes must be idempotent and commit local state before provider side effects when duplicate orders, stock leaks, or double charges are possible.
- Phone collection is mandatory for customer identity and checkout in Bangladesh. Do not add a merchant setting that disables phone collection.
- Products are merchandising containers. Sellable/inventory identities are `product_variants`; simple products use exactly one hidden/default persisted SKU, never product-level inventory. Optioned products must keep one active option-axis shape per product; do not mix Option 1-only, Option 2-only, and both-option SKU rows.
- Product-feed availability must come from buyer-resolvable SKU availability (`availableForSale`), not product active status alone, so feed XML matches product JSON-LD and checkout truth. Feed XML must also fail closed on non-absolute storefront URLs, skip products without a real absolute `http(s)` primary image link, flatten rich-text descriptions into plain catalog text, honor the dashboard feed title/description and sold-out inclusion policy, and never emit invalid catalog items.
- Sitemaps, robots, and SEO discovery assets must fail closed when `STOREFRONT_URL` is missing or not absolute; never emit relative discovery URLs in XML, robots output, canonical links, Open Graph image tags, or JSON-LD image fields. Sitemap-advertised static pages need canonicals, and listing query/sort/filter/page variants should canonicalize or `noindex,follow`. Organization/WebSite/Product/Breadcrumb/CollectionPage JSON-LD must honor `settings.seo/discovery` structured-data toggles, and Organization logo URLs must pass through the absolute storefront SEO URL helper before schema emission. SEO setting saves must invalidate API/layout/homepage caches and schedule storefront warm paths for `/robots.txt`, `/sitemap.xml`, all sitemap child XML files, and `/api/facebook-feed.xml` so dashboard discovery changes do not leave crawlers with cold or stale public XML.
- Public `/seo` responses are KV-cached; when expanding that response contract, bump the nested route cache namespace (currently `api:seo:v2:`) while keeping the broader `api:seo:` invalidation group intact.
- Public checkout/config/payment readiness must fail closed. Do not guess COD or a gateway when settings cannot be read.
- Sensitive forms must be safe before hydration and with JavaScript disabled. Credentials, OTPs, tokens, phone/email, cart, payment, and discount values must not enter URLs.
- Receipt proof must not enter URLs, analytics payloads, logs, clipboard URLs, or KV keys. Duplicate/in-flight checkout polling uses a derived `cst_` status token; never put a `chk_` receipt proof in `/orders/status/{token}`. Checkout-status KV hints and receipt KV hints must hash proof/token material before keying; logs may include only short non-bearer hash/key prefixes. Guest receipt access uses same-origin httpOnly cookies plus API header/body proof; merchant-sendable cross-browser hosted-payment recovery must use the buyer-verified `/payment-recovery?orderId=...` OTP handoff, never a bearer recovery URL.
- OTP queue payloads must carry opaque challenge/delivery references only. New customer-login or payment-recovery `auth.send_otp` messages must not serialize raw OTP codes; the API queue consumer derives the code at send time and accepts raw `code` only for legacy pre-reference payloads.
- Provider failures should log masked metadata only. Never log raw OTPs, credentials, receipt tokens, provider payloads, or buyer PII. Encrypted provider credentials must use strict reads with the dedicated `CREDENTIAL_ENCRYPTION_KEY` on hot send paths; do not fall back to JWT secrets, do not call providers with unreadable ciphertext, and treat obvious dummy/placeholder credentials as not configured.

## Work Loop

1. Check `audit/REMEDIATION_TRACKER.md` before choosing or continuing a slice.
2. Load only the task-specific docs and files needed for the slice; if docs conflict, verify against code and runtime before trusting prose.
3. Prefer small, boring fixes that remove complexity instead of explaining it away.
4. In goal-mode work, act as the lead: delegate independent code slices to workers with disjoint file ownership, review/integrate their patches, and keep direct edits narrow.
5. Add focused tests around the failure mode before broad gates.
6. For meaningful code changes, verify locally, deploy when required, smoke live behavior, update docs, then commit.
7. When new agent guidance is needed, add the shortest pointer/rule here and put durable details beside the owning code, test, or focused doc.

## Context Hygiene

Add to this root file only when the fact is non-obvious, repeatedly trips agents, and cannot be enforced in code/tests. Use it as an index of pointers and production landmines; do not restate product vision or domain docs here. If it grows past one screen, prune first and move details into the relevant domain doc.
