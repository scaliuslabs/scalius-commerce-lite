# Toolchain and Formatting Review - 2026-06-24

## Decision

- Keep ESLint as the semantic lint gate. Oxfmt is a formatter, not a replacement for React hooks, TypeScript, Astro, and project safety lint rules.
- Keep Prettier for Astro formatting through `prettier-plugin-astro`. Oxfmt `0.56.0` skipped a representative `.astro` file during a local check, so it is not a complete storefront formatter yet.
- Do not add an enforced oxfmt script in this pass. `npx oxfmt@0.56.0 --check package.json apps/api/src/routes/payment/payment-session-create.ts apps/admin-v2/src/components/admin/product-form/variants/VariantManager.tsx apps/storefront/src/pages/index.astro` reported formatting changes for existing JSON/TS/TSX files and did not check the Astro file. That needs a dedicated churn commit if adopted.

## Applied Updates

- Wrangler: `4.103.0` to `4.104.0` in API, admin, storefront, and the workspace override.
- Vitest: `4.1.8` to `4.1.9` in root/API/core/shared.
- `typescript-eslint`: `8.61.0` to `8.62.0`.
- `eslint-plugin-astro`: `1.7.0` to `2.0.0`.
- Root now declares `typescript@^6.0.3` so `typescript-eslint` resolves an explicit supported peer instead of relying on a transitive workspace compiler.

## Deferred Updates

- Astro latest was `7.0.2`, but the repo's minimum-release-age policy rejected `astro@7.0.2` and `@astrojs/markdown-satteri@0.3.2` because they were published inside the cutoff window. Storefront stays on Astro `7.0.0`, which is already Astro 7.
- TypeScript `7.0.1-rc` exists under the `typescript@rc` tag and plain `tsc` projects passed a quick smoke, but it was not adopted. The current `typescript-eslint@8.62.0` peer range is `>=4.8.4 <6.1.0`, so making TS 7 the primary compiler would put lint/framework tooling on an unsupported peer. Revisit after TypeScript 7 is stable and the toolchain declares support.
- pnpm latest was `11.9.0`, but the committed package manager field is still `pnpm@11.6.0` while the bundled runtime used in this thread is `11.7.0`. Updating package-manager policy should be handled separately because it affects every contributor and CI install path.

## Next Safe Migration Path

1. After the Astro patch releases age past the policy window, update Astro and run storefront typecheck/build plus generated Worker dry-run.
2. If adopting oxfmt, first create an `.oxfmtrc` from current style expectations, run it on a narrow TS/TSX slice, and commit formatting churn separately from behavior changes.
3. Keep ESLint in all cases unless Oxlint plus Astro/template parity is proven with equivalent rules and CI gates.
