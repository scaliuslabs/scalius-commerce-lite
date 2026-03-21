# SMS Provider Research

**Domain:** Bangladesh SMS OTP delivery for e-commerce customer authentication
**Researched:** 2026-03-22
**Sources:** Official API docs read directly from temp-doc/sms/ (all 4 providers), existing codebase

---

## Provider Comparison Table

| Criterion | BDBulkSMS (GreenWeb) | MIM SMS | SMS.net.bd | Gennet iSMS |
|-----------|---------------------|---------|------------|-------------|
| Base URL | `https://api.bdbulksms.net/api.php` | `https://api.mimsms.com` | `https://api.sms.net.bd/sendsms` | `<domain>/api/v3/send-sms` |
| Auth method | Token in body/header/URL | Username + API Key in body | API key as query param or body field | `api_token` in JSON body |
| Request method | POST or GET | POST (JSON) or GET (query) | POST (form-data) or GET (query) | POST (JSON) |
| Content-Type | `application/x-www-form-urlencoded` or `application/json` | `application/json` | `multipart/form-data` or query | `application/json` |
| Phone format | `+8801XXXXXXXXX` or `01XXXXXXXXX` or `8801XXXXXXXXX` | `8801XXXXXXXXX` (no `+`) | `8801XXXXXXXXX` or `01X` | `88019XXXXXXXX` (no `+`) |
| Sender ID required | No (uses platform default) | Yes — registered `SenderName` | Optional (`sender_id` param) | Yes — `sid` (provided by Gennet) |
| Transaction type | Not required | Required: `T` (transactional) | Not required | Not required |
| Unique request ID | Not required | Not required | Returns `request_id` | Required — `csms_id` per SMS (unique per day) |
| Balance check | Yes (`g_api.php?balance`) | Yes (POST/GET endpoint) | Yes (`/user/balance/`) | Not documented |
| Response format | JSON array (with `?json`) or text | JSON object | JSON object | JSON object with `smsinfo` array |
| Success indicator | `status: "SENT"` in array item | `statusCode: "200"` | `error: 0` | `status: "SUCCESS"` |
| Error codes | String messages | Numeric codes (208, 216, etc.) | Numeric codes (400–421) | Numeric codes (4001–5000) |
| Unicode/Bengali | Supported (sends as Unicode) | Supported | Supported | Detected automatically (returns `sms_type: "BN"`) |
| Bulk SMS | Yes (comma-separated or JSON array) | Yes (comma-separated numbers) | Yes (comma-separated `to`) | Yes (separate `/bulk` endpoint, 100 MSISDN max) |
| BD-specific | GreenWeb is a BD operator-connected gateway | Registered sender ID required | Optional sender ID | `sid` (brand/masking) assigned by Gennet |
| Demo/test credentials | Yes — token `1234567890123456789` | No | No | No |

---

## Provider 1: BDBulkSMS (GreenWeb) — API Details

**Company:** GreenWeb Bangladesh / BDBulkSMS
**Base URL:** `https://api.bdbulksms.net/api.php`
**Alternative URL (older):** `http://api.greenweb.com.bd/api.php`
**JSON mode:** Append `?json` to URL

### Authentication
Token-based. Tokens are generated from the SMS panel at `https://gwb.li/token`.
Token can be passed in three ways:
1. In the POST body as field `token`
2. In the URL as `?token=YOURTOKEN`
3. In a request header as `token: YOURTOKEN`

Recommended: JSON body with token embedded.

### Send Single SMS — Recommended (JSON)

**URL:** `POST https://api.bdbulksms.net/api.php?json`
**Content-Type:** `application/json`

**Request body:**
```json
{
  "token": "your_token_code",
  "smsdata": [
    {
      "to": "+8801XXXXXXXXX",
      "message": "Your OTP is 123456"
    }
  ]
}
```

**Phone number formats accepted:**
- `+8801XXXXXXXXX` (with country code and +)
- `8801XXXXXXXXX` (with country code, no +)
- `01XXXXXXXXX` (local format)

### Response (JSON mode)

**Success:**
```json
[
  {
    "to": "+8801XXXXXXXXX",
    "message": "Your OTP is 123456",
    "status": "SENT",
    "statusmsg": "SMS Sent Successfully To +8801XXXXXXXXX"
  }
]
```

**Failure:**
```json
[
  {
    "to": "+8801XXXXXXXXX",
    "message": "...",
    "status": "FAILED",
    "statusmsg": "+8801XXXXXXXXX Invalid Number"
  }
]
```

**Success detection:** Check `result[0].status === "SENT"` (for single SMS).

### Alternative (form-encoded, simpler for single SMS)

**URL:** `POST https://api.bdbulksms.net/api.php?json`
**Content-Type:** `application/x-www-form-urlencoded`
**Body fields:** `token`, `to`, `message`

### Balance / Health Check

```
GET https://api.greenweb.com.bd/g_api.php?token=YOURTOKEN&balance&json
```

Response: `{ "balance": "123.00" }` (approximate — actual structure may vary)

### OTP-specific notes
- No sender ID registration required — less friction
- Demo token available for integration testing without real account
- Supports Unicode Bengali in message body
- No `csms_id` or transaction ID requirement — lowest implementation friction

---

## Provider 2: MIM SMS — API Details

**Company:** MiM Digital
**Base URL:** `https://api.mimsms.com`
**Documentation:** `mim.digital`

### Authentication
Username (email) + API Key in every request body. No header-based auth.

**Credentials:**
- `UserName`: The email address used to register
- `Apikey`: Generated from Developer Option in MiM SMS Portal

### Send Single SMS

**URL:** `POST https://api.mimsms.com/api/SmsSending/SMS`
**Content-Type:** `application/json`

**Request body:**
```json
{
  "UserName": "you@example.com",
  "Apikey": "XXXXXXXXXXXXXXXXXXXXXX",
  "MobileNumber": "88018XXXXXXXX",
  "CampaignId": "null",
  "SenderName": "YourSenderID",
  "TransactionType": "T",
  "Message": "Your OTP is 123456. Valid for 5 minutes."
}
```

**Critical fields for OTP:**
- `TransactionType`: Must be `"T"` (Transactional). `"P"` (Promotional) requires regulatory pre-approval. `"D"` (Dynamic) is for multi-recipient with different messages.
- `SenderName`: Must be a registered/approved sender ID — this is a hard requirement.
- `CampaignId`: Set to `"null"` string for transactional SMS.
- `MobileNumber`: No `+` prefix. Format: `8801XXXXXXXXX`

### Response

**Success (HTTP 200):**
```json
{
  "statusCode": "200",
  "status": "Success",
  "trxnId": "1OSY3FSZ7H4IHOU",
  "responseResult": "SMS Send Successfuly"
}
```

**Failure:**
```json
{
  "statusCode": "208",
  "status": "Failed",
  "trxnId": "KC5EBJ9XG0HKJY5_C",
  "responseResult": "Invalid Sender ID"
}
```

**Success detection:** `response.statusCode === "200"` AND `response.status === "Success"`.

### Error Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 401 | Invalid credentials or IP blacklisted |
| 208 | Invalid Sender ID |
| 205 | Invalid message content |
| 206 | Invalid mobile number |
| 209 | SMS too long |
| 216 | Insufficient balance |
| 221 | SMS sending failed |
| 500 | Internal server error |

### Balance Check

**URL:** `POST https://api.mimsms.com/api/SmsSending/balanceCheck`
**Body:** `{ "UserName": "...", "Apikey": "..." }`

Response: `{ "statusCode": "200", "status": "Ok", "responseResult": "999.54" }` (balance is the `responseResult` string)

### OTP-specific notes
- **Sender ID is mandatory** — merchant must register and get approved sender ID before SMS works
- `trxnId` can be used for delivery status lookup
- `TransactionType: "T"` does NOT require campaign pre-approval (unlike `"P"`)
- No `+` prefix on phone numbers
- Admin settings need: `userName`, `apiKey`, `senderName`

---

## Provider 3: SMS.net.bd — API Details

**Company:** SMS.net.bd (BD-based SMS gateway)
**Base URL:** `https://api.sms.net.bd`

### Authentication
Single API key passed as a body field (`api_key`) or query parameter.
Generated from the SMS.net.bd portal.

### Send SMS

**URL:** `POST https://api.sms.net.bd/sendsms`
**Content-Type:** `multipart/form-data` (form fields)

**Request fields:**
```
api_key   = YOUR_API_KEY         (required)
msg       = Your OTP is 123456   (required — URL encode for GET)
to        = 8801800000000        (required — with country code, no +)
sender_id = STORENAME            (optional — if approved sender ID exists)
```

**Phone format:** `8801XXXXXXXXX` or `01XXXXXXXXX`

**cURL example:**
```bash
curl -X POST https://api.sms.net.bd/sendsms \
     -d api_key=YOUR_API_KEY \
     -d msg="Your OTP is 123456. Valid 5 mins." \
     -d to=8801800000000
```

### Response

**Success:**
```json
{
  "error": 0,
  "msg": "Request successfully submitted",
  "data": {
    "request_id": 12345
  }
}
```

**Failure:**
```json
{
  "error": 417,
  "msg": "Insufficient balance",
  "data": null
}
```

**Success detection:** `response.error === 0`

### Error Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 400 | Missing or invalid parameter |
| 403 | Permission denied |
| 405 | Authorization required |
| 410 | Account expired |
| 413 | Invalid Sender ID |
| 414 | Message is empty |
| 415 | Message too long |
| 416 | No valid number found |
| 417 | Insufficient balance |
| 420 | Content blocked |
| 421 | Can only send to registered number (pre-recharge restriction) |

### Delivery Report

Check delivery status of a sent batch:
```
GET https://api.sms.net.bd/report/request/{request_id}/?api_key=YOUR_API_KEY
```

### Balance Check

```
GET https://api.sms.net.bd/user/balance/?api_key=YOUR_API_KEY
```

### OTP-specific notes
- Simplest authentication (single API key)
- `request_id` in response can be stored for delivery tracking
- `sender_id` is optional — easier to get started without one
- Error code 421 affects new accounts before first recharge — will fail OTP in staging
- No transaction type distinction — all SMS treated the same

---

## Provider 4: Gennet iSMS — API Details

**Company:** GenNet Wireless, Arzed Chamber, 13 Mohakhali, Dhaka 1212
**Contact:** info@gennet.com.bd
**API Version:** 3.0.0
**Base URL:** `<domain>/api/v3/` — domain is assigned per account by GenNet (not a public URL)

### Authentication
`api_token` in every JSON request body. Token is provided by GenNet when account is created. Up to 50 alphanumeric characters.

### Send Single SMS

**URL:** `POST <domain>/api/v3/send-sms`
**Content-Type:** `application/json`
**Method:** GET or POST

**Request body:**
```json
{
  "api_token": "1279-98d2bb25-3f7e-49bf-a1e2-5d1a6c6c588f",
  "sid": "STORENAME",
  "msisdn": "88019XXXXXXXX",
  "sms": "Your OTP is 123456. Valid for 5 minutes.",
  "csms_id": "unique-id-per-sms-per-day"
}
```

**Critical fields:**
- `sid`: Brand/masking sender ID — assigned by GenNet, not self-configured
- `csms_id`: Client-side unique reference ID. **Must be unique per day.** Max 20 alphanumeric chars. Use `nanoid(20)` or `Date.now().toString(36)` at generation time.
- `msisdn`: No `+` prefix. Format: `88019XXXXXXXX` (13 digits with country code)

### Response

**Success:**
```json
{
  "status": "SUCCESS",
  "status_code": 200,
  "error_message": "",
  "smsinfo": [
    {
      "sms_status": "SUCCESS",
      "status_message": "Success",
      "msisdn": "88019XXXXXXXX",
      "sms_type": "EN",
      "sms_body": "Your OTP is 123456.",
      "csms_id": "unique-id-here",
      "reference_id": "5da2f0b5ba3a2248110"
    }
  ]
}
```

**Failure:**
```json
{
  "status": "FAILED",
  "status_code": 4001,
  "error_message": "Unauthorized",
  "smsinfo": []
}
```

**Success detection:** `response.status === "SUCCESS"` AND `response.status_code === 200`.

### Error Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 4001 | Invalid API token |
| 4002 | SID not permitted |
| 4003 | IP blacklisted |
| 4004 | Invalid API URL |
| 4005 | Invalid request format / content type |
| 4020 | Invalid CSMS ID |
| 4022 | Required parameter missing |
| 4023 | Duplicate CSMS ID (same day) |
| 4025 | Invalid MSISDN |
| 4026 | Blocked MSISDN |
| 4027 | Message length exceeded |
| 4028 | No SMS succeeded (bulk/dynamic) |
| 4029 | API rate limit exceeded |
| 4030 | Too many MSISDNs per request |
| 4031 | TPS exceeded |
| 5000 | Unknown error |

### Unicode Detection
The API automatically detects Unicode/Bengali content and returns `sms_type: "BN"` for Bengali, `"EN"` for ASCII. No special flag needed to send Bengali.

### OTP-specific notes
- **`sid` is assigned by GenNet** — cannot be self-configured; onboarding required
- **`csms_id` uniqueness per day is mandatory** — duplicate will be rejected with 4023
- Domain URL is account-specific — must be stored as a setting (`gennetBaseUrl`)
- Rate limit (4029/4031) relevant if OTP is requested frequently — implement backoff
- Most structured response of all 4 providers (full `smsinfo` array details)

---

## Common Interface Design

All 4 providers share the same conceptual operation: send a single SMS to a phone number with a text message. The abstraction should be:

```typescript
// packages/core/src/integrations/sms/provider.ts

export interface SendSmsOptions {
  to: string;        // E.164 format: +8801XXXXXXXXX (stored in customers.phone)
  message: string;   // OTP message body (plain text, max ~160 chars ASCII / ~70 Bengali)
}

export interface SendSmsResult {
  success: boolean;
  providerRef?: string;   // Provider-assigned transaction/request/reference ID (for logging)
  rawStatus?: string;     // Raw status string from provider (for debugging)
}

export interface SmsProvider {
  readonly name: string;  // "bdbulksms" | "mimsms" | "smsnetbd" | "gennet"
  sendSms(options: SendSmsOptions): Promise<SendSmsResult>;
  validateConfig(): string | null;  // null = ready, string = error message
}
```

**Phone number normalization:** The `customers.phone` column stores E.164 format (`+8801XXXXXXXXX`). Each provider implementation handles the format stripping/conversion internally:
- BDBulkSMS: accepts `+8801XXXXXXXXX` directly — no stripping needed
- MIM SMS: strip `+` → `8801XXXXXXXXX`
- SMS.net.bd: strip `+` → `8801XXXXXXXXX`
- Gennet: strip `+` → `88019XXXXXXXX` (13 digits)

**Message format for OTP:**
```
Your login code: 123456

Valid for 5 minutes. Do not share.
– [StoreName]
```
Keep under 160 characters for ASCII. Bengali OTP messages count ~70 characters per SMS. For OTP, plain ASCII is preferred (no Bengali in the code number itself).

---

## Integration with Existing OTP Transport

### Current state
- `SmsOtpTransport` in `otp-transport.ts` already exists — it builds the queue payload with `method: "phone"`, `allowedMethod` not `"whatsapp_otp"`
- Queue consumer has a stub at the `else` branch that logs "SMS OTP requested... Provider logic pending"
- `authVerificationMethod` in site_settings already has `"sms_otp"` in its enum
- The OTP payload type is `OtpQueuePayload` — it does NOT currently carry SMS provider credentials

### What changes

**Step 1 — OTP queue payload needs SMS provider config.**

The queue consumer needs to know which SMS provider to use and its credentials at dispatch time (like WhatsApp passes `waToken`/`waPhoneId`). The payload must carry these at enqueue time because `env.*` secrets are not available inside the queue consumer's DB lookup path.

Options:
1. Pass provider name + credentials in `OtpQueuePayload` (like WhatsApp does with `waToken`/`waPhoneId`)
2. Fetch settings from D1 inside queue consumer at dispatch time

**Recommendation: option 2.** The queue consumer already has `db` access. Fetching the active SMS provider settings from the `settings` table at dispatch time is cleaner than bloating the queue payload with rotating credentials. The WhatsApp approach was a workaround because WhatsApp tokens come from `siteSettings` (always loaded). SMS provider config will live in the `settings` KV table under category `sms`.

**Step 2 — SmsOtpTransport.validateConfig() should check DB settings.**

Currently returns `null` always. After the registry exists, it should check that an SMS provider is configured. However, `validateConfig` only receives `SiteSettings` (site-wide settings), not the `settings` KV table. Two options:
1. Change signature to also accept `db` parameter
2. Leave validateConfig as-is and let the queue consumer emit an error if no provider is configured

**Recommendation:** Leave the transport interface unchanged. The queue consumer will emit a structured error if no SMS provider is configured, which surfaces in logs and (eventually) a DLQ.

**Step 3 — Queue consumer SMS dispatch.**

The `else` stub becomes:

```typescript
} else if (payload.method === "phone") {
  // SMS OTP
  const provider = await getActiveSmsProvider(db, env.ENCRYPTION_KEY);
  if (!provider) {
    throw new Error("SMS OTP requested but no SMS provider is configured");
  }
  const result = await provider.sendSms({
    to: payload.identifier,  // already E.164 from customers.phone
    message: `Your login code: ${payload.code}\n\nValid for 5 minutes. Do not share.`,
  });
  if (!result.success) {
    throw new Error(`SMS OTP failed (${provider.name}): ${result.rawStatus}`);
  }
  console.log(`[Queue] SMS OTP sent via ${provider.name} to ${payload.identifier}, ref=${result.providerRef}`);
}
```

**Step 4 — Provider registry.**

Follow the email provider pattern (`packages/core/src/integrations/email/provider.ts`):

```typescript
// packages/core/src/integrations/sms/provider.ts
// (interface definition — see Common Interface Design above)

const providers = new Map<string, SmsProvider>();

export function registerSmsProvider(name: string, provider: SmsProvider): void {
  providers.set(name, provider);
}

export function getSmsProvider(name: string): SmsProvider | undefined {
  return providers.get(name);
}
```

Provider implementations live in:
```
packages/core/src/integrations/sms/providers/
  bdbulksms.ts
  mimsms.ts
  smsnetbd.ts
  gennet.ts
```

**Step 5 — Active provider resolution.**

```typescript
// packages/core/src/integrations/sms/active-provider.ts
export async function getActiveSmsProvider(
  db: Database,
  encryptionKey?: string
): Promise<SmsProvider | null> {
  // 1. Read active provider name from settings table (category: "sms", key: "active_provider")
  // 2. Read provider-specific credentials (encrypted) from settings table
  // 3. Instantiate and return the provider
}
```

---

## Admin Settings Schema

### Settings table entries (category: `"sms"`)

| key | value | encrypted |
|-----|-------|-----------|
| `active_provider` | `"bdbulksms"` \| `"mimsms"` \| `"smsnetbd"` \| `"gennet"` | No |
| `bdbulksms_token` | `"your-token-here"` | Yes (AES-GCM, same as delivery credentials) |
| `mimsms_username` | `"you@example.com"` | No |
| `mimsms_api_key` | `"XXXXXXXX"` | Yes |
| `mimsms_sender_name` | `"STORENAME"` | No |
| `smsnetbd_api_key` | `"XXXXXXXX"` | Yes |
| `smsnetbd_sender_id` | `"STORENAME"` | No (optional) |
| `gennet_api_token` | `"1279-98d2bb25-..."` | Yes |
| `gennet_base_url` | `"https://yoursubdomain.gennet.com.bd"` | No |
| `gennet_sid` | `"STORENAME"` | No |

### Admin UI fields per provider

**BDBulkSMS:**
- Token (required, password input, encrypted) — generated at `https://gwb.li/token`

**MIM SMS:**
- Username/Email (required)
- API Key (required, encrypted)
- Sender Name (required — must be pre-registered with MIM SMS)

**SMS.net.bd:**
- API Key (required, encrypted)
- Sender ID (optional — leave blank to use platform default)

**Gennet iSMS:**
- API Token (required, encrypted) — provided by GenNet on account creation
- Base URL (required) — account-specific domain provided by GenNet
- SID (required) — brand/masking name assigned by GenNet

### siteSettings changes

The `authVerificationMethod` enum already includes `"sms_otp"` — no schema change needed.
The admin UI for system settings needs to show the SMS provider selector when `authVerificationMethod` is `"sms_otp"`.

---

## BD-Specific Considerations

### Sender ID / Masking

In Bangladesh, all major operators (Grameenphone, Banglalink, Robi, Teletalk) enforce sender ID masking rules through BTRC (Bangladesh Telecommunication Regulatory Commission). For **transactional OTP SMS**, the route is:

- **Non-masking (numeric sender):** Fastest to activate, no registration. OTP will show from a numeric short code (e.g., `8801XXXXXXXX`). Works with BDBulkSMS and SMS.net.bd without sender ID.
- **Masked sender (alphabetic):** e.g., `SCALIUS` or `STORENAME`. Requires BTRC approval and gateway registration. Required by MIM SMS. Optional for SMS.net.bd. Provided by GenNet.

For OTP delivery specifically, **non-masking is sufficient and faster to set up.** Masked sender IDs add branding but require regulatory approval that can take weeks.

### Phone number format

All BD numbers follow the pattern: `880` + operator code + 8 digits = 13 digits total.

Operator prefixes:
- Grameenphone (GP): `017`, `013`
- Banglalink: `019`, `014`
- Robi: `018`
- Airtel: `016`
- Teletalk: `015`

The customers table stores E.164 (`+8801XXXXXXXXX`). Strip the `+` for most providers, keep it for BDBulkSMS.

---

## Recommendations

### Provider ranking for implementation priority

**1. SMS.net.bd — Start here.**
- Lowest friction: single API key, no sender ID required, simplest request format (form-data POST)
- Error code 0 = success is unambiguous
- `request_id` in response enables delivery tracking later
- Best for getting OTP working quickly without waiting for sender ID approval

**2. BDBulkSMS — Second.**
- GreenWeb is a well-established BD operator (also powers the legacy API at greenweb.com.bd)
- Demo token for integration testing without a real account — unique advantage
- JSON format 1 (token in body, `smsdata` array) is cleanest for TypeScript
- No sender ID requirement

**3. MIM SMS — Third.**
- Requires registered sender name — extra onboarding step
- `TransactionType: "T"` distinction is important and must be set correctly
- Response structure is clean and consistent

**4. Gennet iSMS — Fourth.**
- Most complex: account-specific domain URL, mandatory `csms_id` per SMS per day, SID assigned by GenNet
- `csms_id` uniqueness constraint is a real gotcha — duplicate requests on retry will be rejected with 4023
- Best response detail (full `smsinfo` array with reference IDs) but highest setup friction
- `csms_id` should use `nanoid(20)` to guarantee uniqueness

### Implementation strategy

**Phase: implement all 4 providers but expose only 1-2 in UI initially.**

The provider registry pattern means all 4 can be registered from the start. The admin UI only needs to show providers the merchant has credentials for. Start by implementing SMS.net.bd and BDBulkSMS (no sender ID requirement, faster merchant onboarding), then add MIM SMS and Gennet.

### Error handling

| Scenario | Handling |
|----------|---------|
| No provider configured | Throw — let queue DLQ catch it, surface in admin logs |
| Provider HTTP error (5xx) | Throw — queue will retry (up to queue retry limit) |
| Invalid credentials (auth error) | Log and throw — retrying won't help; alert needed |
| Insufficient balance | Log with structured message — retrying won't help |
| Invalid phone number | Log and swallow — don't retry; the number is bad |
| Rate limit exceeded | Throw — queue retry with backoff will naturally resolve |

For Gennet specifically: duplicate `csms_id` (4023) means the SMS was already sent — treat as success, don't retry.

### OTP message format

Keep ASCII-only for maximum compatibility and lower character count:
```
Your login code: 123456

Valid for 5 minutes. Do not share.
```
Total: 61 characters — well within single SMS limits for all providers.

If the store name is included: keep total under 160 chars to stay within one SMS unit.

### Credential storage

Use `upsertEncryptedSetting` (already in `packages/core/src/modules/payments/gateway-settings.ts`) for API keys/tokens. Non-sensitive fields (sender names, base URLs, usernames) use plain `upsertSetting`. Follow the same pattern as delivery provider credential encryption (AES-GCM).

---

## Gaps / Open Questions

1. **Gennet base URL:** The API doc says `<domain>/api/v3/send-sms` but does not specify the domain structure. The admin must input the full base URL. Confirm with a Gennet account holder.

2. **Rate limits:** Only Gennet documents rate limits explicitly (4029/4031). BDBulkSMS, MIM SMS, and SMS.net.bd do not state rate limits in their docs. For OTP use cases (1 SMS per user per 5 minutes), rate limits are unlikely to be an issue, but this is LOW confidence without official documentation.

3. **Delivery receipts / DLR callbacks:** None of the 4 providers were set up with webhook/DLR callback documentation in the provided docs. For OTP, delivery confirmation is not strictly required (OTP timeout handles failed delivery), but it's worth noting that Gennet's `reference_id` and SMS.net.bd's `request_id` enable polling for delivery status.

4. **Pricing:** No pricing data was available in the API docs. BD SMS pricing typically ranges from BDT 0.20–0.50 per SMS for transactional. Merchants should check provider portals directly.

5. **IP whitelisting:** BDBulkSMS (GreenWeb) and Gennet both mention IP blacklisting in their error codes. Cloudflare Workers use dynamic IP ranges — check if providers require IP whitelisting (which would be incompatible with Workers). If so, routing through a fixed IP proxy would be needed. This is a potential blocker for Gennet (4003 error code explicitly for client IP blacklisted) and BDBulkSMS. **Flag for validation before implementation.**
