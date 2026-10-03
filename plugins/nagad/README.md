# Nagad (`scalius.nagad`)

> [!WARNING]
> **UNVERIFIED.** Built from Nagad's published Online Payment API documentation **without access to a Nagad sandbox**. The tests use only a mock Nagad server (`src/mock-nagad.ts`) that follows that documentation. Every statement about Nagad's side below is unverified. Before real payments, verify the app with a live merchant account: a small real payment, a cancelled one and a failed one (see [What to verify](#what-to-verify)).

A first-party hosted payment provider (`scalius.nagad:nagad`) for Nagad online checkout, built on the public plugin contract (`packages/plugin-sdk/README.md`). It is for merchants and contributors. The buyer pays on Nagad's page and returns to the store. The app never trusts the return URL: it asks Nagad's Verify Payment API.

## Set it up

1. Get a Nagad merchant account with online payment enabled and a merchant ID.
2. Create an RSA key pair of 2048 bits or more. Register the public key with Nagad. Keep the public key that Nagad gives you.

   ```sh
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out merchant-private.pem
   openssl pkey -in merchant-private.pem -pubout -out merchant-public.pem
   ```

3. Open **Apps**, then **Nagad (unverified)**. Fill in the settings and save.

   | Setting | What to enter |
   | --- | --- |
   | Environment | `Sandbox (test)` (default) or `Live`. |
   | Merchant ID | Required. Letters and digits, at most 40. |
   | Merchant number | Optional wallet number (`01XXXXXXXXX`, with or without `+88`). Sent as `accountNumber`. |
   | Merchant private key | Required, stored encrypted. The contents of `merchant-private.pem` (PKCS#8, `BEGIN PRIVATE KEY`). A PKCS#1 key is refused with the `openssl` command that converts it. |
   | Nagad public key | Required. The key Nagad gave you (`BEGIN PUBLIC KEY` or bare base64). |
   | Server IP sent to Nagad | IPv4, default `127.0.0.1`. Sent as `X-KM-IP-V4`. Use the IP Nagad whitelisted for you, if it asked for one. |

4. A Super Admin selects **Review and activate**. The app asks to take payments and to reach the Nagad hosts. It asks for no permission on your store data.
5. Open **Settings → Payments**. Select **Test connection**, then turn Nagad on.

**Test connection** checks the settings locally: merchant ID, merchant number, server IP, that both keys parse as RSA keys of at least 2048 bits, and that the Nagad key is not your own public key. It makes no Nagad call, so only a real payment proves that Nagad accepts your keys.

You configure no callback URL at Nagad. Scalius sends one with every payment (`merchantCallbackURL`).

## How a payment works

Every call sends `X-KM-Api-Version: v-0.2.0` and `X-KM-Client-Type: PC_WEB`. The base URL is `https://api.mynagad.com/api/dfs` (Live) or `https://sandbox-ssl.mynagad.com:10061/remote-payment-gateway-1.0/api/dfs` (Sandbox). Apps may call only `https` hosts, so the manifest's `allowedHosts` names `api.mynagad.com` and the exact `sandbox-ssl.mynagad.com:10061`.

1. **Initialize** (`POST /check-out/initialize/{merchantId}/{orderId}?locale=EN`). The app sends `{merchantId, datetime, orderId, challenge}` encrypted with Nagad's public key (RSA PKCS#1 v1.5) and signed with your private key (SHA256withRSA). Nagad answers `{paymentReferenceId, challenge, ...}` sealed the same way. The app decrypts it, checks Nagad's signature and checks that `challenge` is the one it sent.
2. **Complete** (`POST /check-out/complete/{paymentReferenceId}`). The app sends the amount (BDT, currency code `050`) and the return URL, sealed the same way. Nagad answers with the page the buyer pays on. The page must be `https`.
3. **Return.** Nagad sends the buyer back with `payment_ref_id`. The app looks up only references this store created, so a forged return costs no Nagad call. It then calls **Verify Payment** (`GET /verify/payment/{paymentRefId}`). The answer must match the stored reference, Nagad order id, merchant ID and (for a capture) amount.
4. **Status checks.** When a buyer asks whether a payment went through, or the platform reconciles one, the app calls Verify Payment the same way.

Nagad's order id is the first 20 hex characters of a SHA-256 over the checkout attempt and a generation number. A retried checkout gets the same Nagad page, never a second payment. After Nagad closes a payment, or an initialize call gets no answer, the next try of the attempt starts a new Nagad order (generation + 1).

The app compares Nagad's `status` without case, spaces, `_` and `-`:

- `Success` is a capture. The event id is `issuerPaymentRefNo` (else the reference).
- `Aborted` and `Cancelled` release the checkout attempt as cancelled.
- `Failed`, `Fraud`, `InvalidRequest`, `UnKnownFailed` and `Expired` release it as failed.
- Any other status (`Ready`, `OrderInitiated`, `InProgress`, ...) is not final and changes nothing.

## Refunds, webhooks and limits

- **Refunds.** The app declares no refund operation. Refund in the Nagad merchant portal, then record the refund on the order in Scalius.
- **Webhooks.** `verifyWebhook` answers `ignored`.
- **Amounts.** BDT only. The app declares no amount limits. Nagad refuses an amount it does not allow, and checkout shows `declined`.
- **Time.** `limits.wallMs` is 15,000 ms. A return verification waits at most 8 s.

## What to verify

With a live merchant account, before production:

- Initialize answers decrypt and verify, and **echo the challenge the app sent**. If Nagad generates its own challenge, initialize fails with `nagad.challenge_mismatch`. Then remove the echo check in `initializePayment` (`src/nagad.ts`). Complete already signs the challenge from Nagad's answer.
- The buyer returns with `payment_ref_id` in the query string. Scalius's return URL already has `order_id` and `payment_type`. Check that Nagad appends its own parameters with `&`. Nagad also sends an `order_id` of its own.
- Verify Payment's `status` values, its `amount` format, and `issuerPaymentRefNo` on a capture.
- How Nagad reports refusals. The app treats HTTP 401 and 403, and messages about signature, decryption, `sensitiveData` or merchant state, as misconfiguration. It treats everything else as a decline.

## Development

```sh
pnpm exec vitest run plugins/nagad      # from the repository root
```

`src/nagad.ts` holds the settings checks, the three Nagad calls and the status mapping. `src/index.ts` holds the manifest and the payment records (`ctx.storage.payments`). `src/rsa.ts` implements PKCS#1 v1.5 encryption with BigInt, because Web Crypto has none and the sandbox has no `node:crypto`.
