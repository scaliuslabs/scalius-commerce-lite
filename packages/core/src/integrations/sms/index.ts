// src/integrations/sms/index.ts
// The SMS port: the merchant's chosen provider (a built-in gateway or an
// app's), resolved per send from the `sms` settings document.

export {
  BUILT_IN_SMS_PROVIDER_IDS,
  type BuiltInSmsProviderId,
  type SmsProvider,
} from "./port";
export {
  getActiveSmsProvider,
  getSmsProviderReadiness,
  getSmsSettings,
  isSmsProviderChoice,
  saveSmsSettings,
  SMS_READINESS_CODE,
} from "./sms-settings";
export type { SmsProviderReadiness, SmsSettingsData, SmsSettingsInput } from "./sms-settings";
