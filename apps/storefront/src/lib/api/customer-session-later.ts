import type { AuthState } from "./customer-auth";

/**
 * `getCustomerSession` for a page that asks once it has drawn: the cart
 * page's prefill and its check before an account-only order. The customer
 * API module (sign-in, orders, addresses) then loads with the question
 * instead of with the cart's first paint; the answer is the same.
 */
export async function getCustomerSession(): Promise<AuthState> {
  const { getCustomerSession: read } = await import("./customer-auth");
  return read();
}
