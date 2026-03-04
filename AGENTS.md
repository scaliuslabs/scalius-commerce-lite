# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Scalius Commerce Lite is a single Cloudflare Worker: Astro SSR (admin UI) + Hono (storefront API) + D1/KV/R2 bindings. No Docker, no external databases. Everything is emulated locally via `platformProxy`.

### First-time setup

```bash
pnpm dev:setup        # installs deps, generates secrets, creates .dev.vars + .env.development, runs DB migrations
```

Then `pnpm dev` to start the server on port 4321. Visit `/admin` to create the first admin account.

### Resetting the database

```bash
pnpm dev:reset        # wipes .wrangler/state/, re-applies all migrations from scratch
```

After reset, restart the dev server and revisit `/admin` to re-create an admin account.

### Key commands

See `package.json` scripts. The important ones:

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Astro dev server on port 4321 |
| `pnpm build` | Full production build (astro check + build + drizzle generate + queue consumer bundle) |
| `pnpm dev:setup` | One-command first-time local dev setup |
| `pnpm dev:reset` | Wipe local DB and re-apply migrations |
| `pnpm db:migrate:local` | Apply pending migrations only |
| `pnpm db:studio` | Drizzle Studio DB browser |

### Non-obvious gotchas

- **Two env files needed**: `.dev.vars` provides Cloudflare runtime bindings (secrets + URL overrides for local dev). `.env.development` provides Vite/Astro build-time vars (`import.meta.env.*`). Both are created by `pnpm dev:setup`. Vite does NOT read `.dev.vars`.
- **wrangler.jsonc has production URLs**: The `vars` block points to production domains. `.dev.vars` must override `BETTER_AUTH_URL`, `PUBLIC_API_BASE_URL`, and `STOREFRONT_URL` with `http://localhost:4321` for local dev to work.
- **Port conflicts**: If port 4321 is already in use, Astro silently increments to 4322+. Always kill previous servers before starting a new one. Auth callbacks will fail if the server runs on the wrong port.
- **RBAC auto-seed**: Permissions and roles are auto-seeded on first admin dashboard access via `autoSeedRbacIfNeeded`. The first admin user is automatically set as super admin during the setup flow.
- **esbuild**: Required as a direct dev dependency for the queue consumer bundling step in `pnpm build`. It's listed in `devDependencies`.
