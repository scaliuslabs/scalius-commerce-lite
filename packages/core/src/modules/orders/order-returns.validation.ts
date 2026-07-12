import { z } from "zod";

const commandKeySchema = z.string().trim().min(8).max(200);
const noteSchema = z.string().trim().max(2000).nullable().optional();
const quantitySchema = z.number().int().min(0).max(99_999);

export const createOrderReturnSchema = z.object({
  commandKey: commandKeySchema,
  expectedOrderVersion: z.number().int().min(1),
  reason: z.string().trim().min(1).max(500),
  notes: noteSchema,
  lines: z.array(z.object({
    orderItemId: z.string().trim().min(1),
    quantity: z.number().int().min(1).max(99_999),
    reason: z.string().trim().max(500).nullable().optional(),
    notes: noteSchema,
  })).min(1).max(50),
});

export const approveOrderReturnSchema = z.object({
  commandKey: commandKeySchema,
  expectedVersion: z.number().int().min(1),
  notes: noteSchema,
  lines: z.array(z.object({
    lineId: z.string().trim().min(1),
    approvedQuantity: quantitySchema,
    rejectedQuantity: quantitySchema,
    notes: noteSchema,
  })).min(1).max(50),
});

export const receiveOrderReturnSchema = z.object({
  commandKey: commandKeySchema,
  expectedVersion: z.number().int().min(1),
  notes: noteSchema,
  lines: z.array(z.object({
    lineId: z.string().trim().min(1),
    receivedQuantity: z.number().int().min(1).max(99_999),
    restockQuantity: quantitySchema,
    damagedQuantity: quantitySchema,
    notes: noteSchema,
  }).superRefine((line, ctx) => {
    if (line.restockQuantity + line.damagedQuantity !== line.receivedQuantity) {
      ctx.addIssue({
        code: "custom",
        message: "Restock and damaged quantities must account for every received unit.",
        path: ["receivedQuantity"],
      });
    }
  })).min(1).max(50),
});

export const cancelOrderReturnSchema = z.object({
  commandKey: commandKeySchema,
  expectedVersion: z.number().int().min(1),
  notes: noteSchema,
});

export type CreateOrderReturnInput = z.infer<typeof createOrderReturnSchema>;
export type ApproveOrderReturnInput = z.infer<typeof approveOrderReturnSchema>;
export type ReceiveOrderReturnInput = z.infer<typeof receiveOrderReturnSchema>;
export type CancelOrderReturnInput = z.infer<typeof cancelOrderReturnSchema>;
