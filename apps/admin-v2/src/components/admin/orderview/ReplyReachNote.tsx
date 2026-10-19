import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { buildCustomerNotificationConfig } from "~/components/admin/settings/notification-channel-policy";
import { useMessages } from "~/i18n";
import { orderReplyReachMessages } from "~/i18n/order-reply-reach";
import { customerRulesQuery } from "~/lib/api-query-options/settings-screens";

type Contact = { customerName?: string | null; customerEmail?: string | null; customerPhone?: string | null };

/** The channels the merchant turned on for "New reply" decide who a staff reply reaches. */
export function replyReach(
  contact: Contact,
  channels: { email: boolean; sms: boolean },
): { reached: boolean; fix: "sms" | "email" | null } {
  const hasEmail = Boolean(contact.customerEmail?.trim());
  const hasPhone = Boolean(contact.customerPhone?.trim());
  if ((channels.email && hasEmail) || (channels.sms && hasPhone)) return { reached: true, fix: null };
  // What the merchant could switch on to reach this buyer, if anything.
  return { reached: false, fix: hasPhone && !channels.sms ? "sms" : hasEmail && !channels.email ? "email" : null };
}

/**
 * One quiet line under the reply box when nothing the merchant turned on for a
 * reply can reach the buyer (they still see it on their order page). It reads
 * the settings query the notifications screen shares; while that loads, or when
 * it can't be read, the line stays away rather than guessing.
 */
export function ReplyReachNote({ order }: { order: Contact }) {
  const t = useMessages(orderReplyReachMessages);
  const rules = useQuery({ ...customerRulesQuery, staleTime: 60_000 });
  if (!rules.data?.channels) return null;
  const reply = buildCustomerNotificationConfig(rules.data.channels).conversation_reply;
  const { reached, fix } = replyReach(order, reply);
  if (reached) return null;
  const name = order.customerName?.trim() || t("fallbackName");
  return (
    <p className="mt-2 text-body text-muted-foreground">
      {t("note", { name })}{" "}
      <Link
        to="/admin/settings/notifications"
        hash="customer-rule-conversation_reply"
        className="text-link underline underline-offset-2"
      >
        {fix === "sms" ? t("linkSms") : fix === "email" ? t("linkEmail") : t("link")}
      </Link>
    </p>
  );
}
