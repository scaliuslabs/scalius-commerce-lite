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

The invariant intentionally does not infer legal rates or complete geographic
coverage. It proves only that each effective taxable class retains at least one
active rate. Admin readiness reports geographic scope separately:

- an active `all` rate means every checkout destination has base coverage;
- scoped city, zone, and area rates cover only their exact saved identifiers;
- a class with scoped rates only is lifecycle-valid but is shown as selected-
  destination coverage, never globally ready; and
- every destination outside those exact scopes receives zero tax for that
  class.

The calculator applies every matching rate in priority order. An `all` rate
therefore applies together with a matching scoped rate; the admin calls out
that layering and directs merchants to Preview instead of presenting scoped
coverage as a legal or global completeness guarantee.

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

The correlated guard uses explicit static table-qualified identifiers. Drizzle
renders columns inside a projected SQL expression without table prefixes, so
unqualified `tax_rates.tax_class_id = tax_classes.id` would otherwise resolve
the inner `id` against the rate row and reject valid post-states.

## Admin behavior

The Rates workspace identifies a rate that is the only live coverage for the
default product or effective shipping class. It prevents the obvious delete,
deactivate, or move workflow and tells the merchant to add a replacement. D1
still rechecks every submitted mutation because browser state can be stale.

The workspace summary keeps two concepts distinct. Lifecycle readiness means
the enabled configuration passes the D1 invariant. Destination readiness is
global only for exempt classes or classes with an active all-destination rate.
Scoped-only configurations remain live, but use an attention state with the
number of exact saved destinations and explicit zero-tax behavior elsewhere.
This is an aggregate diagnostic; it does not invent a tax jurisdiction graph or
claim legal compliance.

## Verification

Focused lifecycle tests cover activation/read races, rate deactivation,
deletion, exempt-to-taxable class edits, successful guarded mutations, and the
admin coverage model. `tax-admin.service.d1.test.ts` runs the real generated SQL
against SQLite through a D1-compatible atomic batch adapter: it proves a failed
post-state guard rolls the mutation back, two concurrent removals retain one
active rate, and a stale last-rate delete cannot mutate the survivor. Existing
calculator, route, and form tests remain part of the focused tax gate.

Remaining release work includes configuration history/export and proving any
future bulk/import path uses the same service boundary. Rich legal-jurisdiction
coverage analysis should be added only with an authoritative merchant-owned
jurisdiction model; labels alone are not sufficient evidence.
