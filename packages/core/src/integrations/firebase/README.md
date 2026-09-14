# Firebase (FCM Push Notifications)

Firebase Cloud Messaging integration for sending push notifications to admin dashboard browsers. Replaces the `firebase-admin` Node.js SDK with direct REST API calls compatible with Cloudflare Workers.

## Connection Status

| Component | Status |
|-----------|--------|
| `admin.ts` -- Server-side FCM REST API client | Fully implemented |
| `client.ts` -- Browser-side Firebase SDK init + token registration | Fully implemented |
| Service worker for background notifications | Fully implemented |
| FCM token registration API endpoint | Fully implemented |
| FCM token storage in DB (`adminFcmTokens` table) | Fully implemented |
| Admin settings UI for Firebase config | Fully implemented |
| Calling `sendOrderNotification()` on new orders | Connected via queue consumer |

### What Works

If Firebase is configured (service account JSON + public config + VAPID key in settings DB), the admin dashboard will:
1. Lazy-load Firebase client SDK via `requestIdleCallback` (3s timeout fallback)
2. Request browser notification permission
3. Obtain an FCM token and register it via `POST /api/v1/admin/fcm-token`
4. Listen for foreground messages and show custom toast notifications with sound (`/alert.mp3`)
5. Register a service worker (`firebase-messaging-sw.js`) for background notifications

The queue consumer calls `sendOrderNotification()` on new orders, which sends FCM push to all registered admin tokens.

## Files

### `admin.ts` -- Server-Side FCM REST API

A custom FCM implementation for Cloudflare Workers (no Node.js `firebase-admin` SDK). Handles:

- **JWT creation**: Builds RS256 JWTs using Web Crypto API (`crypto.subtle`) for Google OAuth2 token exchange
- **OAuth2 token management**: Exchanges JWT for Google access token via `https://oauth2.googleapis.com/token`. Uses per-instance memory for the current token and writes to `SHARED_AUTH_CACHE` only when `CREDENTIAL_ENCRYPTION_KEY` is present; persisted values are `enc:` AES-GCM strings with a 3300s TTL. Legacy plaintext KV reads remain tolerated when the dedicated key is available, but new writes never persist raw bearer tokens.
- **FCM v1 API**: Sends messages via `https://fcm.googleapis.com/v1/projects/{projectId}/messages:send`
- **Bounded fanout**: Sends one FCM v1 request per token with bounded concurrency. `FCM_SEND_CONCURRENCY` is a fixed constant (8) exported from `admin.ts` -- not a merchant setting or environment variable. Response order is preserved so invalid-token cleanup can safely map responses back to the original token list.
- **Retry logic**: Up to 3 retries for 429/5xx errors with exponential backoff + Web Crypto jitter. Respects `Retry-After` header.
- **PEM parsing**: Converts PEM private key to ArrayBuffer for Web Crypto, handles formatting issues from env vars (leading/trailing quotes, literal newlines)

#### Interfaces

```typescript
interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}
```

```typescript
interface FCMMessage {
  notification?: { title?: string; body?: string; image?: string };
  data?: { [key: string]: string };
  webpush?: { fcmOptions?: { link?: string }; notification?: { badge?: string } };
  token: string;
}
```

Key exports:
- `FCMMessagingService` -- Class with `sendEachForMulticast(payload)` method. Sends with bounded concurrency and maps error codes to `messaging/*` format (e.g., `UNREGISTERED` -> `messaging/registration-token-not-registered`). All catch blocks use typed `error: unknown`.
- `getFirebaseAdminMessaging(env, serviceAccountJson?)` -- Factory function; always constructs a fresh `FCMMessagingService` for the call (cheap; the encrypted OAuth access token is shared safely through the request's KV binding instead). Throws `ServiceUnavailableError` if `serviceAccountJson` is missing or empty -- there is no other credential source.
- `settings.ts` -- `readFirebaseServiceAccountJson(db, encryptionKey?)` reads the encrypted `firebase`/`service_account` row, decrypts `enc:` values, tolerates legacy plaintext rows on read, and returns `undefined` (never throws) when the row is missing or unusable so callers can report readiness instead of crashing. `getFirebaseServiceAccountReadiness(db, encryptionKey?)` is the merchant-facing check used before enabling admin push.

The service account has exactly one source: the encrypted `firebase`/`service_account` row saved from the dashboard (Settings -> Notifications -> Push setup, `FirebaseSettingsForm.tsx`). There is no environment-variable fallback; `FIREBASE_SERVICE_ACCOUNT_CRED_JSON` does not exist in code.

Required fields in service account JSON: `client_email`, `private_key`, `project_id`.

### `client.ts` -- Browser-Side Firebase Client

Runs in the admin dashboard browser. Uses the Firebase app and messaging packages.

- `initFirebaseClientNotifications(userId, config)` -- Entry point called from `FirebaseInit.astro`
  1. Checks browser environment and notification support
  2. Sets VAPID key from config (`config.vapidKey`)
  3. Initializes Firebase app and messaging
  4. Requests notification permission, obtains FCM token via `getToken()`
  5. Sends token to server via `POST /api/v1/admin/fcm-token` with device info (browser, user agent, URL)
  6. Sets up foreground message listener

- Foreground message handler:
  - Plays `/alert.mp3` audio alert
  - Shows a custom toast notification (not Sonner -- uses hand-built DOM elements with CSS classes `custom-fcm-toast-*`)
  - Toast includes order info, "View Order" link, and close button
  - Dispatches `admin-notification` custom event on `window` for the notification dropdown
  - All catch blocks use typed `error: unknown`

## Admin Dashboard Integration

### `getFirebaseConfig()` (`apps/admin-v2/src/lib/api-functions/firebase.ts`)

A TanStack server function that fetches the public Firebase config from
`GET /api/v1/auth/firebase-config` and normalizes it to `Record<string, string>`.
No env-var default or merge: an unset field is simply absent from the result.
`initFirebaseClientNotifications()` (`@scalius/core/integrations/firebase/client`)
is the browser-side entry point this config is meant for, but no current
admin-v2 route wires it up -- confirm before documenting admin push as active
end to end.

### `/firebase-messaging-sw.js` (`apps/admin-v2/src/routes/firebase-messaging-sw[.]js.tsx`)

Generates a dynamic service worker at `/firebase-messaging-sw.js`:
1. Reads the public Firebase config through `fetchApi()` (the `API` service binding in production, local HTTP in `vite dev`) from `GET /api/v1/auth/firebase-config`. There is no environment-variable fallback or default config.
2. If `apiKey` is missing (unconfigured or the read failed), returns a no-op service worker that logs a warning instead of a broken one.
3. Otherwise outputs a script that imports the Firebase compat SDK (v9.15.0) and initializes messaging.
4. Handles `onBackgroundMessage`: Shows browser notification with order details, "View Order" link, and custom icon.
5. Handles `notificationclick`: Focuses existing admin tab or opens new window to the order URL.

## API Endpoints

### `GET /api/v1/auth/firebase-config`
Returns public Firebase config from DB settings table (category `firebase`, key `public_config`). Used by both the client init and the service worker.

### `POST /api/v1/admin/fcm-token`
Registers an FCM token for push notifications. Validates user ownership. Upserts into `adminFcmTokens` table (conflict on unique `token` column).

### `POST /api/v1/admin/fcm-token-cleanup`
Deactivates invalid tokens and tokens unused for 30+ days.

### `GET /api/v1/admin/settings/firebase`
Returns Firebase config status: masked service account presence and public config object.

### `POST /api/v1/admin/settings/firebase`
Saves service account JSON and/or public config. Non-empty service-account saves require `CREDENTIAL_ENCRYPTION_KEY`, validate `client_email`, `private_key`, and `project_id`, then store an encrypted `enc:` value. Masked service-account values are skipped; empty values clear the stored credential. Invalidates `layoutCache` for `FIREBASE_CONFIG` key.

## Database

`adminFcmTokens` table (`packages/database/src/schema/system.ts`):
- `id` (text, PK)
- `userId` (text, not null)
- `token` (text, not null, unique)
- `deviceInfo` (text, nullable) -- JSON string with browser, user agent, URL, timestamp
- `isActive` (boolean, default true)
- `lastUsed` (timestamp)
- `createdAt` / `updatedAt` (timestamps)

Firebase settings in `settings` table:
- `service_account` (category `firebase`) -- Encrypted `enc:` AES-GCM service account JSON for new writes; legacy plaintext rows remain read-compatible only
- `public_config` (category `firebase`) -- JSON with apiKey, authDomain, projectId, etc.

## Dependencies

- `@firebase/app`, `@firebase/messaging` -- Client-side SDK (imported dynamically in browser)
- Web Crypto API (`crypto.subtle`) -- JWT signing on server (available in Cloudflare Workers)
- `SHARED_AUTH_CACHE` KV namespace -- Optional, for encrypted Google OAuth token caching when `CREDENTIAL_ENCRYPTION_KEY` is configured

## Operations

- `FCM_SEND_CONCURRENCY` (fanout of 8) is a fixed constant in `admin.ts`, not a merchant setting or environment variable. Changing it requires a code change and redeploy.
- The FCM OAuth access-token KV cache key is prefixed with the fixed literal `scalius:` (`FCM_TOKEN_CACHE_PREFIX` in `admin.ts`) rather than a configurable/environment prefix -- this deployment owns exactly one KV namespace per environment, so there is nothing to disambiguate.
- Current admin browser push is Firebase FCM only. A first-party Web Push provider remains the Cloudflare-native fallback target; do not describe admin push as Cloudflare-native until that exists.
