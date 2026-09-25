// Agent operation registry rows for the storefront digital-goods routes (Wave B §3.4, §7.1).
// Every buyer route is browser-only: download tickets are bound to the buyer's
// cookie proof, and key reveals return a licence key in the clear.
import type { OperationRegistryEntry } from "./entry";

const cookieBound = "Download tickets and licence keys are bound to the buyer's browser cookie proof and never pass through agent I/O.";

export const STOREFRONT_DIGITAL_OPERATIONS = {
  "storefront.customer_auth_downloads.get_downloads": {
    exposure: "excluded",
    principals: ["customer"],
    reason: `Customer-cookie list of delivered files and masked keys. ${cookieBound}`,
  },
  "storefront.customer_auth_downloads_ticket.ticket": {
    exposure: "excluded",
    principals: ["customer"],
    reason: `Counts a download and mints a ticket bound to the session cookie. ${cookieBound}`,
  },
  "storefront.customer_auth_licence_keys_reveal.reveal": {
    exposure: "excluded",
    principals: ["customer"],
    risk: "security",
    sensitive: true,
    reason: `Returns a plaintext licence key to its owner's browser. ${cookieBound}`,
  },
  "storefront.orders_receipt_downloads.get_downloads": {
    exposure: "excluded",
    sensitive: true,
    reason: `Requires raw receipt proof in the request. ${cookieBound}`,
  },
  "storefront.orders_receipt_downloads_ticket.ticket": {
    exposure: "excluded",
    sensitive: true,
    reason: `Requires raw receipt proof and counts a download. ${cookieBound}`,
  },
  "storefront.orders_receipt_licence_keys_reveal.reveal": {
    exposure: "excluded",
    risk: "security",
    sensitive: true,
    reason: `Requires raw receipt proof and returns a plaintext licence key. ${cookieBound}`,
  },
  "storefront.orders_downloads.get": {
    exposure: "excluded",
    reason: `Streams a purchased file for the browser holding the ticket's cookie proof. ${cookieBound}`,
  },
} satisfies Record<string, OperationRegistryEntry>;
