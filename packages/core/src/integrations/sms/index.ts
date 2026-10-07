// src/integrations/sms/index.ts
// The SMS port: the merchant's chosen gateway (an app provider), resolved per
// send from the `sms` settings document.

export type { SmsProvider } from "./port";
export {
  getActiveSmsProvider,
  getSmsProviderReadiness,
  getSmsSettings,
  isSmsProviderChoice,
  saveSmsSettings,
  SMS_READINESS_CODE,
} from "./sms-settings";
export type { SmsProviderReadiness, SmsSettingsData, SmsSettingsInput } from "./sms-settings";
