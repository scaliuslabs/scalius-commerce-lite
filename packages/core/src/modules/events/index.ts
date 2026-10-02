// Event outbox and webhooks (COMMERCE-HOOKS H3). The catalog lives in
// `@scalius/shared/events`; rows are written by SQL triggers
// (`@scalius/database` scripts/event-outbox-triggers.ts).

import type { EventFanOutTarget } from "./event-outbox";
import { webhookFanOutTarget } from "./webhook-delivery";

export * from "./event-outbox";
export * from "./webhook-subscriptions";
export * from "./webhook-delivery";

/**
 * Every fan-out target, in dispatch order. A plugin subscriber target joins
 * this list (it implements `EventFanOutTarget`: idempotent per event id,
 * recording its own durable work and returning follow-up queue messages).
 */
export const EVENT_FAN_OUT_TARGETS: readonly EventFanOutTarget[] = [webhookFanOutTarget];
