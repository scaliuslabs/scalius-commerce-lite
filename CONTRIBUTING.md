# Contributing to Scalius Commerce Lite

This guide is for people who report issues or want to change the code. It covers issue reports, the pull request policy, and the checks to run before you push.

## Report an issue

Use the [structured issue forms](https://github.com/scaliuslabs/scalius-commerce-lite/issues/new/choose) for reproducible bugs and product proposals.

- Search open and closed issues first.
- Report one independently deliverable problem per issue.
- Describe the affected user, the observed behavior, the expected outcome, and the evidence. A preferred implementation is not a requirement by itself.
- Never post passwords, API keys, OTPs, receipt proofs, session tokens, raw buyer data, or other sensitive information.

Maintainers classify each issue with a GitHub issue type plus status, priority, and area labels. [.github/LABELS.md](.github/LABELS.md) defines them. For installation help and questions, use [Discord](https://scalius.com/discord) ([.github/SUPPORT.md](.github/SUPPORT.md)).

## Pull requests

**The project does not accept unsolicited pull requests.** The architecture is still changing.

If a maintainer invites a contribution:

1. Work from the repository default branch (`mono-repo`).
2. Link the accepted issue.
3. Keep the change to the agreed outcome.
4. Fill in the [pull request template](.github/pull_request_template.md).

## Work on the code

Set up a local environment with the [README](README.md): `pnpm install`, `pnpm dev:setup`, `pnpm dev`. Run every command from the repository root.

CI runs the checks below. Run them before you push:

```bash
pnpm repo:check        # repository hygiene and whitespace
pnpm check:env         # no Wrangler `vars`, only the allowed bindings
pnpm --filter @scalius/database check:migrations
pnpm generate:sdk      # commit any change in packages/api-client
pnpm lint
pnpm typecheck
pnpm test:ci
pnpm build
pnpm run deploy:api -- --dry-run
pnpm check:dist-secrets
pnpm check:build-canaries
```

CI also runs `pnpm audit --audit-level moderate` and fails when the working tree is dirty after these steps.

Never commit secrets, `.dev.vars`, `.env*` files, or real buyer data.

## License

The project is licensed under the [GNU Affero General Public License v3.0](LICENSE). The one exception is the storefront (`apps/storefront/`), which is MIT-licensed ([apps/storefront/LICENSE](apps/storefront/LICENSE)). The storefront is part of this repository: use the same issue forms, branch, and `pnpm` commands for it.

## Security

Do not open a public issue for a security vulnerability. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
