// The SMS port as core calls it: the shared port
// (`@scalius/shared/plugins/providers/messaging`) bound to the merchant's saved
// choice. Every SMS gateway is an app's (`<plugin id>:<provider id>`), reached
// through the request's AppProviders; the Bangladesh gateways are the
// Bangladesh pack's (integrations/retired-providers.ts). Senders call `send`
// and never ask which gateway it is.

import type { BoundProvider } from "../provider-port";

/** The SMS provider a send goes through. */
export type SmsProvider = BoundProvider<"sms">;
