// The props the Sellers proxy routes answer for its page components
// (pages.tsx draws them). Plain types, so the backend (portal.ts) imports
// them without compiling the storefront's JSX.

/** An amount in major units of `currency` (the route converts from minor units once, with the store's decimal places). */
export interface PageMoney {
  amount: number;
  currency: string;
}

export interface PageSeller {
  name: string;
  handle: string;
  status: string;
}

export interface PageSplit {
  id: string;
  /** The order number, or its id. */
  order: string;
  /** Epoch ms. */
  placedAt: number;
  lines: Array<{ quantity: number; title: string }>;
  status: string;
  net: PageMoney;
  /** Open or paid: the seller can mark it as shipped. */
  shippable: boolean;
}

export interface PagePayout {
  /** Epoch ms. */
  periodEnd: number;
  orders: number;
  gross: PageMoney;
  commission: PageMoney;
  net: PageMoney;
  status: string;
  reference: string | null;
}

/** What the `portal` and `apply` routes answer as the `seller_portal` page's props. */
export type SellerPortalProps =
  | { view: "sign-in"; signIn: string }
  | { view: "apply"; storeName: string; open: boolean; errors?: Record<string, string>; values?: Record<string, string> }
  | { view: "home"; seller: PageSeller; sales: PageMoney; net: PageMoney; toShipCount: number; toShip: PageSplit[] }
  | { view: "orders"; seller: PageSeller; orders: PageSplit[]; older: string | null; notice: "shipped" | "not_shipped" | null }
  | { view: "products"; seller: PageSeller; products: Array<{ name: string; status: string }> }
  | { view: "payouts"; seller: PageSeller; payouts: PagePayout[] };

/** What the `store` route answers as the `seller_shop` page's props. */
export type SellerShopProps =
  | { found: false }
  | { found: true; about: string | null; products: Array<{ name: string; url: string; price: PageMoney | null; image: string | null }> };
