# Automated and managed deployments

This page is for operators who run a control plane that installs, upgrades and operates many Scalius stores without a person at a terminal. It describes seven opt-in contracts. A manual install (create the Cloudflare resources, install the secrets, deploy, fill in Platform settings) does not change.

Every contract:

- is off by default, so an existing store behaves as before;
- works on D1, TursoDB and PostgreSQL;
- adds no Wrangler `vars` and no installed secret. Every key is HKDF-derived from `SCALIUS_SECRET`, and every flag lives in the Platform settings document;
- never logs, echoes or returns a derived secret from a Worker.

| # | Contract | Turned on by |
|---|----------|--------------|
| 1 | [Gated first-admin setup](#1-gated-first-admin-setup) | Platform setting `setupTokenRequired` |
| 2 | [Trusted external identity handoff](#2-trusted-external-identity-handoff) | Platform setting `identityHandoff.enabled` |
| 3 | [Compatibility discovery](#3-compatibility-discovery) | Always available: `GET /api/v1/meta` |
| 4 | [Dashboard under a path prefix](#4-dashboard-under-a-path-prefix) | A path on the Platform setting `dashboardUrl` |
| 5 | [Trusted front-proxy headers](#5-trusted-front-proxy-headers) | A valid `X-Scalius-Proxy-Signature` header |
| 6 | [Remote migrations without Wrangler](#6-remote-migrations-without-wrangler) | Running `pnpm --filter @scalius/database migration-plan` |
| 7 | [Headless demo-store export](#7-headless-demo-store-export) | Running `pnpm demo:store --export` |

## Platform settings

Contracts 1, 2 and 4 are fields of the `platform` settings document. Set them in the dashboard or through the API.

| Field | Dashboard location |
|-------|--------------------|
| `setupTokenRequired` | Settings > Advanced > Sign-in and access > "Require a setup key for the first admin" |
| `identityHandoff` (`enabled`, `issuer`, `audience`, `jwksUrl`, `localLoginDisabled`) | Settings > Advanced > Sign-in and access > "Single sign-on" |
| `dashboardUrl` | Settings > Store details > Web addresses > "Dashboard address" |

Through the API, send `PUT /api/v1/admin/settings/platform` with the fields to change and the `expectedRevision` that `GET /api/v1/admin/settings/platform` returned. A stale revision is a 409. The public `GET /api/v1/platform` (no-store) returns the four origins, `setupTokenRequired` and `identityHandoff`.

## Deriving the automation keys

Three purpose labels are reserved for automation. The control plane derives each key from the `SCALIUS_SECRET` that the Workers already hold.

| Purpose label | Derived name | Used for |
|---------------|--------------|----------|
| `admin-setup` | `ADMIN_SETUP_TOKEN` | the `X-Scalius-Setup-Token` header value |
| `front-proxy` | `FRONT_PROXY_SECRET` | the HMAC key that signs forwarded host, proto and client IP |
| `identity-handoff` | `IDENTITY_HANDOFF_SECRET` | the HS256 key that signs dashboard handoff tokens |

```bash
printf %s "$SCALIUS_SECRET" | pnpm secret:derive --purpose admin-setup --stdin
```

- The tool reads the master secret from a hidden prompt, from standard input (`--stdin`), or from the environment (`--from-env`). It never accepts the secret as an argument. `--json` prints the name, purpose and value as JSON.
- The tool derives only these three purposes. It refuses the session, JWT, service-token, agent-pepper and customer-session keys, which only a Worker needs.
- Rotating `SCALIUS_SECRET` rotates all three keys at once.

## 1. Gated first-admin setup

A new store has no administrator, and `POST /api/v1/setup` claims the first account. To close that window, turn on `setupTokenRequired`. The endpoint then also requires the derived token:

```text
POST /api/v1/setup
X-Scalius-Setup-Token: <derived admin-setup value>
```

Behavior of the endpoint:

- It answers 403 when an administrator already exists.
- The setup rate limit applies next. The token check runs after it, so guesses stay bounded.
- The token comparison runs in constant time over SHA-256 digests. A rejected attempt logs the client IP and nothing else.
- A wrong or missing token is a 403: `A valid setup token is required to complete first-admin setup.`
- If the gate is on and the Worker cannot derive the token, setup answers 503. It never falls open.
- `GET /api/v1/setup` returns `{ adminExists, setupTokenRequired }`, so the dashboard and a control plane can check the gate first.

## 2. Trusted external identity handoff

When the operator's identity provider owns administrator identity, administrators hold no second password. The dashboard accepts a short-lived signed token, creates a normal session from it, and writes an audit row.

To set it up:

1. Set `identityHandoff.issuer` and `identityHandoff.audience`. Add `identityHandoff.jwksUrl` for asymmetric signing.
2. Set `identityHandoff.enabled` to `true`. The Platform settings refuse it without an issuer and an audience.
3. Optional: set `identityHandoff.localLoginDisabled` to turn off password sign-in. This works only while the handoff is enabled. Turning the handoff off turns password sign-in back on, so a store cannot lock itself out.

### Endpoints

Both endpoints sit under the dashboard base path (`<dashboardUrl>`, see contract 4). They need no session: the signed token is the credential.

| Endpoint | Method | Effect |
|----------|--------|--------|
| `<dashboardUrl>/api/auth/handoff?token=...` | GET | Verify the token, upsert the administrator, create a session, redirect to `<dashboardUrl>/admin`. |
| `<dashboardUrl>/api/auth/handoff/revoke` | POST | Body `{ "token": "..." }`. Revoke all sessions of that administrator and optionally suspend the account. |

- Each endpoint allows 10 requests per minute.
- Each endpoint answers 404 to every well-formed request while the handoff is disabled, so a store that never enabled it does not show the surface.
- The revoke response is `{ userId, sessionsRevoked, suspended, suspensionRefused }`.

### Token contract

HS256 tokens use the derived `IDENTITY_HANDOFF_SECRET`. With a `jwksUrl` set, the Worker instead accepts RS256, PS256, ES256 and EdDSA tokens verified against that JWKS, and rejects HS256.

| Claim | Required | Meaning |
|-------|----------|---------|
| `iss`, `aud` | yes | Must equal the configured issuer and audience. |
| `iat`, `exp` | yes | `exp - iat` must be 1 to 120 seconds. The Worker allows 30 seconds of clock skew. |
| `jti` | yes | At least 8 characters. Single use. |
| `purpose` | yes | `dashboard-handoff` to sign in, `dashboard-revoke` to revoke. |
| `email` | yes | The administrator's address. If `email_verified` is present, it must be `true`. |
| `role` | sign-in | `owner` grants store-owner authority. Any other value must equal an existing dashboard role name. |
| `sub` | no | Stored as the account id of a new administrator and in the audit row. |
| `name` | no | Display name for a new administrator. |
| `suspend` | revoke | `true` also suspends the account. |

The audit row keyed by the hash of `purpose` and `jti` is the replay guard. A sign-in token cannot be replayed against the revoke endpoint, and the reverse.

To mint a token:

```bash
pnpm auth:handoff-token \
  --issuer https://control-plane.example --audience scalius:store-1 \
  --email operator@example.com --role owner \
  --dashboard-url https://shop.example.com/dashboard --from-env
```

- The command prints the token, then the URL to open. For `--mode revoke` it prints the revoke endpoint, and you POST the token in the body.
- Other options: `--mode handoff|revoke`, `--suspend` (revoke only), `--name`, `--subject`, `--lifetime <seconds>` (default 60, maximum 120), `--stdin`, `--json`.
- The command signs HS256 only, and checks its own signature before it prints.

### What a handoff does

1. The Worker verifies the token and claims the `jti` by inserting the audit row. A replay loses on the unique hash and is rejected.
2. The Worker maps the role. `owner` makes a super administrator. Any other value must match a role that exists in this store.
3. The Worker upserts the administrator by e-mail. On first arrival it creates the user, an account link with provider `identity-handoff`, and the role assignment.
4. The Worker creates a Better Auth session that counts as two-factor verified, and redirects into the dashboard.

For an administrator who already exists, the token's role replaces their authority: the user becomes an administrator, `isSuperAdmin` follows the `owner` claim, any other role replaces their assigned roles, and the forced password change and 2FA enrollment flags clear. A suspended administrator is rejected.

The table `admin_identity_handoff_events` records every verified token on its first use, with its outcome, the client IP, the user agent and the token expiry. Tokens that fail verification leave no row. The `identity_handoff_audit_prune` sweep of the API's scheduled maintenance deletes rows 90 days after the token expired. Revocation never suspends the store owner (`suspensionRefused: "store_owner"`).

## 3. Compatibility discovery

`GET /api/v1/meta` answers before a control plane commits to anything. It answers while `SCALIUS_SECRET` is missing and during a migration freeze. It reads no merchant data and sends `Cache-Control: no-store`. The response is `{ success, data }`, and `data` has these fields:

| Field | Meaning |
|-------|---------|
| `platform` | `{ name: "scalius-commerce", version }`, the API release. |
| `api` | `{ current, supportedMajors, basePath, openapi }`: `v1`, `["v1"]`, `/api/v1`, `/api/v1/openapi.json`. |
| `database.provider` | `d1`, `turso`, `postgres`, or `null` when the provider configuration is incomplete. |
| `database.schema.expected` | `{ version, name }` of the newest migration this build requires. |
| `database.schema.applied` | `{ version, name }` of the highest row in the store's `scalius_schema_migrations` ledger, or `null`. |
| `database.schema.status` | `current`, `behind`, `ahead`, `diverged` or `unavailable`. |
| `database.schema.detail` | A short error text, only when the status is `unavailable`. |
| `automation` | `setupTokenRequired`, `identityHandoffEnabled`, `localLoginDisabled`, `dashboardBasePath` (`""` at a host root), `frontProxySignature` (`"v1"`). |

- `behind`: migrations are pending (also the status of an empty ledger).
- `ahead`: the database is newer than this build.
- `diverged`: a shared revision differs from the release manifest by name or content hash. Never resolve this by applying more migrations.

## 4. Dashboard under a path prefix

A store can serve the dashboard from a path on another host, such as the storefront host. Set the Platform setting `dashboardUrl` to an origin plus a lowercase path prefix, for example `https://shop.example.com/dashboard`. A bare origin stays the default.

- The prefix has at most 4 segments. Each segment uses lowercase letters, digits and single hyphens. It has no query and no fragment.
- The prefix is a runtime value, so one build serves any prefix. The API Worker (`scalius-api`) serves the dashboard from its `ASSETS` binding and writes the prefix into the SPA shell: a `<meta name="scalius-dashboard-base-path">` tag and every root-relative `src` and `href`.
- The dashboard applies the prefix to its router, API calls, Better Auth routes, service-worker registration and full-page redirects. Better Auth also scopes its session cookie `Path` to the prefix.
- The front proxy must route `<prefix>/*` on that host to the API Worker. The Worker serves `<prefix>/api/v1/*` as the normal API.
- A request outside `/api/v1` on the dashboard host that lies outside the prefix gets a 308 redirect to the prefixed path (GET and HEAD) or a 404 (other methods).
- Once `dashboardUrl` is set, only its host serves the dashboard. Other hosts answer 404 for paths outside `/api/v1`, except on loopback (`pnpm dev`).
- `vite dev` serves at the host root and ignores the prefix. Set the prefix on the deployment.

On a shared host, the storefront reserves the first prefix segment:

- The pages API refuses to create or rename a CMS page to that slug.
- A visitor who requests that slug gets a 302 redirect to the dashboard before any page lookup.
- The reservation holds only while the dashboard and the storefront share an origin, or while the storefront origin is unknown.

## 5. Trusted front-proxy headers

Behind a routing Worker or reverse proxy, every Worker sees the proxy's host and address. The Workers honor `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Forwarded-For` only when the request also carries a valid signature. An unsigned or stale header cannot move a canonical URL, pass a cookie-origin check or change a rate-limit identity.

```text
X-Scalius-Proxy-Signature: v1,t=<unix seconds>,s=<base64url HMAC-SHA256>
```

The HMAC key is the derived `FRONT_PROXY_SECRET`. The signed text is these six lines, joined by newlines, with no trailing newline:

```text
v1
<unix seconds>
<proto>           http or https
<host>            public host[:port], lowercase
<pathname>        the request path as forwarded, no query string
<client ip>       first address in X-Forwarded-For, or empty
```

- The Worker rejects a timestamp more than 300 seconds from its own clock, an unknown proto, an invalid host, or a signature that does not match.
- On success, the Worker rewrites the request URL to the forwarded proto and host. It sets `cf-connecting-ip` to the forwarded client address when that is a valid IP.
- The Worker removes the signature header before the request reaches any route.
- The API Worker and the storefront Worker both apply this at their entry point.

## 6. Remote migrations without Wrangler

A control plane that applies migrations over the D1 HTTP API must reproduce what `wrangler d1 migrations apply` does, including the `d1_migrations` ledger rows. A later Wrangler run then finds nothing to apply.

```bash
pnpm --filter @scalius/database migration-plan
```

The plan is JSON (contract `scalius-d1-migration-plan/v1`; `--out <file>` writes it to a file). For each migration file it lists the statements to run and the exact `d1_migrations` insert to append. It also surfaces the provider-neutral release ledger `scalius_schema_migrations`, which every migration from 0050 onward writes itself. Compare the plan with the schema block of `GET /api/v1/meta` to decide whether anything needs applying. [packages/database/README.md](../packages/database/README.md) documents the plan format and the rules for applying it.

## 7. Headless demo-store export

A control plane can give every new store the same starting catalog without driving the admin API. Export mode turns a SQLite database that holds the demo store into a portable seed bundle.

```bash
pnpm demo:store --export ./bundle --source-db ./store.sqlite \
  --media-source-dir ./objects
```

Export mode needs no admin origin, credential or session. It opens the source file read-only and opens no network connection. [scripts/demo-store/README.md](../scripts/demo-store/README.md) documents the options and the manifest shape.

- A bundle holds `bundle.json`, `seed.sql` (deterministic catalog SQL), `media-manifest.json` (one entry per media row, keyed by object key) and, with `--media-source-dir`, the objects under `media/`.
- Two exports of the same database are byte-identical. A bundle has no timestamps or local paths.
- `bundle.json` records the contract `scalius-demo-store-seed/v1`, the schema revision (`{ version, name, sourceSha256 }`), row counts and the sha256 of `seed.sql` and `media-manifest.json`. Verify a transfer against these digests.
- The export reads 16 catalog tables and no others, so no order, customer, admin, session, settings or credential row reaches a bundle. It skips soft-deleted rows and media that are not `ready`.
- The export refuses instead of repairing, and every refusal names the rows in the way. It stops when:
  - the source is not at the schema revision this build expects (version, name and migration content hash);
  - an exported SKU has non-zero reserved stock, or an order line references the exported catalog;
  - a non-null foreign key on an exported row points at a row that is not exported, for example a tax class (clear it first);
  - a media object key is empty, repeated or outside the media directory, or a file in `--media-source-dir` is missing or has the wrong size.
- The output directory must be absent, empty or a previous bundle.

To load a bundle, run `seed.sql` against a freshly migrated, empty catalog at the same schema revision, with `PRAGMA foreign_keys = ON`.

- `seed.sql` is one transaction. Loading it over existing rows aborts and rolls back.
- The insert triggers of the schema rebuild the full-text indexes as the seed loads.
- The seed does not export the derived tables `product_buyer_state` and `product_facet_values`. It ends with the statements of migration 0091, which fill them.

## Verification

After a deploy, check the live store:

```bash
curl -s https://api.example.com/api/v1/meta | jq .
curl -s https://api.example.com/api/v1/platform | jq .
```

`pnpm release:check` does not read these two endpoints.
