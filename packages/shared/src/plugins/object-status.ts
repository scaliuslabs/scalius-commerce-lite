// The statuses an app object's record may hold, and their machine. A leaf
// (it imports only the pure machine shape): the event contracts name these,
// and the dashboard pages that read an event topic must not download the
// object schemas (and the handle spelling tables) to do so.
//
// `status` is publication, not a workflow, and which values a record takes
// depends on its type:
// - a type that is not storefront-visible keeps every record `active`;
// - a storefront-visible type's record is `draft` (hidden from buyers) or
//   `published` (buyers see it), and the app or staff set either at any time.
// An app's own workflow belongs in a field of its own, moved by its own
// machine (`moveRecordStatus` in the SDK).
import { defineMachine } from "../machine";

export const OBJECT_STATUSES = ["active", "draft", "published"] as const;
export type ObjectStatus = (typeof OBJECT_STATUSES)[number];

/** The statuses a record of a type takes: draft and published for a storefront-visible type, else active. */
export function objectRecordStatuses(storefront: boolean): readonly ObjectStatus[] {
  return storefront ? ["draft", "published"] : ["active"];
}

/**
 * A record's status moves. A write may set a record to any status its type
 * takes (`publish`, `unpublish`); changing a type's storefront visibility
 * moves all its records at once: an `active` record becomes `draft`, and a
 * draft or published one becomes `active`. No state is final.
 */
export const OBJECT_RECORD_MACHINE = defineMachine({
  name: "object record",
  states: OBJECT_STATUSES,
  initial: OBJECT_STATUSES,
  final: [],
  moves: {
    publish: { from: ["draft"], to: "published" },
    unpublish: { from: ["published"], to: "draft" },
    /** The type became storefront-visible. */
    storefront_on: { from: ["active"], to: "draft" },
    /** The type stopped being storefront-visible. */
    storefront_off: { from: ["draft", "published"], to: "active" },
  },
});
