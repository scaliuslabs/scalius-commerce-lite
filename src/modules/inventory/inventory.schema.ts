import { z } from "zod";

export const adjustInventorySchema = z.object({
    delta: z.number({ required_error: "delta (number) is required" }),
    reason: z.enum(["received", "correction", "damage", "theft", "return", "other"]),
    notes: z.string().optional(),
    pool: z.enum(["stock", "preorderStock"]).optional().default("stock"),
});
