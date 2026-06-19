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
- **Bounded fanout**: Sends one FCM v1 request per token with bounded concurrency. Default concurrency is 8; optional runtime var `FCM_SEND_CONCURRENCY` is clamped to 1-20. Response order is preserved so invalid-token cleanup can safely map responses back to the original token list.
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
- `getFirebaseAdminMessaging(env, serviceAccountJson?)` -- Factory function. When `serviceAccountJson` is provided (e.g., from DB settings), creates a new instance. Otherwise returns a singleton for env-var credentials.
- `settings.ts` -- `saveFirebaseServiceAccountJson()` validates required service-account fields and writes encrypted `enc:` settings; `readFirebaseServiceAccountJson()` decrypts `enc:` rows, tolerates legacy plaintext/bare AES-GCM rows on read, and returns `undefined` for unreadable ciphertext so runtime falls back to env credentials.

Credential resolution order:
1. `serviceAccountJson` parameter (decrypted from DB `settings` table, category `firebase`, key `service_account`)
2. `FIREBASE_SERVICE_ACCOUNT_CRED_JSON` environment variable

Required fields in service account JSON: `client_email`, `private_key`, `project_id`.

### `client.ts` -- Browser-Side Firebase Client

Runs in the admin dashboard browser. Uses the standard Firebase JS SDK (`firebase/app`, `firebase/messaging`).

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

### `FirebaseInit.astro` (layout component)

Lazy-loads Firebase initialization:
1. Reads `window.__USER_ID__` (set by the admin layout)
2. Fetches Firebase public config from `GET /api/v1/auth/firebase-config`
3. Dynamically imports `initFirebaseClientNotifications` from `@scalius/core/integrations/firebase/client`
4. Deferred via `requestIdleCallback` with 3s timeout fallback

### `firebase-messaging-sw.js.ts` (Astro page -> service worker)

Generates a dynamic service worker at `/firebase-messaging-sw.js`:
1. Fetches Firebase public config from API (with env var fallback)
2. Outputs a script that imports Firebase compat SDK (v9.15.0) and initializes messaging
3. Handles `onBackgroundMessage`: Shows browser notification with order details, "View Order" link, and custom icon
4. Handles `notificationclick`: Focuses existing admin tab or opens new window to order URL

### Layout Loader (`loaders/admin/layout.ts`)

`getAdminLayoutFirebaseConfig()`:
- Fetches public config from `GET /api/v1/auth/firebase-config`
- Merges with default config from env vars
- Caches in in-memory `layoutCache` (invalidated when Firebase settings are saved)

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

- `firebase/app`, `firebase/messaging` -- Client-side SDK (imported dynamically in browser)
- Web Crypto API (`crypto.subtle`) -- JWT signing on server (available in Cloudflare Workers)
- `SHARED_AUTH_CACHE` KV namespace -- Optional, for encrypted Google OAuth token caching when `CREDENTIAL_ENCRYPTION_KEY` is configured

## Operations

- `FCM_SEND_CONCURRENCY` is optional and only affects server fanout. Leave it unset for the default of 8. Lower it if Firebase starts returning 429s for a merchant; raise carefully only for high-admin-device installs.
- Current admin browser push is Firebase FCM only. A first-party Web Push provider remains the Cloudflare-native fallback target; do not describe admin push as Cloudflare-native until that exists.
