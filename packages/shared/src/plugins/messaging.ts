// App messaging (`ctx.messaging`, COMMERCE-HOOKS H5 "Messaging"): the limits
// the host and the SDK's test harness share. Part of the versioned plugin API.
//
// Who a message may reach:
//   - a customer by `customerId` (`read_customers`); the platform resolves
//     the address and never returns it;
//   - by `to`: a staff member's email address, or an address held in one of
//     the app's declared `messaging.recipients` fields (its own Objects);
//   - any other `to` only with the sensitive `send_messages_any` scope;
//   - marketing (`marketing: true`) only to a subscribed customer by id
//     (`write_marketing`).
// Every send counts against the app's `messagesPerMinute` (plan limits).

/** The largest message an app sends, measured as the provider receives it. */
export const PLUGIN_MESSAGE_LIMITS = {
  /** Email subject, in characters. */
  subjectChars: 200,
  /** Email HTML body, in UTF-8 bytes. */
  htmlBytes: 100 * 1024,
  /** Email plain-text body, in UTF-8 bytes. */
  textBytes: 50 * 1024,
  /** SMS text, in characters. */
  smsChars: 1000,
} as const;

/** The scope that lets an app message any address (`PLUGIN_SCOPES.send_messages_any`). */
export const PLUGIN_MESSAGE_ANY_SCOPE = "send_messages_any" as const;

/** Why a `to` is refused, in the words the host and the harness both use. */
export const PLUGIN_MESSAGE_RECIPIENT_RULE =
  "to must be a staff member's email or an address held in a messaging.recipients field of the app's own records; any other address needs the send_messages_any scope.";

/** Whether `value` is text within the character and UTF-8 byte limits (and not blank). */
export function pluginMessageTextFits(value: unknown, limit: { chars?: number; bytes?: number }): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  if (limit.chars !== undefined && value.length > limit.chars) return false;
  return limit.bytes === undefined || new TextEncoder().encode(value).byteLength <= limit.bytes;
}
