# Scalius Commerce -- Private Test Suite

This directory is gitignored. Tests are maintained by the core team only.

## Structure

```
tests/
  setup.ts              # Mock factories, seed data generators
  unit/
    core/
      orders/
        order-lifecycle.test.ts      # Order creation and update flows
        order-state-machine.test.ts  # Status transition validation
      inventory/
        batch-reservation.test.ts    # Multi-item stock reservation
        reserve-deduct-release.test.ts # Individual inventory operations
      payments/
        cod-idempotency.test.ts      # COD duplicate prevention
        process-payment.test.ts      # Payment confirmation processing
        refund-validation.test.ts    # Refund amount validation
      discounts/
        discount-validation.test.ts  # Discount rule validation
    api/
      response-envelope.test.ts      # API response envelope contract
    shared/                          # (empty -- placeholder for utility tests)
  integration/
    api-routes/                      # (empty -- placeholder for API route tests)
    checkout/                        # (empty -- placeholder for checkout flow tests)
    inventory/                       # (empty -- placeholder for concurrent inventory tests)
  fixtures/                          # (empty -- placeholder for shared test data)
```

## Running Tests

```bash
pnpm test           # Run all tests
pnpm test:watch     # Watch mode
```

## Configuration

The repository-root `vitest.config.ts` is authoritative. Tests in this directory
import `tests/setup.ts` explicitly when they need its mock factories or seed data.

## Test Setup (`setup.ts`)

### Mock DB Factory

`createMockDb(overrides?)` creates a mock drizzle-style database for unit tests:
- Tracks all calls for assertion (`db._calls`)
- Returns configurable results for `select`, `insert`, `update`, `delete`
- Supports `batch()` for atomic multi-statement operations
- Chainable methods: `from`, `where`, `set`, `values`, `returning`, `orderBy`, `limit`, `offset`, `groupBy`, `leftJoin`, `innerJoin`
- Terminal methods: `.get()` (single result), `.all()` (array), `.then()` (thenable for `await`)
- Reset: `db._reset()` clears recorded calls

### Mock Cloudflare Environment

`createMockEnv()` returns mocked Cloudflare bindings:
- `DB` -- Mock D1 with `prepare`, `batch`, `exec`
- `KV` -- Mock KV backed by `Map` with `get`, `put`, `delete`, `list`
- `R2` -- Mock R2 with `get`, `put`, `delete`, `list`
- `QUEUE` -- Mock Queue with `send`, `sendBatch` (tracks messages in `_messages`)

### Seed Data Generators

Factory functions with sensible defaults and override support:
- `seedProduct(overrides?)` -- Products with `prod_` prefix IDs
- `seedVariant(overrides?)` -- Variants with `var_` prefix IDs, stock/preorder/backorder fields
- `seedOrder(overrides?)` -- Orders with 6-char alphanumeric IDs, all financial fields
- `seedOrderItem(overrides?)` -- Order items with `item_` prefix IDs
- `seedCustomer(overrides?)` -- Customers with `cust_` prefix IDs, E.164 phone

## Test Coverage

8 test files covering critical business logic:

| Area | Tests | What's Covered |
|------|-------|----------------|
| Orders | 2 | Lifecycle (create/update), state machine (valid/invalid transitions) |
| Inventory | 2 | Batch reservation (multi-item), reserve/deduct/release operations |
| Payments | 3 | COD idempotency, payment confirmation processing, refund amount validation |
| Discounts | 1 | Discount rule validation |
| API | 1 | Response envelope `{ success: true, data: T }` contract |

Unit tests mock the DB at the drizzle level. Integration tests (currently empty) are intended to use miniflare.
