/**
 * The hash that opens a channel's sending setup on Settings → Notifications
 * (`/admin/settings/notifications#sending-email`): a hint that says to set a
 * channel up links straight to its fields. Its own module so a page linking
 * here does not load the Notifications screen.
 */
export const SENDING_DIALOG = { email: "sending-email", sms: "sending-sms", whatsapp: "sending-whatsapp" } as const;
