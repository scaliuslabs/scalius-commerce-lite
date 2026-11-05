# Manual COD Deposit Implementation — TODO

## Phase 1 — Data model + config
- [ ] Add `kind`/`instructions`/`percent`/`contact_snapshot`/`cancelledAt` columns to `payment_plans` in schema
- [ ] Generate migration via `pnpm db:generate`
- [ ] Add `codDeposit*` fields to `CheckoutFlowSettings` (documents.ts)
- [ ] Extend `flow-settings.ts` save with new fields
- [ ] Extend `flow.ts` validation for manual deposit config
- [ ] Pass `codDeposit` through `getCheckoutConfig` (config.ts)
- [ ] Extend `checkoutConfigSchema` (apps/api/src/routes/checkout.ts)
- [ ] `pnpm generate:sdk`

## Phase 2 — Checkout commit
- [ ] `prepare.ts`: manual/online deposit branching + eligibility + plan insert at commit

## Phase 3 — Fulfilment protection + refund lifecycle
- [ ] New `manual-cod-deposit.ts` shared guard
- [ ] Wire guard into P1–P6 (lifecycle, ledger, bulk, tracking, delivery-outcomes, reconcile)
- [ ] `refund-service.ts`: plan → CANCELLED in finalizeAcceptedRefundAttemptIds; reject partial refunds

## Phase 4 — Manual deposit recording
- [ ] Extend `recordOrderPayment` with `paymentType: "deposit"` branch
- [ ] Extend admin `/orders/{id}/payments` body with `paymentType`; staff-only check

## Phase 5 — Admin UI
- [ ] `PaymentsSettings.tsx` config fields + validation
- [ ] `RecordPaymentDialog.tsx` COD deposit
- [ ] `PaymentCard.tsx`/`OrderStatusCard.tsx`/`admin-order-status-policy.ts` deposit status + block mirror

## Phase 6 — Storefront UI
- [ ] `index.ts` COD gating + summary rows + `paymentActionLabel`
- [ ] `account-order-detail.ts` + `order-success.astro` deposit status + instructions + contact snapshot

## Phase 7 — Testing & quality gate
- [ ] Unit + app tests
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:affected`
- [ ] Dispatch QA reviewers; fix findings (max 3 rounds)
- [ ] Open PR targeting development
