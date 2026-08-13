# Settings and administration

- Read the exact settings projection and revision before a mutation; preserve fields the merchant did not ask to change.
- Use readiness/preview operations before enabling checkout, taxes, delivery, SEO, feeds, analytics, or providers.
- Never infer that a masked credential exists from placeholder text. Use only reviewed provider-save/test operations and never echo secrets.
- Treat Super Admin, RBAC, agent access, sessions, 2FA, scanner pairing, and provider credentials as security workflows. Follow device or human-consent exclusions instead of bypassing them.
- Keep external/provider operations inside their declared open-world and risk boundaries.
- After a write, reread the exact setting and verify its buyer-facing projection when relevant (checkout config, tax quote, delivery, homepage/layout, SEO/discovery).
