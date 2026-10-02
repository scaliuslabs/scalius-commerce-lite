// Event outbox and webhooks (COMMERCE-HOOKS H3). The catalog lives in
// `@scalius/shared/events`; rows are written by SQL triggers
// (`@scalius/database` scripts/event-outbox-triggers.ts).

import type { EventFanOutTarget } from "./event-outbox";
import { webhookFanOutTarget } from "./webhook-delivery";

export * from "./event-outbox";
export * from "./webhook-subscriptions";
export * from "./webhook-delivery";

/**
 * The core fan-out targets. The API composes the full list
 * (apps/api/src/events/targets.ts) with the plugin subscriber target from
 * `@scalius/core/modules/plugins`, which depends on this module and so cannot
 * be listed here. Every target implements `EventFanOutTarget`: idempotent per
 * event id, recording its own durable work and returning follow-up messages.
 */
export const EVENT_FAN_OUT_TARGETS: readonly EventFanOutTarget[] = [webhookFanOutTarget];
