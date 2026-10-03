# bKash (`scalius.bkash`)

A first-party app that takes bKash payments at checkout through bKash Tokenized Checkout (API `v1.2.0-beta`). It is for merchants who set it up and contributors who change it. The app is a hosted payment provider (`scalius.bkash:bkash`) built only on the public plugin contract (`packages/plugin-sdk/README.md`).

The buyer pays on bKash's page. The order is marked paid only after bKash confirms the payment to the app server to server.

## Set it up

1. Get four values from bKash: app key, app secret, username and password. Use the set for the environment you choose.
2. Open **Apps**, then bKash. Choose the Environment, enter the four values and save. The secret and the password are stored encrypted and never shown again.
   - `sandbox` (default) calls `tokenized.sandbox.bka.sh`. `live` calls `tokenized.pay.bka.sh`. Any other value counts as sandbox.
3. A Super Admin selects **Review and activate**. The app asks to take payments and to reach those two hosts. It asks for no permission on your store data.
4. Open **Settings → Payments**. Select **Test connection** (it asks bKash for one token), then turn bKash on. Checkout offers "bKash" for BDT orders.

You configure no callback URL at bKash. Scalius sends one with every payment.

## How a payment works

1. Checkout commits the order. The app creates one bKash payment (`mode` `0011`, `intent` `sale`). It sends the platform's correlation id as `merchantInvoiceNumber` and the platform's success URL as `callbackURL`. It stores the payment under bKash's `paymentID`. A retry of the same attempt returns that payment.
2. The buyer pays on bKash's page. bKash sends the buyer back with `paymentID` and `status` (`success`, `failure` or `cancel`). The app never trusts `status`. An unknown `paymentID` is `invalid`.
3. On `success` the app calls bKash **Execute**, then **Query Payment** if Execute does not complete the payment. For `failure`, `cancel` or a closed payment it calls Query Payment only.
4. A completed payment confirms only if bKash names the same `paymentID` and invoice number, gives a transaction id, and matches the stored currency and amount. Otherwise the app answers `invalid` and logs it.
5. After a `failure` or `cancel` return, or an Execute that bKash refused, an unpaid payment is reported cancelled or failed and closed. The platform releases the attempt. The app never executes a closed payment. When bKash cannot be reached, is busy or has not completed the payment, the app answers `retry`.
6. If the return is lost, the platform calls `queryPayment`. The same capture gives the same event (type `bkash.payment`, id bKash's `trxID`), so the platform applies it once.

## Refunds

- Refund in full or in part from the order page. Only BDT refunds work.
- The app records each refund under the SHA-256 of the platform's idempotency key before it calls bKash. It sends a refund at most once. A replay returns the stored result or asks bKash.
- A refund that bKash refuses, or that never left, leaves no record and may be sent again.
- If the answer is lost, `refundStatus` asks bKash and matches the refund by `refundTrxID` or by amount on the same transaction. An unmatched refund goes to manual review: check the payment in the bKash merchant portal.

## Credentials

- Secrets are in `ctx.settings` only while an operation runs. The app caches bKash's grant token in `ctx.kv` under a key made from the environment and a hash of the app key and username. It drops the token 5 minutes before bKash expires it.
- Errors and logs carry no credential, token or bKash body. bKash's own message shows only when it has no digits.

## Limits and gaps

- BDT only. The app declares no amount limits. bKash may refuse an amount when it creates the payment, and checkout then shows the payment as declined.
- `limits.wallMs` is 30,000 ms. A return uses at most 25 s and a connection test at most 15 s.
- **Webhooks.** `verifyWebhook` always answers `ignored`.
- **Agreements** (saved wallets) are not implemented: every payment is a one-off checkout.
- **Importing refunds** made in the bKash merchant portal (`listRefunds`) is not implemented.

## Testing

Choose **Sandbox** and enter sandbox credentials.

The tests in `src/index.test.ts` run the app against a simulation of the bKash API. The repository records no run against bKash's sandbox or live system. Treat the flow as verified against bKash's published documentation only.

```sh
pnpm exec vitest run plugins/bkash    # from the repository root
```

Source: `src/index.ts` (manifest, wiring, connection test), `src/payments.ts`, `src/refunds.ts` and `src/client.ts` (bKash calls, credentials, token cache, error mapping).
