# Automated and Managed Deployments

Scalius installs by hand in a few minutes: create the Cloudflare resources,
install two secrets, deploy, and fill in Platform settings. That flow stays the
default and nothing on this page changes it.

This page is for the other case — a control plane that installs, upgrades, and
operates many stores without a human at a terminal. Seven opt-in contracts make
that possible. Every one of them:

- is **off by default**, so an existing store behaves exactly as it did before;
- is **provider-neutral** and works on D1, TursoDB, and PostgreSQL alike;
- adds **no Wrangler `vars`** and **no new installed secret** — every key is
  HKDF-derived from `SCALIUS_SECRET`, and every flag lives in the Platform
  settings document the dashboard already owns;
- never logs, echoes, or returns a derived secret.

| # | Contract | Turned on by | Reference |
|---|----------|--------------|-----------|
| 1 | Gated first-admin setup | Platform setting **Require a setup token** | [Setup token](#1-gated-first-admin-setup) |
| 2 | Trusted external identity handoff | Platform settings **Identity handoff** | [Identity handoff](#2-trusted-external-identity-handoff) |
| 3 | Compatibility discovery | Always available | [`GET /api/v1/meta`](#3-compatibility-discovery) |
| 4 | Dashboard under a path prefix | A path on the **Dashboard URL** setting | [Dashboard base path](#4-dashboard-under-a-path-prefix) |
| 5 | Trusted front-proxy headers | Sending a signed header | [Proxy signature](#5-trusted-front-proxy-headers) |
| 6 | Remote migrations without Wrangler | Reading the migration plan | [Migration contract](#6-remote-migrations-without-wrangler) |
| 7 | Headless demo-store export | Running the export command | [Demo-store export](#7-headless-demo-store-export) |

## Deriving the automation keys

Three purpose labels are reserved for automation. The control plane derives
them from the same `SCALIUS_SECRET` the Workers hold, so nothing new is ever
installed:

| Purpose label | Derived name | Used for |
|---------------|--------------|----------|
| `admin-setup` | `ADMIN_SETUP_TOKEN` | the `X-Scalius-Setup-Token` header value |
| `front-proxy` | `FRONT_PROXY_SECRET` | signing forwarded host, proto, and client IP |
| `identity-handoff` | `IDENTITY_HANDOFF_SECRET` | signing dashboard handoff tokens |

```bash
printf %s "$SCALIUS_SECRET" | pnpm secret:derive --purpose admin-setup --stdin
```

The tool reads the master secret from an interactive hidden prompt, from
standard input, or from the environment with `--from-env`. It never accepts it
as an argument, because arguments are visible to every process on the host, and
it refuses to derive the session, JWT, service-token, agent-pepper,
and customer-session keys: those are needed only inside a Worker, and printing
one would move a live credential into shell history.

Rotating `SCALIUS_SECRET` rotates all three at once.

## 1. Gated first-admin setup

A freshly deployed store has no administrator, and `POST /api/v1/setup` claims
that first account. On a store the operator provisions before handing it over,
that window should not be open to whoever finds the URL first.

Turn on **Settings → System → Platform → Require a setup token**. The endpoint
then additionally requires the derived token:

```
POST /api/v1/setup
X-Scalius-Setup-Token: <derived admin-setup value>
```

- The token is compared in constant time over SHA-256 digests, so its length
  never leaks. A rejected attempt logs the client IP and nothing else.
- A wrong or missing token is `403` with `A valid setup token is required to
  complete first-admin setup.` The pre-existing rate limit still applies first.
- If the gate is on but the runtime cannot derive the token, setup answers
  `503` rather than falling open.
- `GET /api/v1/setup` keeps reporting `{ adminExists }` and now also
  `setupTokenRequired`, so the dashboard's setup screen knows to ask for the
  token and a control plane can check the gate before it tries.

## 2. Trusted external identity handoff

When the operator's own identity provider owns operator identity, administrators
should not hold a second password here. The dashboard accepts a short-lived
token instead, mints a normal session from it, and writes an audit row.

Configure issuer, audience, and (for asymmetric signing) a JWKS URL under
**Settings → System → Platform → Automated and managed deployments**. Handoff
can only be enabled with both an issuer and an audience. Password sign-in can be
disabled only while handoff is enabled, and re-enables itself if handoff is ever
turned off, so a store can never be locked out.

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `<dashboardUrl>/api/auth/handoff?token=…` | GET | verify, upsert the admin, create a session, redirect to the dashboard |
| `<dashboardUrl>/api/auth/handoff/revoke` | POST | revoke that user's sessions, optionally suspend the account |

Both are rate limited to 10 requests per minute and answer `404` to any
well-formed request while handoff is disabled, so a store that never enabled it
does not advertise the surface. A `POST` with no content type is still the `415`
every Better Auth route gives, which says nothing about this one.

### Token contract

Signed with HS256 using the derived `IDENTITY_HANDOFF_SECRET`, or with RS256,
PS256, ES256, or EdDSA verified against the configured JWKS URL.

| Claim | Required | Meaning |
|-------|----------|---------|
| `iss` / `aud` | yes | must equal the configured issuer and audience |
| `iat` / `exp` | yes | `exp - iat` is at most 120 seconds; 30 seconds of clock skew is tolerated |
| `jti` | yes | at least 8 characters, single-use; the audit row keyed by its hash is the replay guard |
| `purpose` | yes | `dashboard-handoff` for sign-in, `dashboard-revoke` for revocation |
| `email` | yes | the administrator's address; `email_verified`, when present, must be `true` |
| `role` | sign-in | `owner` grants store-owner authority; any other value must equal an existing dashboard role |
| `name` | no | display name for a newly created administrator |
| `suspend` | revoke only | also suspend the account |

A purpose claim keeps a sign-in token from being replayed against the revoke
endpoint, and vice versa: the ledger hash is purpose-scoped.

```bash
pnpm auth:handoff-token \
  --issuer https://control-plane.example --audience scalius:store-1 \
  --email operator@example.com --role owner \
  --dashboard-url https://shop.example.com/dashboard --from-env
```

The command prints the token and the exact URL to open. It caps the lifetime at
the 120 seconds the verifier accepts and verifies its own output before handing
it over.

### What a handoff does

1. Verifies the token and claims the `jti` by inserting the audit row. A replay
   loses the race on the unique hash and is rejected.
2. Maps the role: `owner` becomes a super administrator; any other value must
   match a role that already exists in this store.
3. Upserts the administrator by verified e-mail, creating the user, the
   `identity-handoff` account link, and the role assignment on first arrival.
4. Creates an ordinary Better Auth session and redirects into the dashboard.

Every attempt — including every rejection, with its reason — lands in
`admin_identity_handoff_events` with the client IP, user agent, and token
expiry. Rows are pruned 90 days after the token expired by the API's scheduled
maintenance job. Revocation refuses to suspend the store owner, so an external
identity provider can never orphan a store.

## 3. Compatibility discovery

`GET /api/v1/meta` answers before a control plane commits to anything. It is a
probe: it answers while `SCALIUS_SECRET` is missing and during a migration
freeze, it never reads merchant data, and it is `Cache-Control: no-store`.

```jsonc
{
  "platform": { "name": "scalius-commerce", "version": "1.0.0" },
  "api": {
    "current": "v1",
    "supportedMajors": ["v1"],
    "basePath": "/api/v1",
    "openapi": "/api/v1/openapi.json"
  },
  "database": {
    "provider": "d1",                       // or turso, postgres, or null
    "schema": {
      "expected": { "version": 62, "name": "0062_identity_handoff_audit" },
      "applied":  { "version": 62, "name": "0062_identity_handoff_audit" },
      "status": "current"                   // behind | ahead | diverged | unavailable
    }
  },
  "automation": {
    "setupTokenRequired": false,
    "identityHandoffEnabled": false,
    "localLoginDisabled": false,
    "dashboardBasePath": "",
    "frontProxySignature": "v1"
  }
}
```

`expected` is the revision this build requires; `applied` is the highest row in
the store's own release ledger. `behind` means migrations are pending, `ahead`
means the database is newer than this build, and `diverged` means a shared
revision does not match the release manifest by name or content hash — that
last one is never safe to resolve by applying more migrations.

## 4. Dashboard under a path prefix

A store can serve the dashboard from a path on the storefront host instead of a
separate hostname. Set the **Dashboard URL** Platform setting to an origin
followed by a lowercase path prefix, for example
`https://shop.example.com/dashboard`. The default remains a bare origin, and
nothing changes for stores that keep one.

The prefix is a runtime value, not a build constant, so one deployed artifact
serves any prefix. The API Worker applies it to the SPA shell (a meta tag plus
every root-relative asset URL); it also sets the router base path, the Better
Auth base path and session cookie `Path`, API calls, service-worker
registration, and every full-page redirect. The front proxy routes `<prefix>/*`
on that host to the API Worker (`scalius-api`). Requests on that host outside
the prefix are redirected (GET and HEAD) or answered with 404.

Local `vite dev` is the one place the prefix does not apply: Vite serves its own
module URLs, which the Worker cannot route. Develop at the host root and set the
prefix on the deployment.

The storefront treats the first segment of the prefix as reserved: a CMS page
can no longer be created or renamed to it, and a visitor who requests it is
redirected to the dashboard before any page lookup happens. At most four
segments are accepted, and the prefix may carry no query or fragment.

## 5. Trusted front-proxy headers

Behind a routing Worker or reverse proxy, every Worker sees the proxy's hostname
and address. `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` are
honoured only when the request also carries a valid signature, so an unsigned or
stale header can never move a canonical URL, satisfy a cookie-origin check, or
change rate-limit identity.

```
X-Scalius-Proxy-Signature: v1,t=<unix seconds>,s=<base64url HMAC-SHA256>
```

The HMAC is keyed with the derived `FRONT_PROXY_SECRET` over these six lines,
newline separated with no trailing newline:

```
v1
<unix seconds>
<proto>                 http or https
<host>                  public host[:port]
<pathname>              request path as forwarded, no query string
<client ip>             first address in X-Forwarded-For, or empty
```

Signatures more than five minutes old or ahead are rejected. When the signature
verifies, the request URL is rewritten to the forwarded proto and host and
`cf-connecting-ip` is set to the forwarded client address; the signature header
is stripped before the request reaches any route. The API and storefront
Workers apply this at their entry point.

## 6. Remote migrations without Wrangler

A control plane that applies migrations over the D1 HTTP API needs to reproduce
exactly what `wrangler d1 migrations apply` would have done, including the
`d1_migrations` ledger rows Wrangler appends, so that a later Wrangler run
reports nothing left to apply.

```bash
pnpm --filter @scalius/database migration-plan
```

The plan lists, per migration file, the statements to execute and the exact
ledger insert to append, and it surfaces the provider-neutral release ledger
(`scalius_schema_migrations`) that every migration from 0050 onward writes
itself. `packages/database/README.md` documents the contract in full, including
the ledger DDL, the statement splitting rule, and how to verify a release
identity independently of Wrangler. Pair it with the schema block of
`GET /api/v1/meta` to decide whether anything needs applying at all.

## 7. Headless demo-store export

A control plane that provisions many stores wants to hand each new one the same
starting catalog without driving the admin API for every store. Export mode
turns a database the demo store has already been applied to into a portable
seed bundle.

```bash
pnpm demo:store --export ./bundle --source-db ./store.sqlite \
  --media-source-dir ./objects
```

It is the mirror image of `--apply`: no admin origin, no credential prompt, no
session, and no write path to a live store. Its only input is one SQLite file
opened read-only, so SQLite itself refuses any statement that would modify it,
and nothing in the mode opens a socket.

```
bundle.json            contract version, schema revision, row counts, artifact digests
seed.sql               canonical, deterministic SQL for the catalog
media-manifest.json    one entry per media row, keyed by object key
media/<object key>     only with --media-source-dir
```

Two exports of the same database are byte-identical: fixed table order,
primary-key row order, one spelling per value, and no timestamps or local paths
in any artifact. `bundle.json` records the revision as
`{ version, name, sourceSha256 }` and the sha256 of the other two files, so a
transfer can be verified before it is loaded.

The export refuses rather than repairs. It exports exactly fifteen catalog and
presentation tables and reads no others, so no order, customer, admin, session,
settings, or credential row can reach a bundle. On top of that it stops when:

- the source is not at the schema revision this build expects, by version, name,
  and the migration's own content hash;
- any exported variant carries non-zero reserved stock, or an order line
  reaches into the exported catalog;
- any non-null foreign key on an exported row points at a row that is not itself
  exported — including references out of the allow-list, such as a tax class,
  which must be cleared before a portable seed can be taken;
- a media object key is empty or claimed twice, or a media file named by
  `--media-source-dir` is missing or the wrong size.

Every message names the rows in the way. Foreign-key edges are read from the
database's own `PRAGMA foreign_key_list`, so a reference added by a future
migration is checked the day it lands.

`seed.sql` loads into a freshly migrated, empty catalog at the same revision
with `PRAGMA foreign_keys = ON`. It is one transaction, so a load against a
catalog that already holds these rows aborts and rolls back rather than merging.
The full-text indexes are not in the bundle: the schema's own insert triggers
rebuild them as the seed loads. `scripts/demo-store/README.md` documents every
flag and the manifest shape.

## Verification

Everything on this page is covered by tests that run in `pnpm test`. The
contracts that touch a live deployment are checked after deploy with:

```bash
curl -s https://api.example.com/api/v1/meta | jq .
curl -s https://api.example.com/api/v1/platform | jq .
pnpm release:check
```
