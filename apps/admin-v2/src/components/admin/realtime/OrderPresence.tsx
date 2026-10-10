/**
 * Who else has this order open (DESIGN.md W6), so two people don't handle it
 * at once. Order detail loads this lazily (its first render carries no
 * realtime code) and keeps the same reserved box as its fallback.
 */
import { PresenceSlot, presenceKey } from "~/lib/realtime/store";

export default function OrderPresence({ orderId, version }: { orderId: string; version: number | null }) {
  return <PresenceSlot presenceKey={presenceKey("order", orderId)} revision={version} dirty={false} />;
}
