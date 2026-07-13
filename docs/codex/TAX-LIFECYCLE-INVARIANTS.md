# Tax Lifecycle Invariants

Last verified: 2026-07-13

Tax settings, classes, and rates are authoritative in D1. The admin UI may
explain or pre-disable an unsafe action, but it is never the enforcement
boundary.

## Enabled configuration invariant

An enabled configuration is valid only when:

- its saved default class exists and is not deleted;
- that class is exempt or has at least one active, non-deleted rate; and
- when shipping tax is enabled, the saved shipping class (or the default class
  when no override is saved) is also exempt or has at least one active,
  non-deleted rate.

The invariant intentionally does not infer legal rates or geographic coverage.
Destination overlap and coverage diagnostics remain separate work.

## Mutation boundary

`packages/core/src/modules/tax/tax-admin.service.ts` commits each mutation that
can reduce effective coverage in one D1 atomic batch:

1. write the versioned settings, class, or rate mutation;
2. evaluate the enabled configuration against the post-mutation D1 state;
3. roll back the batch and return a conflict when the invariant is false.

This applies to enabling tax, changing an exempt class to taxable, moving or
deactivating an active rate, and deleting an active rate. Creating a rate and
editing facts that cannot reduce active coverage do not need the guard. A
disabled setup may remain incomplete so a merchant can repair or dismantle it.

Putting both activation and coverage-reducing writes behind the same batch
closes the race where activation reads a valid rate while another request
removes that last rate. Two concurrent last-rate removals also serialize: the
first may commit only while replacement coverage remains, and the mutation
that would remove final coverage rolls back.

## Admin behavior

The Rates workspace identifies a rate that is the only live coverage for the
default product or effective shipping class. It prevents the obvious delete,
deactivate, or move workflow and tells the merchant to add a replacement. D1
still rechecks every submitted mutation because browser state can be stale.

## Verification

Focused lifecycle tests cover activation/read races, rate deactivation,
deletion, exempt-to-taxable class edits, successful guarded mutations, and the
admin coverage model. Existing calculator, route, and form tests remain part of
the focused tax gate.

Remaining release work includes destination coverage/overlap diagnostics,
configuration history/export, and proving any future bulk/import path uses the
same service boundary.
