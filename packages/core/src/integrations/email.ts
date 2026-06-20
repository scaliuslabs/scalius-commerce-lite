// src/integrations/email.ts
// Re-exports from the email provider module for backward compatibility.

export {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendAdminInviteEmail,
} from "./email/index";

export type {
  SendEmailOptions,
  SendEmailResult,
  EmailProvider,
  EmailRuntimeContext,
  EmailRuntimeSettings,
  CloudflareEmailBinding,
} from "./email/index";

export {
  registerEmailProvider,
  getEmailProvider,
  setActiveEmailProvider,
} from "./email/index";

export {
  CloudflareEmailProvider,
  ResendEmailProvider,
  getEmailProviderReadiness,
  getEmailRuntimeSettings,
  readEmailSetting,
} from "./email/index";
