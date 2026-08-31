// src/integrations/sms/index.ts
// Barrel file for SMS provider abstraction.

export type {
  SendSmsOptions,
  SendSmsResult,
  SmsProvider,
  SmsProviderId,
} from "./provider";
export { SMS_PROVIDER_IDS } from "./provider";

export {
  getActiveSmsProvider,
  getSmsProviderReadiness,
  getSmsSettings,
  saveSmsSettings,
} from "./sms-settings";
export type { SmsProviderReadiness, SmsSettingsData } from "./sms-settings";
