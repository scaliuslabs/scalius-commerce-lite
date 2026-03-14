// packages/core/src/providers/email/index.ts
// Barrel exports for email providers.

export type {
  EmailProvider,
  SendEmailOptions,
  SendEmailResult,
} from "./types";

// Import adapter to ensure it registers with the universal registry
import "./resend-adapter";
