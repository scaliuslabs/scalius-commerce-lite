// Helpers and schemas shared by the customer account routes.
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getCustomerBySession, getSessionCookie } from "@scalius/core/modules/customers";
import { UnauthorizedError } from "../../utils/api-error";
import { getCustomerSessionHashKey } from "../../utils/encryption-key";

export const customerAuthProfileSchema = z.object({
  email: z.string(),
  name: z.string(),
  phone: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  zone: z.string().nullable().optional(),
  area: z.string().nullable().optional(),
  cityName: z.string().nullable().optional(),
  zoneName: z.string().nullable().optional(),
  areaName: z.string().nullable().optional(),
  profileComplete: z.boolean(),
});

export function setPrivateNoStoreHeaders(c: Context) {
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
}

export async function requireCustomerSession(c: Context<{ Bindings: Env }>) {
  const cookieHeader = c.req.header("Cookie") || null;
  const token = getSessionCookie(cookieHeader);

  if (!token) {
    throw new UnauthorizedError("Authentication required");
  }

  const session = await getCustomerBySession(
    c.get("db"),
    token,
    getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>),
  );

  if (!session) {
    throw new UnauthorizedError("Session expired. Please log in again.");
  }

  return { session, token };
}
