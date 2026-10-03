# Loyalty points (`scalius.loyalty`)

A small example app: signed-in buyers earn points on paid orders and spend
them at checkout with a code. It exists to show how an app keeps a balance
that can never be spent twice.

## Merchant setup

1. Apps → Loyalty points → install and approve (it reads orders to credit
   points and offers a checkout discount).
2. Settings: the redeem code buyers type (default `POINTS`), points earned
   per 100 of your currency, the value of one point, and the fewest points a
   buyer may redeem.

## How it works

- **Earning** (`order.paid`): the app reads the order, and for an account
  order credits `points_per_100` per 100 paid. It writes a ledger entry keyed
  by the order and the new balance in one atomic `ctx.storage.batch`, the
  ledger entry only if it does not exist yet and the balance only at the
  revision it read. A redelivered event finds the entry and changes nothing;
  a racing credit or spend is re-read and retried.
- **Spending** (`checkout.discounts` with `snapshot: { collection: "balances" }`):
  when the buyer enters the code, the function gets the buyer's balance as
  its snapshot, offers a discount worth up to the items' value, and answers
  with `commit` — the reduced balance. Scalius writes that balance in the
  order's own commit batch at the snapshot's revision. If the balance changed
  after the quote (another order spent it, an earn landed), the order is
  refused and the buyer reviews it; points are never spent twice.

Refunds and cancellations do not return points in this example; the ledger
keeps what each order earned so a merchant can adjust a balance by hand.
