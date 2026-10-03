# Firebase (FCM push)

Firebase Cloud Messaging sends push notifications to admin dashboard browsers. The server calls the FCM HTTP v1 REST API directly with Web Crypto. It does not use the Node.js `firebase-admin` SDK. This document is for contributors and operators. Which events push, and how receipts and pauses work, is in the [notifications README](../../modules/notifications/README.md).

## Flow

1. The merchant opens Settings > Notifications (`/admin/settings/notifications`) > Sending > Push (`PushFields` in `apps/admin-v2/src/components/admin/settings/NotificationSettings.tsx`) and saves the service account JSON and the web app config.
2. A staff member selects "Turn on" in the dashboard notification menu (`NotificationDropdown.tsx`). That calls `useFirebaseInit` (`apps/admin-v2/src/hooks/use-firebase-init.ts`).
3. The hook reads the public config from `GET /api/v1/auth/firebase-config`. It needs `apiKey` and `vapidKey`. Without them the status is `unconfigured`.
4. The hook asks for browser notification permission, loads `@firebase/app` and `@firebase/messaging` on demand and registers the service worker `apps/admin-v2/public/firebase-messaging-sw.js`. The public config travels in the script URL query (without `vapidKey`). The worker scope is the dashboard base path.
5. It gets an FCM token and sends it to `POST /api/v1/admin/fcm-token`.
6. For each notification the API Worker sends one FCM request per active token (`sendOrderNotification()` and the other senders in the notifications domain).
7. In the foreground the dashboard shows a toast, plays `/alert.mp3` and dispatches an `admin-notification` event. In the background the service worker shows the notification.

## Credentials

The `firebase` settings document (`firebaseDocument` in `packages/core/src/modules/settings/documents.ts`):

| Field | Meaning |
|---|---|
| `serviceAccount` | Service account JSON. A secret, encrypted at rest with `CREDENTIAL_ENCRYPTION_KEY`. |
| `publicConfig` | Web app config (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`, `vapidKey`, optional `measurementId`). Not secret. |

- The dashboard is the only source of the service account. There is no environment variable.
- A service account must have non-empty `client_email`, `private_key` and `project_id`. `normalizeFirebaseServiceAccountJson()` rejects anything else.
- `readFirebaseServiceAccountJson()` returns `undefined` for a missing or unusable account. It never throws. Never call FCM with unreadable ciphertext, and never fall back to a JWT secret.
- `getFirebaseServiceAccountReadiness()` returns `missing_firebase_service_account` or `unusable_firebase_service_account`. The notification settings use it before they allow push.

## Server client (`admin.ts`)

- `getFirebaseAdminMessaging(env, serviceAccountJson)` builds a new `FCMMessagingService` per call. It throws `ServiceUnavailableError` when the JSON is empty.
- Auth: an RS256 JWT with scope `https://www.googleapis.com/auth/firebase.messaging`, exchanged at `https://oauth2.googleapis.com/token`.
- Token cache: memory per instance, and KV `CACHE` only when `CREDENTIAL_ENCRYPTION_KEY` is present. The KV value is an `enc:` AES-GCM string with a 3300 s TTL. The key is `scalius:fcm_access_token:<project_id>:<24-hex fingerprint of the service account>`. A rotated private key changes the fingerprint.
- Send: `sendEachForMulticast()` makes one request per token to `https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`. `FCM_SEND_CONCURRENCY` is a fixed 8.
- Retry: up to 3 attempts for HTTP 429 and 5xx. Backoff is `2^attempt` seconds plus up to 1 s of jitter. `Retry-After` overrides it.
- `admin.ts` maps the FCM status to a `messaging/*` error code (for example `UNREGISTERED` -> `messaging/registration-token-not-registered`). Anything unknown becomes `messaging/unknown-error`.

## Routes

| Method and path | Auth |
|---|---|
| `GET /api/v1/auth/firebase-config` (`publicConfig` only) | public |
| `GET /api/v1/admin/settings/firebase` (masked service account, `publicConfig`, `revision`) | `settings.notifications.edit` |
| `POST /api/v1/admin/settings/firebase` (saves both with `expectedRevision`) | `settings.notifications.edit` |
| `POST /api/v1/admin/fcm-token` (registers a token) | any admin session |
| `POST /api/v1/admin/fcm-token-cleanup` (deactivates tokens) | `settings.notifications.edit` |

- A stale `expectedRevision` returns 409.
- A masked service account value is ignored. An empty value clears it. A new value needs `CREDENTIAL_ENCRYPTION_KEY` (503 without it).
- A service account change clears the `push` provider pause markers in the same batch.
- `fcm-token` needs `userId` equal to the session user (403 otherwise). It upserts on the unique `token` and sets `is_active` to true.
- `fcm-token-cleanup` takes 1 to 10 `invalidTokens` and deactivates them. It also deactivates tokens whose `last_used` is empty or older than 30 days.

## Database

Table `admin_fcm_tokens` (`packages/database/src/schema/system.ts`): `user_id`, unique `token`, `device_info` (JSON text), `is_active`, `last_used`.

## Limits

- The service worker loads the Firebase compat SDK 9.15.0 from `gstatic.com`.
- Admin push is Firebase only. There is no first-party Web Push provider. Do not describe admin push as Cloudflare-native.
