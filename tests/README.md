# Cross-package unit tests

This directory holds shared test helpers and unit tests that import code from more than one workspace. It is for contributors who write or run tests.

Most tests live beside the code they cover, as `*.test.ts` files in `apps/*`, `packages/*`, `plugins/*`, and `scripts/`. Vitest runs all of them, including this directory.

`.gitignore` lists `tests/`. The files below are tracked anyway. Add a new file here with `git add -f`.

## Run tests

Run from the repository root:

```bash
pnpm test                                   # all tests in the repository
pnpm test:watch                             # watch mode
pnpm exec vitest run tests/unit/core/orders # one directory or file
pnpm test:ci                                # what CI runs
```

`pnpm test:ci` runs the same tests, but runs the three database export and upload tests in `packages/database/__tests__/` one worker at a time.

The root `vitest.config.ts` sets `globals: true` and ignores `.claude/**`. It resolves the `@/` alias to `apps/admin-v2/src` or `apps/storefront/src` by the importing file. It stubs the `cloudflare:workers` module.

## Test conventions

| Suffix | Runs against |
|--------|--------------|
| `*.test.ts` | Pure logic or mocks |
| `*.d1.test.ts` | The real migrations on an in-memory SQLite database behind a D1-compatible binding (`createSqliteD1Database` in `packages/database/src/testing/sqlite-d1.ts`) |
| `*.postgres-native.test.ts` | A real PostgreSQL server. The tests skip unless `SCALIUS_TEST_POSTGRES_URL` points at a disposable server. Each one creates its own database with `createNativePostgres()` (`packages/database/src/testing/postgres-native.ts`: the canonical schema plus the rows migrations seed) and drops it in `afterAll` |

## Layout

```text
tests/
  setup.ts   Mock factories and seed generators
  unit/
    api/         response-envelope, timestamps
    core/
      inventory/ batch-reservation, reserve-deduct-release
      media/     media-settings, storage-url
      orders/    order-lifecycle, order-state-machine, order-search, update-order-atomicity
      pages/     page-content-sanitization
      payments/  cod-idempotency, process-payment, refund-validation
    shared/      html-sanitize
    storefront/  checkout-discount-input, checkout-error-messages, price-filter-url,
                 product-media, rich-content-media
```

Each file in `unit/` is named `<name>.test.ts`. Only `page-content-sanitization` and `reserve-deduct-release` import `setup.ts`. The other tests define their own fixtures.

## Helpers in `setup.ts`

| Helper | What it gives you |
|--------|-------------------|
| `createMockDb(overrides?)` | A drizzle-style database mock. It records calls in `db._calls` (clear with `db._reset()`), returns the configured results, and supports `batch()`. Chainable methods: `from`, `where`, `set`, `values`, `returning`, `orderBy`, `limit`, `offset`, `groupBy`, `leftJoin`, `innerJoin`. Terminal methods: `get()`, `all()`, and `await`. |
| `createMockEnv()` | Mock bindings `DB` (D1 `prepare`, `batch`, `exec`), `KV` (backed by a `Map`), `R2`, and `QUEUE` (`send`, `sendBatch`, messages in `_messages`). These names are the mock's own, not the Worker's binding names. |
| `seedProduct`, `seedVariant`, `seedOrder`, `seedOrderItem`, `seedCustomer` | Plain objects with defaults and per-field overrides. IDs use the prefixes `prod_`, `var_`, `ORD-`, `item_`, and `cust_`. Money fields are integer minor units (`*Minor`). |
