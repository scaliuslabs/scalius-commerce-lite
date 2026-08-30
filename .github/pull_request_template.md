## Problem and decision

Closes #

Explain the verified problem, why it is not merely a preference, and the product or technical precedent used to choose this solution.

## What changed

- Describe the implementation at the level reviewers need to assess behavior and risk.

## Business rules and risk

- State the affected buyer, merchant, employee, data, payment, inventory, or authorization invariants.
- Call out intentional breaking changes, migrations, rollout dependencies, and rollback considerations.
- Confirm that logs, URLs, analytics, screenshots, and fixtures contain no secrets or buyer personal data.

## Verification

- [ ] Focused tests cover the failure mode and important edge cases.
- [ ] Relevant lint and sequential typechecks pass.
- [ ] Relevant build, environment, generated-contract, and secret gates pass.
- [ ] UI changes were checked at appropriate desktop and mobile viewports with keyboard/accessibility behavior considered.
- [ ] Production-facing changes were deployed through the repository deploy script and verified against the live deployment.
- [ ] Documentation and operational guidance were updated where behavior or contracts changed.

List the exact commands, deployment versions, and live scenarios checked:

```text

```

## Evidence

Add sanitized screenshots, recordings, traces, or before/after measurements when they materially prove the result. Never include credentials, OTPs, receipt proofs, session tokens, or buyer personal data.
