// src/integrations/sms/index.ts
// Barrel file for SMS provider abstraction.

export type {
  SendSmsOptions,
  SendSmsResult,
  SmsProvider,
  SmsProviderId,
} from "./provider";
export {
  registerSmsProvider,
  getSmsProvider,
  SMS_PROVIDER_IDS,
} from "./provider";

export {
  getActiveSmsProvider,
  getSmsProviderReadiness,
  getSmsSettings,
  saveSmsSettings,
  invalidateSmsCache,
} from "./sms-settings";
export type { SmsProviderReadiness, SmsSettingsData } from "./sms-settings";

// ── Register built-in providers ─────────────────────────────────────
// These are placeholder registrations for type checking / registry enumeration.
// The queue consumer MUST call getActiveSmsProvider(db, encryptionKey) to get
// a provider instantiated with real (decrypted) credentials from the DB.

import { registerSmsProvider } from "./provider";
import { SmsNetBdProvider } from "./providers/smsnetbd";
import { BdBulkSmsProvider } from "./providers/bdbulksms";
import { MimSmsProvider } from "./providers/mimsms";
import { GennetProvider } from "./providers/gennet";

registerSmsProvider("smsnetbd", new SmsNetBdProvider({ apiKey: "" }));
registerSmsProvider(
  "bdbulksms",
  new BdBulkSmsProvider({ token: "" }),
);
registerSmsProvider(
  "mimsms",
  new MimSmsProvider({ userName: "", apiKey: "", senderName: "" }),
);
registerSmsProvider(
  "gennet",
  new GennetProvider({ apiToken: "", baseUrl: "", sid: "" }),
);
