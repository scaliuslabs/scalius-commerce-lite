---
phase: 03-sms-otp-providers
plan: 02
subsystem: api, notifications, ui
tags: [sms, otp, hono, openapi, react, settings, encryption, queue]

# Dependency graph
requires:
  - phase: 03-sms-otp-providers
    provides: "SMS provider registry, 4 BD provider implementations, sms-settings service with encrypted credential storage"
provides:
  - "GET/POST /admin/settings/sms API endpoints for SMS provider configuration"
  - "Queue consumer SMS OTP dispatch via active provider (replaces stub)"
  - "Notification service SMS dispatch for order status updates (replaces stub)"
  - "Admin UI SMS provider selector with per-provider credential fields"
affects: [storefront-checkout, customer-auth]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SMS settings endpoint follows system.ts auth route pattern (GET masked, POST skip masked)"
    - "Dynamic imports in notification service to avoid circular dependencies"
    - "try/catch around SMS notification dispatch to never block email delivery"

key-files:
  created:
    - apps/api/src/routes/admin/settings/sms.ts
  modified:
    - apps/api/src/routes/admin/settings.ts
    - apps/api/src/queue-consumer.ts
    - packages/core/src/modules/notifications/notifications.service.ts
    - apps/admin/src/components/admin/settings/AuthSettingsBuilder.tsx

key-decisions:
  - "SMS route uses invalidateSmsCache() on POST to clear in-memory provider cache"
  - "Queue consumer throws on SMS failure to trigger Cloudflare retry (up to max_retries=3)"
  - "Notification service SMS is fire-and-forget with try/catch — never blocks email delivery"
  - "Dynamic import for getActiveSmsProvider in notifications.service.ts avoids circular deps"
  - "SMS card uses blue accent (border-blue-500/20) to distinguish from WhatsApp green"

patterns-established:
  - "SMS settings stored in settings table under category 'sms', accessed via separate /admin/settings/sms endpoint"
  - "Per-provider credential fields shown conditionally in admin UI based on selected provider"

requirements-completed: [SMS-01, SMS-02, SMS-03, SMS-05, SMS-06, SMS-07]

# Metrics
duration: 5min
completed: 2026-03-22
---

# Phase 03 Plan 02: SMS Settings API + Queue/Notification Wiring Summary

**End-to-end SMS delivery path from admin configuration through queue dispatch to actual SMS sending via 4 BD gateway providers**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-21T22:07:51Z
- **Completed:** 2026-03-21T22:13:15Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- API endpoints GET/POST /admin/settings/sms for SMS provider configuration with masked credential responses
- Queue consumer SMS OTP dispatch replaces "provider logic pending" stub with actual provider call
- Notification service SMS dispatch replaces "not yet implemented" stub with order-specific SMS messages
- Admin UI removes "Coming Soon" from SMS OTP, adds provider selector with 4 BD providers and per-provider credential fields

## Task Commits

Each task was committed atomically:

1. **Task 1: Create SMS settings API route, mount it, and wire queue consumer + notification service SMS dispatch** - `563f94e` (feat)
2. **Task 2: Update AuthSettingsBuilder to show SMS provider selector and per-provider credential fields** - `27ec2cb` (feat)

## Files Created/Modified
- `apps/api/src/routes/admin/settings/sms.ts` - GET and POST /sms endpoints using OpenAPIHono with masked credential responses
- `apps/api/src/routes/admin/settings.ts` - Mount smsSettingsRoutes on root path
- `apps/api/src/queue-consumer.ts` - SMS OTP dispatch via getActiveSmsProvider, throws on failure for queue retry
- `packages/core/src/modules/notifications/notifications.service.ts` - SMS order notification dispatch with customerPhone lookup from orders table
- `apps/admin/src/components/admin/settings/AuthSettingsBuilder.tsx` - SMS provider selector, per-provider credential fields, fetch/save SMS settings

## Decisions Made
- Queue consumer throws Error on SMS delivery failure, causing Cloudflare queue retry (up to max_retries=3) -- intentional for OTP where customer is actively waiting
- Notification service SMS wrapped in try/catch and uses dynamic imports to avoid circular deps and never block email delivery
- SMS settings endpoint is separate from auth settings (/admin/settings/sms vs /admin/settings/auth) because SMS credentials are stored encrypted in the settings table (category "sms"), not in siteSettings
- Blue accent card styling for SMS provider config to visually distinguish from WhatsApp green card

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed env reference in queue consumer SMS dispatch**
- **Found during:** Task 1
- **Issue:** Plan template used `c.env` but the processQueueMessage function receives `env` as a parameter, not a Hono context
- **Fix:** Changed `c.env` to `env as unknown as Record<string, unknown>` and added `getEncryptionKey` import
- **Files modified:** apps/api/src/queue-consumer.ts
- **Verification:** pnpm typecheck passes
- **Committed in:** 563f94e (part of Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Essential fix for correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviation above.

## User Setup Required
None - no external service configuration required. Merchants configure SMS providers through the admin UI.

## Next Phase Readiness
- SMS provider infrastructure is complete end-to-end: admin config -> API storage -> queue dispatch -> provider send
- Phase 03 (SMS OTP Providers) is fully complete with both plans delivered
- Ready for Phase 04 (Invoice/Receipt Printing)

---
## Self-Check: PASSED

All 5 files verified present. Both task commits (563f94e, 27ec2cb) confirmed in git log.

---
*Phase: 03-sms-otp-providers*
*Completed: 2026-03-22*
