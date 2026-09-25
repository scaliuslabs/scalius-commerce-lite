// Buyer downloads and licence keys through the real public app on the
// migrated SQLite schema (Wave B §3.4, D5, D6): tickets are minted by a POST
// that counts, are bound to the proof that minted them (the session cookie or
// the receipt proof), stream as sandboxed attachments with Range, and a URL
// without its cookie is a 404. Keys are revealed only to their buyer.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@scalius/database/client";
import { autoFulfilOrder } from "@scalius/core/modules/fulfilment";
import { importLicenceKeys } from "@scalius/core/modules/digital";
import {
  createConversationHarness,
  OTHER_SESSION,
  OWNER_SESSION,
  RECEIPT_TOKEN,
  type Harness,
} from "../__tests__/conversation-harness";
import { parseByteRange } from "./downloads";

const CREDENTIAL_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => 200 - index)));
const FILE = new TextEncoder().encode("0123456789abcdefghij");
const R2_KEY = "private/digital/dga_book_file_0001/dgu_1";

let harness: Harness;

beforeEach(async () => {
  harness = await createConversationHarness();
  const target = harness.env as unknown as Record<string, unknown>;
  target.SCALIUS_SECRET = "downloads-route-test-master-secret-0123456789";
  target.CREDENTIAL_ENCRYPTION_KEY = CREDENTIAL_KEY;
  // R2 with ranges and heads, like the Workers binding.
  target.BUCKET = {
    head: async (key: string) => (key === R2_KEY ? { size: FILE.length } : null),
    get: async (key: string, options?: { range?: { offset: number; length: number } }) => {
      if (key !== R2_KEY) return null;
      const bytes = options?.range ? FILE.slice(options.range.offset, options.range.offset + options.range.length) : FILE;
      return { body: new Response(bytes.slice()).body };
    },
  };
  harness.sqlite.exec(`
    INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_book', 'E-book', 'ebook', 50000, 1), ('p_app', 'App', 'app', 90000, 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
    VALUES ('v_book', 'p_book', 'EBOOK', 50000, 0, 0, 0, 1, 0, 'digital'), ('v_app', 'p_app', 'APP', 90000, 0, 0, 0, 1, 1, 'digital');
    INSERT INTO digital_assets (id, product_id, variant_id, kind, status, display_name, filename, media_type, size_bytes, current_r2_key, download_limit)
    VALUES ('dga_book_file_0001', 'p_book', NULL, 'file', 'ready', 'The book', 'Book "final".pdf', 'application/pdf', ${FILE.length}, '${R2_KEY}', 2);
    INSERT INTO digital_assets (id, product_id, variant_id, kind, status, display_name, download_limit)
    VALUES ('dga_app_pool_0001', 'p_app', 'v_app', 'licence_keys', 'ready', 'Licence key', NULL);
    INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, inventory_tracked,
      unit_price_minor, line_subtotal_minor, discount_amount_minor, taxable_amount_minor, tax_amount_minor, fulfillment_type)
    VALUES ('i_owned_book', 'ORDEROWNED000001', 'p_book', 'v_book', 1, 'E-book', 0, 50000, 50000, 0, 0, 0, 'digital'),
           ('i_owned_app', 'ORDEROWNED000001', 'p_app', 'v_app', 1, 'App', 0, 90000, 90000, 0, 0, 0, 'digital'),
           ('i_guest_book', 'ORDERGUEST000001', 'p_book', 'v_book', 1, 'E-book', 0, 50000, 50000, 0, 0, 0, 'digital');
    UPDATE orders SET payment_method = 'stripe', payment_status = 'paid', paid_amount_minor = total_amount_minor, balance_due_minor = 0, requires_shipping = 0;
  `);
  const db = getDb(harness.env);
  await importLicenceKeys(db, { assetId: "dga_app_pool_0001", keys: ["APP-KEY-0000-7777"], requestKey: crypto.randomUUID(), credentialKey: CREDENTIAL_KEY });
  await autoFulfilOrder(db, "ORDEROWNED000001");
  await autoFulfilOrder(db, "ORDERGUEST000001");
});
afterEach(() => harness.sqlite.close());

const entitlementOf = (orderId: string) =>
  (harness.sqlite.prepare(`SELECT id FROM digital_entitlements WHERE order_id = ? AND kind = 'file'`).get(orderId) as { id: string }).id;

async function mint(path: string, init: Parameters<Harness["request"]>[1]) {
  const response = await harness.request(path, { method: "POST", ...init });
  return { response, body: await response.json() as { data?: { href: string; downloadCount: number }; error?: { code: string } } };
}

/** The API path the storefront proxy calls for a storefront ticket href. */
function apiPathOf(href: string): string {
  const parts = href.split("/");
  return `/orders/downloads/${parts.slice(-3).join("/")}`;
}

describe("account downloads", () => {
  it("lists what the account received and mints a counted ticket bound to the session", async () => {
    const list = await harness.request("/customer-auth/downloads", { session: OWNER_SESSION });
    expect(list.status).toBe(200);
    expect(list.headers.get("Cache-Control")).toContain("no-store");
    const lines = (await list.json() as { data: { lines: Array<{ orderItemId: string; files: unknown[]; licenceKeys: Array<{ last4: string }> }> } }).data.lines;
    expect(lines.map((line) => line.orderItemId).sort()).toEqual(["i_owned_app", "i_owned_book"]);
    expect(lines.find((line) => line.orderItemId === "i_owned_app")?.licenceKeys).toEqual([expect.objectContaining({ last4: "7777" })]);

    const entitlementId = entitlementOf("ORDEROWNED000001");
    const { response, body } = await mint(`/customer-auth/downloads/${entitlementId}/ticket`, { session: OWNER_SESSION });
    expect(response.status).toBe(200);
    expect(body.data?.href).toMatch(new RegExp(`^/api/downloads/account/${entitlementId}/\\d+/[A-Za-z0-9_-]{43}$`));
    expect(body.data?.downloadCount).toBe(1);

    const api = apiPathOf(body.data!.href);
    const file = await harness.request(api, { session: OWNER_SESSION });
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(FILE);
    expect(file.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(file.headers.get("Content-Disposition")).toBe(`attachment; filename="Book final.pdf"; filename*=UTF-8''Book%20final.pdf`);
    expect(file.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(file.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(file.headers.get("Cache-Control")).toBe("private, no-store");
    expect(file.headers.get("Accept-Ranges")).toBe("bytes");

    // Resuming with Range is free (the count stays at 1).
    const part = await harness.request(api, { session: OWNER_SESSION, headers: { Range: "bytes=10-" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe(`bytes 10-19/${FILE.length}`);
    expect(new TextDecoder().decode(await part.arrayBuffer())).toBe("abcdefghij");
    expect(harness.sqlite.prepare("SELECT download_count FROM digital_entitlements WHERE id = ?").get(entitlementId)).toEqual({ download_count: 1 });

    // A logged URL alone, or with someone else's cookie, is a 404.
    expect((await harness.request(api)).status).toBe(404);
    expect((await harness.request(api, { session: OTHER_SESSION })).status).toBe(404);
    expect((await harness.request(api, { receipt: true })).status).toBe(404);
  });

  it("stops at the download limit and refuses other accounts", async () => {
    const entitlementId = entitlementOf("ORDEROWNED000001");
    expect((await mint(`/customer-auth/downloads/${entitlementId}/ticket`, { session: OTHER_SESSION })).response.status).toBe(404);
    expect((await mint(`/customer-auth/downloads/${entitlementId}/ticket`, {})).response.status).toBe(401);
    await mint(`/customer-auth/downloads/${entitlementId}/ticket`, { session: OWNER_SESSION });
    await mint(`/customer-auth/downloads/${entitlementId}/ticket`, { session: OWNER_SESSION });
    const third = await mint(`/customer-auth/downloads/${entitlementId}/ticket`, { session: OWNER_SESSION });
    expect(third.response.status).toBe(409);
    expect(third.body.error?.code).toBe("DOWNLOAD_LIMIT_REACHED");
  });

  it("reveals a licence key only to its owner, never cached", async () => {
    const keyId = (harness.sqlite.prepare("SELECT id FROM digital_licence_keys").get() as { id: string }).id;
    const revealed = await harness.request(`/customer-auth/licence-keys/${keyId}/reveal`, { method: "POST", session: OWNER_SESSION });
    expect(revealed.status).toBe(200);
    expect(revealed.headers.get("Cache-Control")).toContain("no-store");
    expect((await revealed.json() as { data: { key: string } }).data.key).toBe("APP-KEY-0000-7777");
    expect((await harness.request(`/customer-auth/licence-keys/${keyId}/reveal`, { method: "POST", session: OTHER_SESSION })).status).toBe(404);

    harness.limiter.allow = false;
    expect((await harness.request(`/customer-auth/licence-keys/${keyId}/reveal`, { method: "POST", session: OWNER_SESSION })).status).toBe(429);
  });
});

describe("receipt downloads", () => {
  it("mints with the receipt proof and streams only with that proof", async () => {
    const entitlementId = entitlementOf("ORDERGUEST000001");
    expect((await harness.request(`/orders/receipt/ORDERGUEST000001/downloads`)).status).toBe(404);
    const list = await harness.request(`/orders/receipt/ORDERGUEST000001/downloads`, { receipt: true });
    expect(list.status).toBe(200);

    expect((await mint(`/orders/receipt/ORDERGUEST000001/downloads/${entitlementId}/ticket`, {})).response.status).toBe(404);
    // The receipt of this order can't reach another order's download.
    expect((await mint(`/orders/receipt/ORDERGUEST000001/downloads/${entitlementOf("ORDEROWNED000001")}/ticket`, { receipt: true })).response.status).toBe(404);
    const { body } = await mint(`/orders/receipt/ORDERGUEST000001/downloads/${entitlementId}/ticket`, { receipt: true });
    expect(body.data?.href).toMatch(new RegExp(`^/api/downloads/order/ORDERGUEST000001/${entitlementId}/\\d+/[A-Za-z0-9_-]{43}$`));
    expect(body.data?.href).not.toContain(RECEIPT_TOKEN);

    const api = apiPathOf(body.data!.href);
    expect((await harness.request(api, { receipt: true })).status).toBe(200);
    expect((await harness.request(api, { session: OWNER_SESSION })).status).toBe(404);
    expect((await harness.request(api)).status).toBe(404);

    // Revoked by staff: the live ticket stops working at once.
    harness.sqlite.prepare("UPDATE digital_entitlements SET revoked_at = unixepoch() WHERE id = ?").run(entitlementId);
    expect((await harness.request(api, { receipt: true })).status).toBe(404);
  });
});

describe("byte ranges", () => {
  it("parses single ranges and refuses the unsatisfiable", () => {
    expect(parseByteRange(undefined, 20)).toBeNull();
    expect(parseByteRange("bytes=0-4", 20)).toEqual({ offset: 0, length: 5 });
    expect(parseByteRange("bytes=15-", 20)).toEqual({ offset: 15, length: 5 });
    expect(parseByteRange("bytes=-5", 20)).toEqual({ offset: 15, length: 5 });
    expect(parseByteRange("bytes=10-99", 20)).toEqual({ offset: 10, length: 10 });
    expect(parseByteRange("bytes=20-", 20)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=0-1,4-5", 20)).toBeNull();
  });
});
