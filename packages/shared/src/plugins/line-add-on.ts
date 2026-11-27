// The one shape an app or a theme reads an app add-on's money in, everywhere:
// a function's cart line, the cart's and an order's UI slots, the order
// representation and API. A leaf (zod only), so the function contract and the
// sealed representation build from the same definition.
import { z } from "zod";

/**
 * How an add-on is counted (`LineAddOn.per`): `unit`, on each unit of its
 * line; `bundle`, once per bundle unit (an expanded bundle's or a store kit's
 * add-on, carried by the bundle's anchor line). The list only grows, at its end.
 */
export const LINE_ADD_ON_PER = ["unit", "bundle"] as const;

const minor = z.number().int().safe().min(0);

/**
 * One app add-on on a line. `totalMinor` is the number to trust: what the
 * add-on adds to the line in all, exactly, in integer minor units of the
 * line's currency (sum it, refund against it, show it when nothing else is
 * exact). `per` says what it is counted in: each unit of the line (`unit`)
 * or each bundle unit (`bundle`). `units` is how many of those the line
 * holds: its quantity (`unit`), or its bundle units (`bundle`), null when
 * they are no longer known (a bundle line whose quantity staff changed).
 * `amountMinor` is what one of them pays when one amount is exact for every
 * one, else null: whenever it is a number, `totalMinor = amountMinor × units`.
 * `appId` is the app that added it (null only on an add-on frozen before apps
 * were named on them). A free extra is 0.
 */
export const lineAddOnSchema = z.object({
  appId: z.string().min(1).max(128).nullable(),
  title: z.string().max(80),
  totalMinor: minor,
  amountMinor: minor.nullable(),
  per: z.enum(LINE_ADD_ON_PER),
  units: z.number().int().min(1).nullable(),
}).strict();
export type LineAddOn = z.infer<typeof lineAddOnSchema>;
