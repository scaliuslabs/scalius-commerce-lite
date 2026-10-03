## Problem and decision

Closes #

State the verified problem and why it is not only a preference. Name the product or technical precedent you used to choose this solution.

## What changed

- Describe the change at the level a reviewer needs to judge behavior and risk.

## Business rules and risk

- State the buyer, merchant, employee, data, payment, inventory, or authorization invariants that the change touches.
- State breaking changes, migrations, rollout dependencies, and rollback steps.
- Confirm that logs, URLs, analytics, screenshots, and fixtures hold no secrets or buyer personal data.

## Verification

- [ ] Focused tests cover the failure mode and the edge cases.
- [ ] Lint and typecheck pass for the affected workspaces.
- [ ] The build, environment, generated-contract, and secret gates pass (`pnpm build`, `pnpm check:env`, `pnpm generate:sdk`, `pnpm check:dist-secrets`).
- [ ] For UI changes: checked at desktop and phone widths, with keyboard and accessibility behavior.
- [ ] For production-facing changes: deployed with `pnpm run deploy` and verified against the live deployment (`pnpm release:check`).
- [ ] Docs and operational guidance changed where behavior or a contract changed.

List the exact commands, deployment versions, and live scenarios you checked:

```text

```

## Evidence

Add sanitized screenshots, recordings, traces, or before-and-after measurements when they prove the result. Never include credentials, OTPs, receipt proofs, session tokens, or buyer personal data.
