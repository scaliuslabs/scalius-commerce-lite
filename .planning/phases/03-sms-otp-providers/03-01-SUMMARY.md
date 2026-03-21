---
phase: 03-sms-otp-providers
plan: 01
subsystem: integrations
tags: [sms, otp, aes-gcm, provider-registry, bangladesh]

# Dependency graph
requires: []
provides:
  - SmsProvider interface and registry (registerSmsProvider, getSmsProvider)
  - 4 BD SMS provider implementations (smsnetbd, bdbulksms, mimsms, gennet)
  - SMS settings service with encrypted credential storage (getSmsSettings, saveSmsSettings)
  - Active provider resolver from DB at dispatch time (getActiveSmsProvider)
  - Barrel file with all public exports
affects: [03-02-PLAN, queue-consumer, admin-settings]

# Tech tracking
tech-stack:
  added: []
  patterns: [sms-provider-registry, encrypted-settings-per-category]

key-files:
  created:
    - packages/core/src/integrations/sms/provider.ts
    - packages/core/src/integrations/sms/providers/smsnetbd.ts
    - packages/core/src/integrations/sms/providers/bdbulksms.ts
    - packages/core/src/integrations/sms/providers/mimsms.ts
    - packages/core/src/integrations/sms/providers/gennet.ts
    - packages/core/src/integrations/sms/sms-settings.ts
    - packages/core/src/integrations/sms/index.ts
  modified: []

key-decisions:
  - "Followed email provider pattern exactly for interface/registry consistency"
  - "Used in-memory credential cache (5min TTL) matching gateway-settings.ts pattern"
  - "getActiveSmsProvider uses dynamic imports for lazy provider instantiation"
  - "Masked secrets use bullet characters to distinguish from empty/missing values"

patterns-established:
  - "SMS provider interface: SmsProvider with sendSms + validateConfig contract"
  - "SMS settings category 'sms' in settings table with encrypted API keys"
  - "getActiveSmsProvider resolves provider from DB at queue dispatch time (not registry)"

requirements-completed: [SMS-04, SMS-05, SMS-07]

# Metrics
duration: 3min
completed: 2026-03-22
---

# Phase 03 Plan 01: SMS Provider Core Summary

**Unified SMS provider interface, registry, 4 BD provider implementations (smsnetbd/bdbulksms/mimsms/gennet), and encrypted settings service with active provider resolver**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-21T22:02:32Z
- **Completed:** 2026-03-21T22:05:34Z
- **Tasks:** 2
- **Files created:** 7

## Accomplishments
- SmsProvider interface with sendSms + validateConfig contract following email provider pattern
- All 4 BD SMS providers implemented with correct API endpoints, request formats, phone number normalization, and response parsing per research doc
- SMS settings service with AES-GCM encrypted credential storage, masked field returns, and in-memory cache
- Active provider resolver that reads settings from DB, decrypts credentials, instantiates the correct provider, and validates config before returning

## Task Commits

Each task was committed atomically:

1. **Task 1: Create SMS provider interface, registry, and all 4 provider implementations** - `92dcccf` (feat)
2. **Task 2: Create SMS settings service, active provider resolver, and barrel file** - `a97ba2e` (feat)

## Files Created/Modified
- `packages/core/src/integrations/sms/provider.ts` - SmsProvider interface, SendSmsOptions/Result types, registry (registerSmsProvider/getSmsProvider), SMS_PROVIDER_IDS
- `packages/core/src/integrations/sms/providers/smsnetbd.ts` - SMS.net.bd provider: form-data POST, strips + from E.164
- `packages/core/src/integrations/sms/providers/bdbulksms.ts` - BDBulkSMS provider: JSON POST, accepts +8801 format directly
- `packages/core/src/integrations/sms/providers/mimsms.ts` - MIM SMS provider: JSON POST with TransactionType T, strips + from E.164
- `packages/core/src/integrations/sms/providers/gennet.ts` - Gennet iSMS provider: JSON POST with csms_id uniqueness, treats 4023 as success
- `packages/core/src/integrations/sms/sms-settings.ts` - Settings service: getSmsSettings (masked), saveSmsSettings (encrypted), getActiveSmsProvider (resolver)
- `packages/core/src/integrations/sms/index.ts` - Barrel file: registers all 4 providers, re-exports public API

## Decisions Made
- Followed email provider pattern exactly for interface/registry to maintain codebase consistency
- Used in-memory credential cache with 5-minute TTL matching gateway-settings.ts pattern (never persist decrypted credentials)
- getActiveSmsProvider uses dynamic imports for lazy provider instantiation with real DB credentials
- Masked secrets use bullet characters (12 dots) to distinguish from empty/missing values in the admin UI
- Barrel file registers providers with empty configs as placeholders; queue consumer must call getActiveSmsProvider for real credentials

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- SMS provider core is complete, ready for Plan 02 (API endpoints, queue consumer wiring, admin UI)
- All 7 files type-check cleanly against packages/core/tsconfig.json
- getActiveSmsProvider is ready to be called by the queue consumer at dispatch time

## Self-Check: PASSED

All 7 files confirmed present. Both commits (92dcccf, a97ba2e) confirmed in git log.

---
*Phase: 03-sms-otp-providers*
*Completed: 2026-03-22*
