/**
 * The recorded budgets of the Workers plan harness (free-plan-budget.test.ts),
 * per plan profile and operation: the most D1 calls, D1 statements and
 * external subrequests each may use (after-response work included). They are the measured
 * values of the seeded store, so a new query or a new sequential await fails
 * the test before it reaches production. Raising one is a decision: say why
 * in the commit message.
 *
 * Regenerate after a deliberate change with `pnpm free-plan:budget --record`,
 * which prints this file's `BUDGETS` source.
 *
 * Rows written is the cost: D1 bills $1 a million (reads are $0.001), so a store's price is the rows
 * its operations write. `rowsWritten`/`rowsRead`/`fullScans` bound the worst run (the first run pays
 * one-off fills) with 5% + 1 row of headroom; `mean*` bounds a steady state. docs/SCALE.md explains the billed multiplier.
 *
 * order-lifecycle (2026-10-14, queue retirement): one 3-line order costs 34 D1
 * calls, the commit and its after-response work together; with the queue it
 * was 40 (13 for the commit, the rest in the queue consumer).
 *
 * Refund announcement (2026-11-03): the settlement batch also carries its
 * guard, the announced marker, the timeline line and the notice's outbox row
 * (the route no longer writes them in calls of their own). The recorded
 * 53 statements / 6 full scans were already stale: the base measured 48 calls,
 * 56 statements and 7 full scans (the 7th, the notice delivery's read of the
 * settings table's revision, predates this change). Now 43 calls, 56
 * statements, 7 full scans: the attempts turn refunded inside the settlement
 * batch. A refund of a gift-card purchase (`order-refund-gift-card`, a ৳1,000
 * card partly refunded in cash) measures 29 calls, 51 statements, 2 full scans:
 * the claim's clawback and the settlement ride batches that run anyway.
 * Status/refund (2026-10-15): 32/41 calls with RBAC warm, 38/47 in isolation
 * with a cold marker. Both retain a 50-call cap; other counters cover both runs.
 * Earlier 71/80 counts included the next run's setup.
 * The first admin list now measures existing RBAC reconciliation against seeded
 * roles, matching real first-admin setup: 9 calls, 15 statements, 0 writes. Its
 * 1,255 estimated reads include permission/grant scans; warm lists read 53 rows.
 * Cron (2026-10-15): first bundled-app registration creates three Object types;
 * their capacity checks add three scans of the at-most-100-row type catalogue.
 * INSERT RETURNING avoids rereading each created type. Measured worst calls are
 * 23 Free / 62 Paid; steady-state writes remain zero on both profiles.
 * Delivery concurrency (2026-11-13): a pass with more deliveries than its four
 * slots first reads each delivery's endpoint (one batch: the webhook rows' subscription
 * and the app rows' app, by id) so one slow endpoint holds one slot. Paid only (Free
 * passes never exceed four): +2 statements and a row read per delivery; sending
 * at once also makes the rows a claim reads (an app's deliveries in flight) vary by a few.
 * Bulk runs (2026-10-19): every tick's drain looks for a due bulk run (one
 * indexed read of bulk_runs, no rows on an idle store): +1 call per tick,
 * 24 Free / 63 Paid idle.
 * Server tracking (2026-10-19): the GA4/TikTok due rows and the hourly purges
 * ride in the Meta outbox's batch (no new call): +3 statements on the Paid
 * idle tick that runs it, 69 with bulk runs; Free is unchanged.
 * Trigger scans (2026-10-20): the meter now also plans the triggers a write
 * fires (free-plan-meter.ts). Every scan it found in a trigger body reads a
 * small configuration table, never one that grows with the catalogue or the
 * orders: navigation_menus (products/categories/collections/pages navigation
 * dependency triggers) and sales_channels (channel stock and publishing
 * triggers). A product save fires both: fullScans 27 -> 29 Free, 55 -> 57
 * Paid; the drain's rebuild chunk fires one: 10 -> 11 Free. Recorded as an
 * accepted cost, not a code change.
 * New cases (2026-10-20): a bulk run's 90-product chunk in coarse cache-clock
 * mode (7 calls, 1,944 rows: about 22 rows a product, so a 5,000-item run is
 * about 108k rows, still above Free's 100k daily writes); a 3-line checkout
 * with Meta, GA4 and TikTok on (45 calls of Free's 50); a hosted payment
 * confirmation with the three purchases (25 calls).
 * Due-work probe (2026-10-21): one statement asks every background drain's
 * index probes whether it has due rows (scheduled/due-work.ts) and only those
 * drains run. Idle tick mean 8.78 -> 2.78 calls Free, 9.73 -> 3.73 Paid; worst
 * idle minute 15 -> 10 Free, 51 -> 45 Paid; a busy drain tick 12 -> 7 Free,
 * 13 -> 8 Paid. The probe's one-row SELECT adds one row read a tick.
 *
 * FTS5 update guards (2026-10-21, migration 0169): a SKU's stock write no longer
 * deletes and re-inserts its unchanged search text, nor a product's revision
 * bump: rows written per 20-line checkout commit 559 -> 365, 99-line
 * 2,523 -> 1,503, 3-line order 93 -> 69, SKU stock change 48 -> 6, bulk run
 * chunk 1,944 -> 996. Budgets lowered to the new measurements.
 *
 * SKU stock change (2026-10-21): the stable write answering its SKU (L1) had
 * taken it to 13 calls and 18 statements (the Idempotency-Key lease adds no
 * call: its claim and completion are the two the key always cost). The
 * operation's reads (its key's earlier result, the SKU, the location with the
 * SKU's on-hand there) are one batch, and the SKU's read-back rides at the end
 * of the commit batch: 9 calls, 17 statements. Run alone, the case pays 6 more
 * for the cold RBAC reconciliation marker (15).
 *
 * Status commands in one batch (2026-11-03): a status change sends its CAS,
 * stock, timeline line and customer message as one batch (one more statement:
 * the guard proving the change landed) and no longer re-reads the order or
 * re-writes its inventory action: order-status-change 50 -> 36 calls, 42 -> 43
 * statements, 35 -> 17 rows written; order-refund 50 -> 42 calls. New case
 * bulk-confirm: one request of the plan's slice (30 orders on Free, 90 on
 * Paid) is one read and one batch per 30 orders, its messages handed to the
 * plan's bounded sender: 14 calls on Free, 187 on Paid (20 deliveries).
 *
 * Bulk confirm with a stock repair (2026-11-04): 29 new orders and one
 * restored order, whose stock is reserved again through the full status
 * change after the cheap batches: 26 calls on Free (of 50), 197 on Paid.
 * Paid bulk-confirm rowsRead 255 -> 256 (one row of run-to-run noise).
 *
 * Refund attempt claims (2026-11-13): a refund's provider acceptance names the
 * attempt's claim in the refund row's own update (an EXISTS on the attempt),
 * so a request whose lease ran out writes nothing: +1 row read per provider
 * allocation, no call, no statement (order-refund-gift-card 51 -> 53,
 * order-refund-subscribers-1 98 -> 100, -3 166 -> 168 rows read on Free).
 *
 * Payment session state (2026-11-13): the batch that lands a payment also
 * moves the session it names to `paid`: +1 statement, no call
 * (payment-webhook-confirmed 39 -> 40 statements).
 *
 * Payment webhook (2026-10-24): +2 statements, no call. The event claim
 * checks the event's legacy key in its own insert batch (exact event ids,
 * one round trip), and the batch that lands a payment closes the
 * off-session commands it settles (39 statements, 25 calls).
 *
 * Order notification (2026-11-03): one order_created message (buyer email,
 * staff push without Firebase, one staff email) was 37 D1 calls: the settings
 * documents read 9 times, the order and its context 6, provider health twice
 * per channel, 3 calls per receipt and the staff alert recorded twice. A
 * dispatch now reads its context and documents in one batch on a scoped
 * handle, each receipt claim or skip is one statement and the staff alert is
 * one batch recorded once: 12 calls.
 *
 * Event drain (2026-11-03): a drain claimed and fanned out each event on its
 * own (a claim, a subscriber read, an insert and a re-read per target, a
 * mark: about 8 calls an event), so Free took 2 events a tick. One statement
 * now claims the drain, each target reads its subscribers once and writes
 * every delivery in one round trip, and one batch marks the drain: 6 calls
 * whatever the count. Free now drains 20 events and sends 4 deliveries a
 * tick (2 after a write, in the write's invocation): 24 calls with 5 apps
 * and 3 webhooks (160 delivery rows).
 *
 * Pinned clock (2026-11-03): the analytics seal took the wall clock, so each
 * real day the file ran later sealed one more day on the first idle tick
 * (cron-idle had reached 123 rows written against 117). The seal and the
 * nightly pass now take the tick's scheduled time, and the harness starts the
 * wall clock and SQL time at 2026-10-03T10:00Z, so a run on any day measures
 * the same store. Re-measured: idle worst minute 19 -> 10 calls Free (the
 * seeded orders are 12 days old, not 40: nothing ages into a sweep), 57 -> 48
 * Paid.
 *
 * Measured, not capped (2026-11-03): status change and refund held the Free
 * cap (50) as their budget. Each is now its worst measured run, which is the
 * case run alone with a cold RBAC marker: status 40 calls / 44 statements,
 * refund 48 / 56 (warm, in the full file: 34 and 42). The retention job's
 * Meta log and order-history purges add 5 calls to the Paid sweep tick
 * (cron-idle 48 -> 53); the Free worst minute stays 10.
 *
 * Webhook subscribers (2026-11-03): a 3-line order's commit and after-response
 * work with 0, 3 and 8 store webhooks subscribed to every topic. Free sends at
 * most 2 deliveries after the response (the cron sends the rest), each six
 * sequential calls: 30 calls, then 54 to 56 at 3 and 8 (which two deliveries
 * go first varies by a call or two), over Free's 50 from three subscribers on
 * (a known gap the file asserts with `it.fails`). Paid sends up to 25: 30, 81
 * and 146.
 *
 * Status change and refund with 1 and 3 webhooks (2026-11-04, after the
 * bulk-confirm status rework): Free 48 and 54 calls for a status change (cold
 * RBAC marker at one subscriber: inside 50 at one, over it at three), 66 for a
 * refund at both, over the 50 (the same known gap). Paid's refund cases drain
 * up to 25 due deliveries the earlier cases left (249 and 293 calls). One
 * uploaded app subscribed to every order event: 48 calls on Free, inside 50.
 * Which deliveries the after-response drain takes first depends on random
 * ids, so the subscriber cases move by a call or two between runs: their
 * budgets carry 2 calls and 4 statements of headroom over the worst run seen.
 *
 * Merged tree (2026-11-04, after the event-drain and notification rework):
 * every subscriber case fits Free's 50, so the known gap is closed. Free,
 * worst run: an order 16 calls with no webhook, 27 with 3 or 8, 24 with one
 * app; a status change 33 and 30 with 1 and 3 webhooks; a refund 44 and 42.
 * The subscriber cases now leave no app, webhook or due delivery behind
 * (`withoutSubscribers`), so the drain case and they measure only their own.
 * Re-recorded once on this tree: most writes fell with the batched drain
 * (3-line order 34 -> 14 calls, status change 36 -> 24, refund 48 -> 36);
 * bulk confirm and its repair now batch more statements into fewer calls
 * (Free 14 -> 9 calls, 104 -> 105 statements; Paid 455 -> 475 statements);
 * the Paid sweep tick measures 2 calls more (56), not traced to one change.
 *
 * Staff and buyer limits (2026-11-04, after the auth hardening merged): a
 * staff password sign-in reserves its per-email and per-network attempts in
 * D1 before the check and gives a right answer's attempt back (6 -> 9 calls);
 * an OTP request counts the store-wide ceiling atomically after its cooldown
 * (13 -> 16 calls). The Paid sweep tick also sweeps lapsed attempt windows in
 * the OTP rate-limit cleanup job (56 -> 58 calls).
 *
 * Stock in one read (2026-11-04, final audit F1): a cancel that releases a
 * 3-line order's stock, or a full refund that cancels it, needed 52 to 56 D1
 * calls on Free with any webhook subscriber, its after-response work
 * included: preparing the stock read the order, its lines, then each SKU's
 * counters, movement generation and ledger context one at a time (12 calls
 * for 3 lines), and the low-stock check after it 2 calls a SKU. The order,
 * lines, SKUs, movements and an open return are now one read batch, and the
 * alerts one read (plus one write batch only when an alert changes). New
 * cases, Free worst run: cancel with stock 28 / 39 / 37 calls at 0 / 1 / 3
 * webhooks, full refund that cancels 30 / 41 / 39 (before: 48 / 54 / 52 and
 * 42 / 56 / 54); budgets carry the subscriber cases' 2 calls and 4 statements
 * of headroom. Lowered with it: status change 24 -> 18 calls, and its rows
 * read 1,339 -> 34 (the per-SKU generation count walked the movement type
 * index), refund rows read 1,341 -> 27, the subscriber status changes and
 * refunds 2 to 7 calls each. Raised: bulk-confirm-repair +2 statements
 * (its restored order's read batch has 5 statements where 3 calls read the
 * order, its line and its generation), and the status change with 3
 * webhooks reads 5 rows more (the order's movements and SKUs come whole).
 * Merged fix wave (2026-11-13): several branches re-recorded budgets on their
 * own bases; on the merged code three record runs measure less than several
 * of them hold, so every budget looser than the worst of the three runs is
 * lowered to it (the docs/SCALE.md table is regenerated from this file). The
 * subscriber and webhook cases keep their 2 calls and 4 statements of headroom
 * (concurrent deliveries vary by up to 2 calls between runs).
 *
 * Disputes (2026-11-13): a refund reads the order's disputes beside its payment
 * ledger, in the batch that reads the ledger (no new call): the request's read
 * and the settlement's read, +2 statements; a refund of a gift-card purchase
 * also reads them in its clawback settlement, +3. Every payment insert stays
 * free of a scan: the disputes' payment key is indexed.
 */
import type { WorkersPlan } from "@scalius/shared/plan-limits";

export interface Budget {
  d1Calls?: number;
  d1Statements?: number;
  externalFetches?: number;
  /**
   * Rows written, the cost D1 bills ($1 a million; reads are $0.001): SQLite's rows changed, triggers'
   * writes included. D1 also bills the index entries of each row (docs/SCALE.md has the measured multiplier).
   */
  rowsWritten?: number;
  /** Rows read (plan estimate: rows returned plus every scanned table's rows). */
  rowsRead?: number;
  /** Full table scans in the executed plans: a scan reads more rows with every row the table gains. */
  fullScans?: number;
  /** A steady state's mean rows written per run (the idle cron tick is paid a thousand times a day, by every store). */
  meanRowsWritten?: number;
  meanRowsRead?: number;
}

export const BUDGETS: Record<WorkersPlan, Record<string, Budget>> = {
  free: {
    "staff-sign-in": { d1Calls: 9, d1Statements: 9, externalFetches: 0, rowsWritten: 6, rowsRead: 10, fullScans: 0 },
    // rowsRead grows with the bundled apps a deployment ships (Noor and the
    // Bangladesh pack today).
    "staff-sign-up": { d1Calls: 5, d1Statements: 5, externalFetches: 0, rowsWritten: 5, rowsRead: 10, fullScans: 17 },
    "customer-otp-request": { d1Calls: 16, d1Statements: 20, externalFetches: 0, rowsWritten: 10, rowsRead: 21, fullScans: 2 },
    "customer-otp-verify": { d1Calls: 8, d1Statements: 19, externalFetches: 0, rowsWritten: 14, rowsRead: 6, fullScans: 1 },
    "page-home-miss": { d1Calls: 11, d1Statements: 25, externalFetches: 0, rowsWritten: 1, rowsRead: 18, fullScans: 11 },
    "page-home-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "page-product-miss": { d1Calls: 19, d1Statements: 36, externalFetches: 0, rowsWritten: 1, rowsRead: 27, fullScans: 10 },
    "page-product-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "page-category-miss": { d1Calls: 5, d1Statements: 17, externalFetches: 0, rowsWritten: 1, rowsRead: 9, fullScans: 5 },
    "page-category-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "page-search-miss": { d1Calls: 6, d1Statements: 15, externalFetches: 0, rowsWritten: 1, rowsRead: 656, fullScans: 16 },
    "page-search-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "checkout-20-quote": { d1Calls: 10, d1Statements: 17, externalFetches: 0, rowsWritten: 1, rowsRead: 52, fullScans: 3 },
    "checkout-20-commit": { d1Calls: 16, d1Statements: 125, externalFetches: 0, rowsWritten: 335, rowsRead: 209, fullScans: 38 },
    "checkout-99-quote": { d1Calls: 11, d1Statements: 18, externalFetches: 0, rowsWritten: 1, rowsRead: 218, fullScans: 3 },
    "checkout-99-commit": { d1Calls: 14, d1Statements: 382, externalFetches: 0, rowsWritten: 1344, rowsRead: 877, fullScans: 137 },
    "admin-order-list": { d1Calls: 9, d1Statements: 15, externalFetches: 0, rowsWritten: 1, rowsRead: 1378, fullScans: 4 },
    "admin-order-list-deep": { d1Calls: 3, d1Statements: 7, externalFetches: 0, rowsWritten: 1, rowsRead: 57, fullScans: 0 },
    "admin-product-save": { d1Calls: 21, d1Statements: 36, externalFetches: 0, rowsWritten: 539, rowsRead: 164, fullScans: 26 },
    "order-status-change": { d1Calls: 17, d1Statements: 33, externalFetches: 0, rowsWritten: 10, rowsRead: 34, fullScans: 1 },
    "bulk-confirm": { d1Calls: 9, d1Statements: 105, externalFetches: 0, rowsWritten: 131, rowsRead: 73, fullScans: 0 },
    "bulk-confirm-repair": { d1Calls: 19, d1Statements: 126, externalFetches: 0, rowsWritten: 134, rowsRead: 90, fullScans: 5 },
    "order-refund": { d1Calls: 24, d1Statements: 44, externalFetches: 0, rowsWritten: 19, rowsRead: 27, fullScans: 3 },
    "order-refund-gift-card": { d1Calls: 27, d1Statements: 63, externalFetches: 0, rowsWritten: 48, rowsRead: 53, fullScans: 2 },
    "sku-stock-change": { d1Calls: 9, d1Statements: 17, externalFetches: 0, rowsWritten: 8, rowsRead: 18, fullScans: 4 },
    "cron-idle": { d1Calls: 10, d1Statements: 20, externalFetches: 0, rowsWritten: 98, rowsRead: 7453, fullScans: 16, meanRowsWritten: 0, meanRowsRead: 2.17 },
    "cron-nightly": { d1Calls: 28, d1Statements: 35, externalFetches: 0, rowsWritten: 430, rowsRead: 25783, fullScans: 75 },
    "drain-busy": { d1Calls: 7, d1Statements: 17, externalFetches: 0, rowsWritten: 15, rowsRead: 665, fullScans: 16 },
    "order-3-line-commit": { d1Calls: 14, d1Statements: 68, externalFetches: 0, rowsWritten: 58, rowsRead: 69, fullScans: 18 },
    "order-lifecycle": { d1Calls: 14, d1Statements: 68, externalFetches: 0, rowsWritten: 58, rowsRead: 69, fullScans: 18 },
    "bulk-run-chunk": { d1Calls: 7, d1Statements: 195, externalFetches: 0, rowsWritten: 1142, rowsRead: 292, fullScans: 4 },
    "order-3-line-commit-tracking": { d1Calls: 25, d1Statements: 94, externalFetches: 3, rowsWritten: 70, rowsRead: 108, fullScans: 18 },
    "payment-webhook-confirmed": { d1Calls: 24, d1Statements: 40, externalFetches: 1, rowsWritten: 14, rowsRead: 31, fullScans: 0 },
    "notification-order-created": { d1Calls: 12, d1Statements: 26, externalFetches: 0, rowsWritten: 13, rowsRead: 34, fullScans: 5 },
    "event-drain-5-apps-3-webhooks": { d1Calls: 24, d1Statements: 38, externalFetches: 3, rowsWritten: 250, rowsRead: 375, fullScans: 0 },
    "order-3-line-commit-subscribers-0": { d1Calls: 18, d1Statements: 74, externalFetches: 0, rowsWritten: 72, rowsRead: 89, fullScans: 18 },
    "order-3-line-commit-subscribers-3": { d1Calls: 29, d1Statements: 92, externalFetches: 2, rowsWritten: 82, rowsRead: 113, fullScans: 18 },
    "order-3-line-commit-subscribers-8": { d1Calls: 29, d1Statements: 92, externalFetches: 2, rowsWritten: 98, rowsRead: 134, fullScans: 18 },
    "order-status-change-subscribers-1": { d1Calls: 27, d1Statements: 49, externalFetches: 1, rowsWritten: 17, rowsRead: 51, fullScans: 1 },
    "order-refund-subscribers-1": { d1Calls: 39, d1Statements: 65, externalFetches: 2, rowsWritten: 91, rowsRead: 100, fullScans: 3 },
    "order-status-change-subscribers-3": { d1Calls: 30, d1Statements: 50, externalFetches: 2, rowsWritten: 22, rowsRead: 58, fullScans: 1 },
    "order-refund-subscribers-3": { d1Calls: 38, d1Statements: 63, externalFetches: 2, rowsWritten: 129, rowsRead: 168, fullScans: 3 },
    "order-3-line-commit-app-subscriber": { d1Calls: 24, d1Statements: 84, externalFetches: 0, rowsWritten: 76, rowsRead: 97, fullScans: 18 },
    "order-cancel-stock-subscribers-0": { d1Calls: 29, d1Statements: 66, externalFetches: 0, rowsWritten: 36, rowsRead: 80, fullScans: 9 },
    "order-full-refund-cancel-subscribers-0": { d1Calls: 31, d1Statements: 68, externalFetches: 0, rowsWritten: 61, rowsRead: 72, fullScans: 7 },
    "order-cancel-stock-subscribers-1": { d1Calls: 38, d1Statements: 82, externalFetches: 2, rowsWritten: 45, rowsRead: 99, fullScans: 9 },
    "order-full-refund-cancel-subscribers-1": { d1Calls: 40, d1Statements: 84, externalFetches: 2, rowsWritten: 97, rowsRead: 118, fullScans: 7 },
    "order-cancel-stock-subscribers-3": { d1Calls: 37, d1Statements: 80, externalFetches: 2, rowsWritten: 49, rowsRead: 103, fullScans: 9 },
    "order-full-refund-cancel-subscribers-3": { d1Calls: 39, d1Statements: 82, externalFetches: 2, rowsWritten: 122, rowsRead: 164, fullScans: 7 },
  },
  paid: {
    "staff-sign-in": { d1Calls: 9, d1Statements: 9, externalFetches: 0, rowsWritten: 6, rowsRead: 10, fullScans: 0 },
    // rowsRead grows with the bundled apps a deployment ships (Noor and the
    // Bangladesh pack today).
    "staff-sign-up": { d1Calls: 5, d1Statements: 5, externalFetches: 0, rowsWritten: 5, rowsRead: 10, fullScans: 17 },
    "customer-otp-request": { d1Calls: 16, d1Statements: 20, externalFetches: 0, rowsWritten: 10, rowsRead: 21, fullScans: 2 },
    "customer-otp-verify": { d1Calls: 8, d1Statements: 19, externalFetches: 0, rowsWritten: 14, rowsRead: 6, fullScans: 1 },
    "page-home-miss": { d1Calls: 11, d1Statements: 25, externalFetches: 0, rowsWritten: 1, rowsRead: 18, fullScans: 11 },
    "page-home-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "page-product-miss": { d1Calls: 19, d1Statements: 36, externalFetches: 0, rowsWritten: 1, rowsRead: 27, fullScans: 10 },
    "page-product-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "page-category-miss": { d1Calls: 5, d1Statements: 17, externalFetches: 0, rowsWritten: 1, rowsRead: 9, fullScans: 5 },
    "page-category-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "page-search-miss": { d1Calls: 6, d1Statements: 15, externalFetches: 0, rowsWritten: 1, rowsRead: 656, fullScans: 16 },
    "page-search-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "checkout-20-quote": { d1Calls: 10, d1Statements: 17, externalFetches: 0, rowsWritten: 1, rowsRead: 52, fullScans: 3 },
    "checkout-20-commit": { d1Calls: 16, d1Statements: 125, externalFetches: 0, rowsWritten: 335, rowsRead: 209, fullScans: 38 },
    "checkout-99-quote": { d1Calls: 11, d1Statements: 18, externalFetches: 0, rowsWritten: 1, rowsRead: 218, fullScans: 3 },
    "checkout-99-commit": { d1Calls: 14, d1Statements: 382, externalFetches: 0, rowsWritten: 1344, rowsRead: 877, fullScans: 137 },
    "admin-order-list": { d1Calls: 9, d1Statements: 15, externalFetches: 0, rowsWritten: 1, rowsRead: 1378, fullScans: 4 },
    "admin-order-list-deep": { d1Calls: 3, d1Statements: 7, externalFetches: 0, rowsWritten: 1, rowsRead: 57, fullScans: 0 },
    "admin-product-save": { d1Calls: 35, d1Statements: 57, externalFetches: 0, rowsWritten: 1240, rowsRead: 348, fullScans: 54 },
    "order-status-change": { d1Calls: 17, d1Statements: 33, externalFetches: 0, rowsWritten: 10, rowsRead: 34, fullScans: 1 },
    "bulk-confirm": { d1Calls: 87, d1Statements: 475, externalFetches: 0, rowsWritten: 442, rowsRead: 319, fullScans: 0 },
    "bulk-confirm-repair": { d1Calls: 95, d1Statements: 316, externalFetches: 0, rowsWritten: 194, rowsRead: 209, fullScans: 5 },
    "order-refund": { d1Calls: 24, d1Statements: 44, externalFetches: 0, rowsWritten: 19, rowsRead: 27, fullScans: 3 },
    "order-refund-gift-card": { d1Calls: 27, d1Statements: 63, externalFetches: 0, rowsWritten: 48, rowsRead: 53, fullScans: 2 },
    "sku-stock-change": { d1Calls: 9, d1Statements: 17, externalFetches: 0, rowsWritten: 8, rowsRead: 18, fullScans: 4 },
    "cron-idle": { d1Calls: 60, d1Statements: 70, externalFetches: 0, rowsWritten: 105, rowsRead: 7483, fullScans: 19, meanRowsWritten: 0, meanRowsRead: 3.01 },
    "cron-nightly": { d1Calls: 216, d1Statements: 317, externalFetches: 0, rowsWritten: 430, rowsRead: 28349, fullScans: 451 },
    "drain-busy": { d1Calls: 8, d1Statements: 23, externalFetches: 0, rowsWritten: 17, rowsRead: 669, fullScans: 19 },
    "order-3-line-commit": { d1Calls: 14, d1Statements: 68, externalFetches: 0, rowsWritten: 58, rowsRead: 69, fullScans: 18 },
    "order-lifecycle": { d1Calls: 14, d1Statements: 68, externalFetches: 0, rowsWritten: 58, rowsRead: 69, fullScans: 18 },
    "bulk-run-chunk": { d1Calls: 7, d1Statements: 195, externalFetches: 0, rowsWritten: 1142, rowsRead: 292, fullScans: 4 },
    "order-3-line-commit-tracking": { d1Calls: 25, d1Statements: 94, externalFetches: 3, rowsWritten: 70, rowsRead: 108, fullScans: 18 },
    "payment-webhook-confirmed": { d1Calls: 24, d1Statements: 40, externalFetches: 1, rowsWritten: 14, rowsRead: 31, fullScans: 0 },
    "notification-order-created": { d1Calls: 12, d1Statements: 26, externalFetches: 0, rowsWritten: 13, rowsRead: 34, fullScans: 5 },
    "event-drain-5-apps-3-webhooks": { d1Calls: 108, d1Statements: 168, externalFetches: 25, rowsWritten: 868, rowsRead: 993, fullScans: 0 },
    "order-3-line-commit-subscribers-0": { d1Calls: 18, d1Statements: 74, externalFetches: 0, rowsWritten: 72, rowsRead: 89, fullScans: 18 },
    "order-3-line-commit-subscribers-3": { d1Calls: 44, d1Statements: 115, externalFetches: 6, rowsWritten: 94, rowsRead: 133, fullScans: 18 },
    "order-3-line-commit-subscribers-8": { d1Calls: 74, d1Statements: 166, externalFetches: 16, rowsWritten: 142, rowsRead: 189, fullScans: 18 },
    "order-status-change-subscribers-1": { d1Calls: 27, d1Statements: 49, externalFetches: 1, rowsWritten: 17, rowsRead: 51, fullScans: 1 },
    "order-refund-subscribers-1": { d1Calls: 104, d1Statements: 176, externalFetches: 18, rowsWritten: 141, rowsRead: 210, fullScans: 3 },
    "order-status-change-subscribers-3": { d1Calls: 33, d1Statements: 55, externalFetches: 3, rowsWritten: 26, rowsRead: 61, fullScans: 1 },
    "order-refund-subscribers-3": { d1Calls: 116, d1Statements: 193, externalFetches: 25, rowsWritten: 201, rowsRead: 296, fullScans: 3 },
    "order-3-line-commit-app-subscriber": { d1Calls: 24, d1Statements: 84, externalFetches: 0, rowsWritten: 76, rowsRead: 97, fullScans: 18 },
    "order-cancel-stock-subscribers-0": { d1Calls: 29, d1Statements: 66, externalFetches: 0, rowsWritten: 36, rowsRead: 80, fullScans: 9 },
    "order-full-refund-cancel-subscribers-0": { d1Calls: 31, d1Statements: 68, externalFetches: 0, rowsWritten: 61, rowsRead: 72, fullScans: 7 },
    "order-cancel-stock-subscribers-1": { d1Calls: 38, d1Statements: 82, externalFetches: 2, rowsWritten: 45, rowsRead: 99, fullScans: 9 },
    "order-full-refund-cancel-subscribers-1": { d1Calls: 81, d1Statements: 152, externalFetches: 12, rowsWritten: 129, rowsRead: 187, fullScans: 7 },
    "order-cancel-stock-subscribers-3": { d1Calls: 51, d1Statements: 102, externalFetches: 6, rowsWritten: 61, rowsRead: 120, fullScans: 9 },
    "order-full-refund-cancel-subscribers-3": { d1Calls: 117, d1Statements: 214, externalFetches: 25, rowsWritten: 195, rowsRead: 278, fullScans: 7 },
  },
};
