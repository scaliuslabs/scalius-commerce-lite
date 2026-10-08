/**
 * Connects this tab to the store's realtime hub and turns its notices into
 * precise query invalidations. Loaded lazily by the admin frame, so the first
 * page never waits for it. It also hosts the one merge-choice dialog editors
 * ask through `requestMergeChoice`.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { realtimeTopicsFor } from "@scalius/shared/realtime";
import { RealtimeConnection } from "~/lib/realtime/connection";
import { attachRealtime } from "~/lib/realtime/store";
import { createInvalidator, keysForChanges, resyncKeys } from "~/lib/realtime/invalidate";
import { MergeChoiceHost } from "./MergeChoiceDialog";

export default function RealtimeBridge({ userId, permissions }: { userId: string; permissions: readonly string[] }) {
  const queryClient = useQueryClient();
  const permissionKey = permissions.join(",");
  useEffect(() => {
    const topics = realtimeTopicsFor(permissionKey.split(","));
    const connection = new RealtimeConnection();
    const invalidator = createInvalidator(queryClient);
    const unsubscribe = connection.subscribe({
      changes: (items) => {
        invalidator.add(keysForChanges(items));
        // List screens hear notices as a window event, so they load no realtime module
        // (use-live-order-list.ts listens for the same names).
        window.dispatchEvent(new CustomEvent("scalius:realtime-changes", { detail: items }));
      },
      resync: () => {
        invalidator.add(resyncKeys(topics));
        window.dispatchEvent(new Event("scalius:realtime-resync"));
      },
    });
    attachRealtime(connection, userId);
    connection.start();
    return () => {
      unsubscribe();
      attachRealtime(null);
      connection.stop();
      invalidator.dispose();
    };
  }, [queryClient, userId, permissionKey]);
  return <MergeChoiceHost />;
}
