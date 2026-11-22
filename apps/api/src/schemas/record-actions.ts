// The actions a return, purchase order or transfer is read with: each
// command the record's lifecycle declares (@scalius/shared/record-lifecycles),
// available or blocked with a stable reason, computed by the rule its command
// refuses by. Named components, so a list of records states them once.
import { z } from "@hono/zod-openapi";
import {
  INVENTORY_TRANSFER_LIFECYCLE,
  PURCHASE_ORDER_LIFECYCLE,
  RETURN_ACTION_BLOCKS,
  RETURN_LIFECYCLE,
  STOCK_DOCUMENT_ACTION_BLOCKS,
} from "@scalius/shared/record-lifecycles";

function actionState<const B extends readonly [string, ...string[]]>(blocks: B, name: string) {
  return z.object({
    available: z.boolean(),
    reason: z.enum(["status", ...blocks]).nullable().openapi({
      description: "Null exactly when available. `status`: the record's state refuses it.",
    }),
  }).openapi(name);
}

function actionsOf<S extends z.ZodTypeAny>(commands: readonly string[], state: S) {
  return z.object(Object.fromEntries(commands.map((command) => [command, state])) as Record<string, S>);
}

const returnActionState = actionState(RETURN_ACTION_BLOCKS, "ReturnActionState");
const stockDocumentActionState = actionState(STOCK_DOCUMENT_ACTION_BLOCKS, "StockDocumentActionState");

export const returnActionsSchema = actionsOf([...Object.keys(RETURN_LIFECYCLE.commands), "reconcile"], returnActionState).openapi("ReturnActions", {
  description: "What may be done to the return now, by command (`dashboard.orders.return_<command>`): available, or blocked with its reason.",
});

export const purchaseOrderActionsSchema = actionsOf(Object.keys(PURCHASE_ORDER_LIFECYCLE.commands), stockDocumentActionState).openapi("PurchaseOrderActions", {
  description: "What may be done to the purchase order now, by command (`dashboard.purchase_orders.<command>`): available, or blocked with its reason.",
});

export const inventoryTransferActionsSchema = actionsOf(Object.keys(INVENTORY_TRANSFER_LIFECYCLE.commands), stockDocumentActionState).openapi("InventoryTransferActions", {
  description: "What may be done to the transfer now, by command (`dashboard.inventory_transfers.<command>`): available, or blocked with its reason.",
});
