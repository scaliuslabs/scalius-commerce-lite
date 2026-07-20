# Operational Customer Request Policy

Last reviewed: 2026-07-12

## Scope

This policy controls whether buyers may submit cancellation, return, and refund review requests from a private receipt or authenticated account order. A request records buyer intent only; it does not directly change order, payment, shipment, return, or inventory state.

It is deliberately separate from `settings.seo/return_policy`. SEO return policy describes merchant facts for public structured data. Operational customer-request settings control storefront actions and API mutation eligibility.

## Authority

- D1 `settings` row: category `order_support`, key `customer_request_policy`, JSON value.
- Missing or invalid legacy JSON normalizes to the compatibility default: all three request types enabled and only currently eligible actions shown.
- A settings read failure is not converted to permissive defaults on a mutation path; request creation fails closed.
- Canonical labels, descriptions, merchant-disabled reasons, visibility projection, intro fallback, and representative preview live in `packages/core/src/modules/settings/customer-request-policy.ts`.

## Buyer contract

- `eligible_only`: return only actions that are both merchant-enabled and eligible for the current order state.
- `show_unavailable`: return enabled/ineligible and merchant-disabled actions with the exact reason they cannot be used.
- Hidden actions remain in a private server eligibility projection so direct API submissions cannot bypass merchant policy.
- Receipt and account detail responses include `supportRequestIntro` and the already-projected `supportRequestActions`; storefront code must not recreate policy or labels.
- Only one active support request is allowed per order, and active refund processing continues to block all new request types.

## Admin UX

Checkout Settings → Customer Requests contains:

- independent cancellation, return, and refund switches;
- the eligible-only versus explain-unavailable visibility choice;
- optional buyer introduction text, capped at 240 normalized characters;
- live previews for pre-shipment/unpaid, shipped/unpaid, and delivered/paid orders using the same core projection as buyer responses.

Saving this operational policy must not write SEO return-policy settings or mutate existing orders/requests.
