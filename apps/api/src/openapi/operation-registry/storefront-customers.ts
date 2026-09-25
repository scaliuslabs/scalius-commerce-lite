// Agent operation registry rows for the storefront customer account routes.
import type { OperationRegistryEntry } from "./entry";

export const STOREFRONT_CUSTOMER_OPERATIONS = {
  "storefront.customer_auth_account_summary.get_account_summary": {
    exposure: "excluded",
    principals: ["customer"],
    reason:
      "Customer-cookie counts that only decide which hosted account tabs show; agents read the underlying records through their own reviewed operations.",
  },
  "storefront.customer_auth_logout.logout": {
    exposure: "excluded",
    principals: ["customer"],
    risk: "security",
    idempotency: "supported",
    reason:
      "Revokes the browser customer-cookie session; use storefront.customer_auth.logout for context-bound customer authority.",
  },
  "storefront.customer_auth_me.get_me": {
    exposure: "excluded",
    principals: ["customer"],
    sensitive: true,
    reason:
      "Legacy customer-cookie PII projection; use the live delegated-authority storefront.customer_profile.get operation.",
  },
  "storefront.customer_auth_phone_send_code.send_code": {
    exposure: "excluded",
    principals: ["customer"],
    risk: "security",
    openWorld: true,
    reason:
      "Browser-only proof of the customer-cookie account's own phone; it dispatches an SMS code, so identifiers and OTPs stay outside agent I/O.",
  },
  "storefront.customer_auth_phone_verify.verify": {
    exposure: "excluded",
    principals: ["customer"],
    risk: "security",
    sensitive: true,
    reason:
      "Accepts a raw OTP, verifies the customer-cookie account's phone and moves orders placed with it; proof must be entered by the buyer in the hosted account page.",
  },
  "storefront.customer_auth_profile.replace_profile": {
    exposure: "excluded",
    principals: ["customer"],
    sensitive: true,
    reason:
      "Cookie-authorized browser profile mutation returning PII; use storefront.customer_profile.update with live delegated authority.",
  },
  "storefront.customer_auth_send_otp.send_otp": {
    exposure: "excluded",
    risk: "security",
    openWorld: true,
    reason:
      "Browser OTP start accepts buyer identifiers and dispatches email or SMS; use storefront.customer_auth.begin and status so identifiers, OTPs, and session material stay outside agent I/O.",
  },
  "storefront.customer_auth_verify_otp.verify_otp": {
    exposure: "excluded",
    risk: "security",
    sensitive: true,
    reason:
      "Accepts a raw OTP and issues the customer session cookie; authentication must complete in the hosted storefront.customer_auth continuation.",
  },
  "storefront.customer_auth.begin": {
    exposure: "continuation",
    risk: "security",
    transport: "continuation",
    limits: { request: 16_384, response: 8_192 },
    sensitive: true,
    continuation: {
      method: "POST",
      urlJsonPointer: "/data/browser/url",
      fieldsJsonPointer: "/data/browser/fields",
      sensitiveFields: ["continuationCode"],
    },
  },
  "storefront.customer_auth.logout": {
    risk: "security",
    revision: "required",
  },
  "storefront.customer_auth.status": { exposure: "continuation" },
  "storefront.customer_profile.get": {},
  "storefront.customer_profile.update": {},
} satisfies Record<string, OperationRegistryEntry>;
