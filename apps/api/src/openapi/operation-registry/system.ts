// Agent operation registry rows for the system (auth, setup, agent auth, continuations) routes.
import type { OperationRegistryEntry } from "./entry";

export const SYSTEM_OPERATIONS = {
  "system.agent_artifacts.download": {
    exposure: "excluded",
    principals: ["admin", "visitor", "customer"],
    limits: { request: 16_384 },
    artifact: {
      mediaTypes: [
        "application/json",
        "application/pdf",
        "application/zip",
        "image/jpeg",
        "image/png",
        "image/svg+xml",
        "image/webp",
        "text/csv",
        "text/html",
        "text/plain",
      ],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 16 * 1024 * 1024,
      delivery: "direct-stream",
    },
    reason:
      "Dedicated authenticated one-use artifact transfer; not an operations.execute capability.",
  },
  "system.agent_auth.device_ack": {
    exposure: "device",
    risk: "security",
    idempotency: "supported",
    limits: { response: 16_384 },
  },
  "system.agent_auth.device_start": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
    sensitive: true,
  },
  "system.agent_auth.device_token": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
    sensitive: true,
  },
  "system.agent_auth.revoke": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
  },
  "system.auth_firebase_config.get_firebase_config": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Public Firebase browser and worker bootstrap configuration; not a semantic merchant or storefront action.",
  },
  "system.auth_me.get_me": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Legacy service-JWT claim introspection; agent identity comes from the live agent grant and principal.",
  },
  "system.auth_revoke.revoke": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    idempotency: "supported",
    reason:
      "Legacy service-JWT KV blacklist revocation; use agent credential self-revoke or agent-access grant management.",
  },
  "system.auth_token_stats.get_token_stats": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    reason:
      "Legacy JWT secret and blacklist diagnostics; not merchant-visible functionality or agent authentication state.",
  },
  "system.auth_token.get_token": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    sensitive: true,
    reason:
      "Static X-API-Token exchange that mints a short-lived service JWT; it is infrastructure authentication, not an agent grant or merchant capability, and its bearer output must not enter agent results.",
  },
  "system.meta.get": {
    exposure: "excluded",
    principals: ["internal"],
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Unauthenticated deployment compatibility probe for automation; it carries no merchant capability.",
  },
  "system.setup.get_setup": {
    exposure: "excluded",
    principals: ["internal"],
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Unauthenticated first-deployment readiness probe; setup is complete before an agent grant can exist.",
  },
  "system.setup.setup": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Unauthenticated first-admin credential bootstrap belongs to the setup ceremony and must not accept agent input.",
  },
  "system.storefront_continuations.bootstrap_claim": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    limits: { request: 1_024, response: 8_192 },
    reason:
      "Service-authenticated storefront bridge that consumes a one-time browser bootstrap code and returns only its non-bearer continuation locator.",
  },
  "system.storefront_continuations.customer_auth_send_otp": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.customer_auth_verify_otp": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.get": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.payment_reconcile": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.payment_recovery_send_otp": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.payment_recovery_verify_otp": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.payment_start": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.theme_preview_exchange": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    limits: { request: 65_536, response: 8_192 },
    sensitive: true,
    reason: "Service-authenticated server-only theme preview bearer exchange.",
  },
  "system.storefront_theme_preview.resolve": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    limits: { request: 16_384 },
    reason:
      "Private storefront cookie-bearer resolver; the preview token must never enter agent input or execution.",
  },
} satisfies Record<string, OperationRegistryEntry>;
