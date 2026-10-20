// The wishlist page's component (`storefront.components`, target `page`):
// the store draws it inside its layout from what the `wishlist` route
// answers as `props`. Every string is escaped by the SDK's `html`; the
// remove buttons are plain forms posting to the app's own `toggle` route, so
// the page works without JavaScript.
import { defineStorefront, html, type ComponentProps } from "@scalius/plugin-sdk/storefront";

/** What the `wishlist` route answers as the page's props. */
export interface WishlistPageProps {
  signedIn: boolean;
  items?: Array<{ productId: string; name: string; url: string; imageUrl: string | null }>;
  /** The next page's link (`/apps/acme.wishlist/wishlist?cursor=…`), when there is one. */
  more?: string | null;
}

const APP = "/apps/acme.wishlist";

function WishlistPage(input: ComponentProps<Record<string, never>, WishlistPageProps>) {
  if (input.target !== "page") return null;
  const { signedIn, items = [], more = null } = input.props;
  if (!signedIn) {
    return html`<div class="max-w-3xl py-6"><p class="text-lg font-semibold">Sign in to see your wishlist</p><p class="mt-2 text-muted-foreground">Products you save stay here for next time.</p><p class="mt-4"><a class="underline" href="/account">Sign in</a></p></div>`;
  }
  if (items.length === 0) {
    return html`<div class="max-w-3xl"><p class="mt-4 text-muted-foreground">Nothing saved yet. Tap the heart on a product to keep it here.</p><p class="mt-4"><a class="underline" href="/">Continue shopping</a></p></div>`;
  }
  return html`<div class="max-w-3xl"><ul class="mt-4">${items.map((item) => html`<li class="flex items-center gap-4 border-b border-border py-4">${item.imageUrl
    ? html`<img src="${item.imageUrl}" alt="" width="80" height="80" class="h-20 w-20 rounded-md object-cover">`
    : html`<span class="h-20 w-20 rounded-md bg-muted" aria-hidden="true"></span>`}<a class="flex-1 font-medium hover:underline" href="${item.url}">${item.name || "Product"}</a><form action="${APP}/toggle" method="post"><input type="hidden" name="productId" value="${item.productId}"><input type="hidden" name="returnTo" value="${APP}/wishlist"><button type="submit" class="text-sm underline">Remove</button></form></li>`)}</ul>${more
    ? html`<p class="mt-6 text-center"><a class="underline" href="${more}">More saved products</a></p>`
    : null}</div>`;
}

export default defineStorefront({ components: { wishlist_page: WishlistPage } });
