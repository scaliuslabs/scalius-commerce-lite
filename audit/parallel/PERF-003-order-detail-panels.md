# PERF-003 Order Detail Panel Split

Date: 2026-07-05

## Parallel Findings

- Admin bundle explorer recommended a narrow order-detail split instead of a broad route refactor. The safest high-impact target was the lower-priority order detail side panels because the order route chunk still carried notification/support logic while their data reads were already hydration-gated.
- Rich-text explorer recommended no product-description lazy-load change in this slice. The primary product description should stay on the real Tiptap editor path; remaining rich-text risk is a separate media-manager toolbar ownership issue, not a bundle split.
- Ops explorer confirmed `OPS-005`/`OPS-008` should stay open until account-level Cloudflare Email Service sender/destination setup and a routed alert proof exist. Live `pnpm ops:check --queues --samples 1 --timeout-ms 20000` passed, so there was no code-owned ops-budget patch to prioritize here.

## Implemented Slice

- `OrderView` now keeps the order header, status card, payment card, shipment card, notes card, and item card on the immediate path.
- `OrderSupportRequestsCard` lazy-loads only when `order.supportRequests?.length > 0`, avoiding a support-request panel chunk for the common no-support case.
- `OrderNotificationsCard` lazy-loads behind its own stable card-height fallback while retaining its existing hydration-gated query behavior.
- A source-boundary test now prevents reintroducing static imports for the support/notification panels from `OrderView` while asserting `PaymentCard` and `ShipmentCard` remain direct.

## Verification

- `pnpm exec vitest run apps/admin-v2/src/lib/route-graph-boundaries.test.ts apps/admin-v2/src/lib/order-detail-permission-boundaries.test.ts apps/admin-v2/src/routes/admin/orders/-order-detail-prefetch.test.ts` passed (`55` tests).
- `pnpm --filter @scalius/admin-v2 typecheck` passed.
- `pnpm --filter @scalius/admin-v2 lint` passed.
- `pnpm --filter @scalius/admin-v2 build` passed.
- Dist evidence: generated `OrderSupportRequestsCard-*` and `OrderNotificationsCard-*` chunks exist; `_orderId-*` keeps payment-history/session markers but no longer contains support dialog copy (`Resolve customer request`, `Customer request`, `Support request`) or notification receipt copy (`recorded attempt`, `Delivery settled`, `Stopped after`). Server `_orderId` chunk is now about `131.82 kB` after previously appearing around `155 kB` in the same deploy-era build output.

## Follow-Up

- Keep the primary product description editor eager unless a browser smoke proves a real remaining product-edit issue. A separate small rich-text safety slice should replace the Tiptap media-manager global DOM id with an editor-local ref so multiple editors cannot route media selection to the wrong editor.
