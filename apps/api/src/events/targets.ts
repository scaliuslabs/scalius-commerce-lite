// Every event fan-out target, in dispatch order: webhooks, then plugin
// subscribers. Composed here because the plugin target
// (`@scalius/core/modules/plugins`) depends on the events module. Each target
// costs one indexed read per flush when nobody subscribes to it.
import { EVENT_FAN_OUT_TARGETS, type EventFanOutTarget } from "@scalius/core/modules/events";
import { pluginEventFanOutTarget } from "@scalius/core/modules/plugins";

export const API_EVENT_FAN_OUT_TARGETS: readonly EventFanOutTarget[] = [...EVENT_FAN_OUT_TARGETS, pluginEventFanOutTarget];
