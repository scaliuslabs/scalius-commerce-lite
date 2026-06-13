# Portion Rewrite Checklist

Use this checklist when auditing and rewriting one part of the codebase. The target is not "new stack energy"; it is smaller, verified, more obvious code with fewer hidden contracts.

## 1. Choose The Slice

- Name the slice in one sentence: for example, "storefront checkout payment redirect", "admin product API wrappers", or "delivery webhook status updates".
- Own the whole behavior path for that slice: route, service, DB tables, queue messages, cache keys, UI entry points, generated SDK impact, and tests.
- Avoid touching neighboring domains unless the slice cannot be fixed without them.
- Start with `git status --short` and preserve unrelated changes.

## 2. Map The Current Flow

- List every entry point: HTTP route, server function, UI route, queue consumer, cron job, webhook, scheduled job, and provider callback.
- Identify trusted and untrusted callers.
- Trace the data path from input validation to persistence to response.
- Trace all side effects: inventory, payment, shipment, notifications, cache purge, queue send, provider API call, email/SMS, KV/R2 writes.
- Mark generated artifacts and regeneration commands.

## 3. Define The Contract

- Request schema: where is it validated, and is it the same contract used by the UI or SDK?
- Response schema: does the API use `{ success: true, data }` or a documented exception?
- For admin server functions, compare the wrapper type to the API route's unwrapped `data` payload and remove caller-side casts that were compensating for the old broad type.
- Error behavior: which errors are expected user errors, retryable infrastructure errors, and fatal bugs?
- Auth/RBAC: who can call it, and is the check enforced at the final API boundary?
- Idempotency: what happens if the same request/webhook/queue message runs twice?
- Concurrency: what happens if two workers update the same order, inventory item, payment, or setting?

## 4. Look For Simplification

- Replace duplicate local interfaces with generated SDK types or a shared schema when that reduces drift.
- Split huge files only along real domain boundaries.
- Treat `as unknown as` near API calls as a smoke alarm: it may be hiding a response-envelope mismatch or a stale request payload.
- Replace copy-pasted transport/error/query/mutation code with a small helper after the third repeated pattern.
- Keep provider definitions separate from runtime provider implementations when UI only needs labels/options/types.
- Prefer one state-transition helper over separate "single", "bulk", "webhook", and "manual" implementations with different semantics.
- Remove dead compatibility paths only after verifying no current route or UI uses them.

## 5. Check Security And Privacy

- Verify API boundary auth, not only UI route guards.
- Test the lowest-permission authenticated user, not only super admin.
- Check public pages that use privileged server credentials.
- Check user-controlled strings rendered with `innerHTML` or `set:html`.
- Check bearer tokens, scanner tokens, receipt tokens, checkout IDs, order IDs, and purge tokens.
- Confirm secrets come from Cloudflare runtime bindings, not `import.meta.env`.

## 6. Check Data Integrity

- For order-like workflows, verify status CAS, inventory action, payment status, shipment status, and notifications together.
- Put external provider calls behind a local claim step when possible.
- Avoid provider side effects before local state is ready to accept or recover from them.
- Keep deterministic validation failures out of infinite queue retries.
- Ensure cron jobs only mutate records whose business state allows that mutation.
- Validate migration metadata and generated SDK drift when schema or OpenAPI changes.

## 7. Check Runtime And Local Dev

- Run the focused typecheck for the app/package you touched.
- Run focused tests for the slice. If blocked, document the blocker and add the missing test harness as a remediation item.
- If local full-stack dev is unreliable, use smaller proofs: unit tests, route tests, `wrangler dev`, dry Turbo plans, cURL, and browser-only reproduction.
- For Workers-specific changes, compare Wrangler bindings to generated types.
- For cache changes, test L1, Cache API/L2, KV versioning, and purge behavior separately.

## 8. Definition Of Done

A slice is done when:

- The behavior is mapped and documented in the PR or tracker.
- The implementation has one source of truth for the contract.
- Auth, RBAC, idempotency, and error behavior are explicitly tested or manually verified.
- The smallest meaningful typecheck and tests pass.
- Generated artifacts are regenerated only through the proper command.
- `AGENTS.md` and this audit folder are updated if conventions changed.

## 9. Handoff Note Template

Use this template when leaving work for another agent:

```md
Slice:
Status:
Files touched:
Behavior changed:
Verification run:
Verification not run:
Remaining risks:
Next recommended step:
```
