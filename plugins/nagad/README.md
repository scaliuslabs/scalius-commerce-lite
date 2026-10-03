# Nagad (`scalius.nagad`)

> [!WARNING]
> **UNVERIFIED.** This app was built from Nagad's published Online Payment API
> documentation **without access to a Nagad sandbox**. Its HTTP calls and its
> cryptography are tested only against a mock Nagad server that follows the
> documentation. Before you take real payments with it, verify it end to end
> with a live Nagad merchant account: a small real payment, a cancelled
> payment and a failed one (see [What to verify](#what-to-verify)).

Nagad online checkout as a hosted payment provider: the buyer chooses Nagad
at checkout, pays on Nagad's page and comes back to the store. Scalius never
trusts what the return URL says; it asks Nagad's Verify Payment API.

## Merchant setup

1. **Get a Nagad merchant account** with online payment (e-commerce) enabled.
   Nagad gives you a **merchant ID** and your **merchant wallet number**.
2. **Create an RSA key pair** (2048 bits or more) and keep the private key
   secret:

   ```sh
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out merchant-private.pem
   openssl pkey -in merchant-private.pem -pubout -out merchant-public.pem
   ```

   Register `merchant-public.pem` with Nagad. Nagad gives you **its public
   key** in return.
3. In the Scalius dashboard, open the settings of the **Nagad (unverified)**
   app and fill in:

   | Setting | What to enter |
   | --- | --- |
   | Environment | `Sandbox (test)` or `Live` |
   | Merchant ID | The merchant ID from Nagad |
   | Merchant number | Optional: your merchant wallet number (`01XXXXXXXXX`), sent as `accountNumber` |
   | Merchant private key | The contents of `merchant-private.pem` (PKCS#8, `-----BEGIN PRIVATE KEY-----`). Stored encrypted. |
   | Nagad public key | The key Nagad gave you (`-----BEGIN PUBLIC KEY-----`, or the bare base64 text) |
   | Server IP sent to Nagad | Sent as `X-KM-IP-V4`. Use the IP Nagad whitelisted for you, if it asked for one; default `127.0.0.1`. |

   A key in PKCS#1 form (`BEGIN RSA PRIVATE KEY`) is refused with the
   `openssl` command that converts it.
4. **Test connection** checks the settings locally: the merchant ID, that both
   keys parse as RSA keys of at least 2048 bits, and that the Nagad key is not
   your own public key. Nagad has no test call, so it **cannot** prove that
   Nagad accepts your keys: only a real payment does.
5. Turn Nagad on in **Settings → Payments**.

You do not configure a callback URL at Nagad: Scalius sends one with every
payment (`merchantCallbackURL`), pointing at the store's API.

## Environments

| Environment | Base URL |
| --- | --- |
| Live | `https://api.mynagad.com/api/dfs` |
| Sandbox | `https://sandbox-ssl.mynagad.com:10061/remote-payment-gateway-1.0/api/dfs` |

Nagad's older sandbox (`http://sandbox.mynagad.com:10080/...`) is plain HTTP,
and apps may only call `https` hosts, so it cannot be used. The TLS sandbox
listens on port 10061, so the manifest's `allowedHosts` names that exact
`sandbox-ssl.mynagad.com:10061` entry; no other port on that host is reachable.

## How a payment works

1. **Initialize** (`POST /check-out/initialize/{merchantId}/{orderId}`): Scalius
   sends `{merchantId, datetime, orderId, challenge}` encrypted with Nagad's
   public key (RSA PKCS#1 v1.5) and signed with your private key
   (SHA256withRSA). Nagad answers with `{paymentReferenceId, challenge,
   acceptDateTime}` encrypted to your key and signed with its own; Scalius
   decrypts it, checks Nagad's signature and checks that the challenge is the
   one it sent.
2. **Complete** (`POST /check-out/complete/{paymentReferenceId}`): Scalius
   sends the amount (BDT, currency code `050`) and the return URL, sealed the
   same way. Nagad answers with the page the buyer pays on.
3. **Return**: Nagad sends the buyer back with `payment_ref_id`, `status` and
   other parameters. Scalius ignores everything but the reference and calls
   **Verify Payment** (`GET /verify/payment/{paymentRefId}`). Only Nagad's own
   answer, matched against the order id, merchant and amount Scalius created,
   confirms, cancels or fails the payment.
4. **Status checks**: when a buyer asks whether a payment went through, or
   Scalius reconciles one, it calls Verify Payment the same way.

Nagad's order id is derived from the checkout attempt (20 hex characters), so
a retried checkout gets the same Nagad page instead of a second payment. When
Nagad closes a payment (cancelled, aborted, failed, or refused), the buyer's
next try starts a new Nagad order.

Nagad's `Success` is a capture. `Aborted` and `Cancelled` release the checkout
attempt as cancelled; `Failed`, `Fraud`, `InvalidRequest`, `UnKnownFailed` and
`Expired` release it as failed. Any other status (`Ready`, `OrderInitiated`,
`InProgress`, …) is not final and changes nothing.

## Refunds

Nagad's public documentation gives no reliable refund API for this flow, so
the app does not refund. Refund the payment in the **Nagad merchant portal**
(the event's secondary reference is Nagad's `issuerPaymentRefNo`, the
transaction id the portal shows), then record the refund manually on the
order in Scalius.

## What is not done, and why

- **Webhooks**: Nagad's public flow has no merchant webhook. `verifyWebhook`
  answers `ignored`; payments are verified when the buyer returns and when
  Scalius asks Nagad.
- **Refunds**: see above.
- **Amount limits**: Nagad's per-transaction limits are not documented
  reliably, so none are declared; Nagad refuses an amount it does not allow
  (`declined`).
- **Sandbox testing**: no sandbox access, hence "unverified".

## What to verify

With a live merchant account, before production:

- Initialize answers decrypt and verify, and **echo the challenge Scalius
  sent**. Some integrations treat the answer's `challenge` as one Nagad
  generates; if so, initialize fails with `nagad.challenge_mismatch` and the
  echo check in `src/nagad.ts` (`initializePayment`) must be removed (complete
  already signs the challenge from Nagad's answer).
- The page Nagad returns is `https`, and the buyer comes back to the store with
  `payment_ref_id` in the query string. Scalius's return URL already has query
  parameters (`order_id`, `payment_type`); check that Nagad appends its own
  with `&`, and note that Nagad also sends an `order_id` (its own order id).
- Verify Payment's `status` values (`Success`, `Aborted`, `Cancelled`,
  `Failed`, …), its `amount` format, and that `issuerPaymentRefNo` is present
  on a capture.
- How Nagad reports refusals (`reason`/`message` fields, HTTP status): the app
  treats 401/403 and signature or merchant errors as misconfiguration and
  everything else as a decline.

## Development

```sh
pnpm exec vitest run plugins/nagad      # from the repository root
```

`src/rsa.ts` implements PKCS#1 v1.5 encryption with BigInt (Web Crypto has
none, and the sandbox has no `node:crypto`); its tests decrypt a ciphertext
produced by OpenSSL. `src/mock-nagad.ts` is a test-only Nagad server that
decrypts and signature-checks every request and seals its answers.
