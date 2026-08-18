---
name: scalius-settings
description: Read and change Scalius store administration safely. Use for store behavior, business identity and contact details, checkout and guest or customer access, tax, shipping and delivery, payment or messaging providers, analytics configuration, staff and roles, sessions and security, agent access, and related operational settings.
---

# Scalius Settings

Use the dashboard audience for administration. Use a separately authenticated storefront audience only for buyer-visible verification selected by a reviewed plan.

## Apply settings safely

1. For a supported settings/readiness question, call MCP `workflows.read` first or run `scalius workflow read "<question>" --surface dashboard`.
2. If unavailable or when changing settings, call `workflows.resolve`; with CLI, use `scalius workflow resolve`. Follow its compact ordered plan without adding operation IDs.
3. Call `operations.describe` only for selected IDs requiring exact inputs. Never use the removed MCP operation-search tool, open repository contract artifacts, or guess a setting shape.
4. Read the exact current projection and revision. Execute confirmed changes with `operations.write` in plan order, then reread the setting and any selected readiness/public evidence.

## Preserve configuration truth

- Change only requested fields and preserve unrelated values. On revision conflict, reread and reconcile rather than overwriting newer state.
- Use an idempotency key only when declared, and reuse it only for an exact replay.
- Run reviewed readiness, preview, or health checks before enabling checkout, guest/customer access, taxes, shipping, payment, messaging, analytics, or provider behavior. Do not infer readiness from a saved row alone.
- Treat business identity, currency, contact details, checkout rules, and active tax, shipping, or payment availability as public commerce facts. Verify buyer-visible output with the separate storefront audience when the plan asks for it.
- Treat roles, staff, sessions, 2FA, scanner pairing, agent grants/tokens, and permission changes as security workflows. Require exact targets and confirmation; never broaden authority beyond the request.
- Never infer a credential from masked or placeholder text. Do not echo provider secrets, analytics tokens/snippets, OTPs, continuation fields, staff/customer PII, or agent credentials. Follow fixed browser/device continuations without exposing their fields.
- Keep provider/open-world actions inside their declared risk boundary. Stop on failed tests or stale readiness instead of enabling a guessed fallback.

Report the verified saved state separately from active, usable, and storefront-visible behavior.
