// An abandoned checkout's recovery link (`/cart/recover/cr1.…`, sent by a
// cart-recovery app): the server reads the link's lines from the API (a
// POST: the token stays out of the API's URL and logs), and the page puts
// them back in the buyer's cart through the store's own cart check, as
// "buy again" does (lib/account-buy-again.ts), then opens the cart. The
// link carries no contact or cart value; the cart prices every line again.
import { apiFetch } from "@/lib/api/transport";

export const CHECKOUT_RECOVERY_TOKEN = /^cr1\.ab_ch_[A-Za-z0-9_-]{1,64}\.[0-9a-z]{1,10}\.[A-Za-z0-9_-]{43}$/;

export interface RecoveredLine {
  productId: string;
  variantId: string | null;
  quantity: number;
  title: string;
  slug: string | null;
}

/** The link's lines, or null for a link that is malformed, expired or spent (the API never says which). */
export async function readCheckoutRecovery(token: string | undefined): Promise<RecoveredLine[] | null> {
  if (!token || !CHECKOUT_RECOVERY_TOKEN.test(token)) return null;
  try {
    const response = await apiFetch("/abandoned-checkouts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }, { auth: false, batch: false, retries: 1 });
    if (!response.ok) return null;
    const json = await response.json() as { success?: boolean; data?: { lines?: RecoveredLine[] } };
    const lines = json.success ? json.data?.lines ?? [] : [];
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

/** The page's words: English and Bangla. */
export function cartRecoveryCopy(language: string) {
  return language === "bn"
    ? { title: "আপনার কার্ট ফিরিয়ে আনা হচ্ছে", restoring: "আপনার কার্টের পণ্যগুলো আবার যোগ করা হচ্ছে…", expiredTitle: "লিংকটির মেয়াদ শেষ", expired: "এই লিংকটি আর কাজ করে না। পণ্যগুলো আবার খুঁজে নিন।", failed: "কার্টে যোগ করা যায়নি। আবার চেষ্টা করুন।", noScript: "কার্ট ফিরিয়ে আনতে জাভাস্ক্রিপ্ট চালু করুন।", shop: "কেনাকাটা চালিয়ে যান" }
    : { title: "Bringing back your cart", restoring: "Putting your items back in your cart…", expiredTitle: "This link has expired", expired: "This link no longer works. Find the items again in the store.", failed: "Your items could not be added. Please try again.", noScript: "Turn on JavaScript to bring back your cart.", shop: "Continue shopping" };
}
