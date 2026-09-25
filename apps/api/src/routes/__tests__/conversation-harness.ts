// Test-only harness for the conversation routes: the real public buyer app on
// the migrated SQLite schema, a customer session, a receipt proof, in-memory
// R2, a fake IMAGES binding and switchable rate limiters. Never imported by
// Worker code.
import type { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { hashCustomerSessionToken } from "@scalius/core/modules/customers";
import { hashOrderReceiptToken } from "@scalius/core/modules/orders";
import publicBuyerApp from "../../runtime/public-buyer-app";

export const SESSION_KEY = "conversation-session-key-0123456789";
export const OWNER_SESSION = "owner-session-token";
export const OTHER_SESSION = "other-session-token";
export const RECEIPT_TOKEN = "chk_guestreceipttoken0001";
export const WEBP_OUTPUT = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
  0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00,
]);

/** A JPEG whose APP1 segment carries EXIF with a GPS tag (bytes only; never decoded by the fake). */
export function exifJpeg(): Uint8Array {
  const exif = new TextEncoder().encode("Exif\0\0MM\0*GPSLatitude=23.8103;GPSLongitude=90.4125");
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, exif.length + 2, ...exif, 0xff, 0xd9]);
}

export interface Harness {
  sqlite: DatabaseSync;
  env: Env;
  r2: Map<string, Uint8Array>;
  imagesInputs: Uint8Array[];
  limiter: { allow: boolean; missing: boolean };
  request: (path: string, init?: RequestInit & { session?: string; receipt?: boolean }) => Promise<Response>;
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function createConversationHarness(): Promise<Harness> {
  const { sqlite, binding } = createSqliteD1Database();
  const expires = Math.floor(Date.now() / 1000) + 3_600;
  sqlite.exec(`
    INSERT INTO customers (id, name, email, phone, origin, account_claimed_at, email_verified_at)
      VALUES ('cust_owner', 'Owner', 'owner@example.test', '+8801711000001', 'account', unixepoch(), unixepoch()),
             ('cust_other', 'Other', 'other@example.test', '+8801711000002', 'account', unixepoch(), unixepoch());
    INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone,
        total_amount_minor, balance_due_minor, customer_id, account_owner_customer_id, order_number)
      VALUES ('ORDEROWNED000001', 'Owner', '+8801711000001', 'owner@example.test', 'House 1', 'c', 'z', 50000, 50000, 'cust_owner', 'cust_owner', 1057),
             ('ORDERGUEST000001', 'Guest', '+8801711000009', NULL, 'House 9', 'c', 'z', 30000, 30000, NULL, NULL, 1058);
    INSERT INTO user (id, name, email, email_verified, role) VALUES ('staff_1', 'Nadia', 'nadia@shop.test', 1, 'admin');
  `);
  for (const [token, customerId] of [[OWNER_SESSION, "cust_owner"], [OTHER_SESSION, "cust_other"]] as const) {
    sqlite.prepare("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?, ?, ?)")
      .run(await hashCustomerSessionToken(token, SESSION_KEY), customerId, expires);
  }
  sqlite.prepare("INSERT INTO order_receipts (token_hash, order_id, expires_at) VALUES (?, 'ORDERGUEST000001', ?)")
    .run(await hashOrderReceiptToken(RECEIPT_TOKEN), expires);

  const r2 = new Map<string, Uint8Array>();
  const imagesInputs: Uint8Array[] = [];
  const limiter = { allow: true, missing: false };
  const rateLimiter = { limit: vi.fn(async () => ({ success: limiter.allow })) };
  const pipeline = {
    transform: () => pipeline,
    output: async () => ({ response: () => new Response(WEBP_OUTPUT.slice()) }),
  };
  const images = {
    info: async (stream: ReadableStream<Uint8Array>) => {
      imagesInputs.push(await streamBytes(stream));
      return { format: "image/jpeg", fileSize: 10, width: 4000, height: 3000 };
    },
    input: (stream: ReadableStream<Uint8Array>) => {
      void streamBytes(stream);
      return pipeline;
    },
  };
  const bucket = {
    put: async (key: string, value: ArrayBuffer | Uint8Array) => {
      r2.set(key, new Uint8Array(value instanceof Uint8Array ? value : value));
    },
    get: async (key: string) => {
      const bytes = r2.get(key);
      return bytes ? { body: new Response(bytes.slice()).body } : null;
    },
    delete: async (key: string) => {
      r2.delete(key);
    },
  };

  const env = new Proxy({
    DB: binding,
    JWT_SECRET: "conversation-test-secret-0123456789",
    CUSTOMER_SESSION_HASH_KEY: SESSION_KEY,
    PUBLIC_API_BASE_URL: "https://api.example.test",
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    BUCKET: bucket,
    IMAGES: images,
    JOBS_QUEUE: { send: vi.fn(async () => undefined) },
  } as Record<string, unknown>, {
    get(target, key: string) {
      if (key === "RL_STRICT" || key === "RL_STANDARD") return limiter.missing ? undefined : rateLimiter;
      return target[key];
    },
  }) as unknown as Env;

  return {
    sqlite,
    env,
    r2,
    imagesInputs,
    limiter,
    request: (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (init.session) headers.set("Cookie", `cs_tok=${init.session}`);
      if (init.receipt) headers.set("X-Receipt-Token", RECEIPT_TOKEN);
      if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      return Promise.resolve(publicBuyerApp.request(`https://api.example.test/api/v1${path}`, { ...init, headers }, env));
    },
  };
}
