/**
 * Presence in lists ("Rahim is viewing" on an order row). For list screens:
 *
 *   const open = useListPresence("order");        // once per list
 *   <RowPresence people={open.get(order.id)} />   // components/admin/realtime/RowPresence.tsx
 */
import { useEffect, useState } from "react";
import type { PresenceListPrefix, RealtimePresence } from "@scalius/shared/realtime";
import { realtimeUserId, subscribeRealtime, watchPresenceList } from "./store";


/**
 * Who else has each record of a list open ("Rahim is viewing" on an order
 * row), by record id, without the viewer. For list screens: pass the result
 * to `RowPresence` (components/admin/realtime/RowPresence.tsx) for one row.
 */
export function useListPresence(prefix: PresenceListPrefix): ReadonlyMap<string, RealtimePresence[]> {
  const [people, setPeople] = useState<ReadonlyMap<string, RealtimePresence[]>>(() => new Map());
  useEffect(() => {
    const release = watchPresenceList(prefix);
    const head = `${prefix}:`;
    const unsubscribe = subscribeRealtime({
      presence: (key, list) => {
        if (!key.startsWith(head)) return;
        const others = list.filter((person) => person.id !== realtimeUserId());
        setPeople((current) => {
          const id = key.slice(head.length);
          if (others.length === 0 && !current.has(id)) return current;
          const next = new Map(current);
          if (others.length === 0) next.delete(id);
          else next.set(id, others);
          return next;
        });
      },
      status: (next) => {
        if (next !== "open") setPeople(new Map());
      },
    });
    return () => {
      unsubscribe();
      release();
    };
  }, [prefix]);
  return people;
}
