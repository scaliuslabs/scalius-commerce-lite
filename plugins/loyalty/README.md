# Loyalty points (`scalius.loyalty`)

A small first-party example app for merchants and plugin authors. Signed-in buyers earn points on paid orders and spend them at checkout with a code. It shows how an app keeps a balance that is never spent twice (`packages/plugin-sdk/README.md`, "Checkout functions").

It needs the `orders.view` permission. Balances live in the `balances` collection (record id = customer id) and what each order earned in `ledger` (record id `earn:<order id>`).

## Set it up

Open **Apps**, then Loyalty points. Adjust the settings and save. A Super Admin selects **Review and activate**.

| Setting | Default | Range |
| --- | --- | --- |
| Discount name at checkout | `Loyalty points` | At most 40 characters |
| Redeem code (buyers type it at checkout) | `POINTS` | At most 32 characters |
| Points per 100 spent | 1 | Whole number, 0-1000 |
| Value of one point | 1 | 0.01-1000, in the store currency |
| Fewest points to redeem | 50 | Whole number, 1-1,000,000 |

## How it works

- **Earning** (`order.paid`). A guest order earns nothing. An account order earns `points_per_100` per 100 of its total, rounded down. The app writes a ledger entry and the new balance in one `ctx.storage.batch`. The entry must not exist yet. The balance must still be at the revision the app read. A redelivered event finds the entry and changes nothing. A racing credit or spend is re-read and retried up to 8 times, then the platform retries the event.
- **Spending** (`checkout.discounts`). The buyer must be signed in, hold a balance and enter the code (compared without case). The function receives the balance as `snapshot`. It spends the smaller of the balance and the points the items are worth, and offers nothing below the fewest points to redeem. It answers with a fixed-amount order discount and a `commit` of the reduced balance. The platform writes that balance in the order's own commit batch at the snapshot's revision. If the balance changed after the quote, the order is refused with `APP_OFFER_CHANGED` and the buyer reviews it. Points are never spent twice.

Refunds and cancellations do not return points. The ledger keeps what each order earned. The app has no screen to adjust a balance.

Run the tests from the repository root: `pnpm exec vitest run plugins/loyalty`.
