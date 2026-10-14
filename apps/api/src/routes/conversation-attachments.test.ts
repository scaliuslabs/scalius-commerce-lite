// C7: attachments are sniffed by content, accepted only as a well-formed still
// WebP (the browser pipeline's output; no Worker re-encodes images), stored
// under the private prefix, bounded, and served only after an access check
// with inline, nosniff, no-store headers.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConversationHarness,
  OTHER_SESSION,
  OWNER_SESSION,
  WEBP_OUTPUT,
  webpUpload,
  type Harness,
} from "./__tests__/conversation-harness";

let harness: Harness;

beforeEach(async () => {
  harness = await createConversationHarness();
});
afterEach(() => harness.sqlite.close());

function upload(bytes: Uint8Array, fields: Record<string, string> = {}, type = "image/webp") {
  const form = new FormData();
  form.set("file", new Blob([bytes.slice().buffer as ArrayBuffer], { type }), "photo.webp");
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

describe("conversation attachments (C7)", () => {
  it("stores the prepared WebP privately, reads its size from the header, and serves it to the thread's buyer", async () => {
    const response = await harness.request("/orders/receipt/ORDERGUEST000001/conversation-attachments", {
      method: "POST",
      receipt: true,
      body: upload(webpUpload()),
    });
    expect(response.status).toBe(201);
    const { data } = await response.json() as { data: { attachmentId: string; conversationId: string; mediaType: string; width: number; height: number } };
    expect(data).toMatchObject({ mediaType: "image/webp", width: 1, height: 1 });

    const [key, stored] = [...harness.r2.entries()][0]!;
    expect(key).toBe(`private/conversations/${data.conversationId}/${data.attachmentId}`);
    expect(stored).toEqual(WEBP_OUTPUT);

    // Staged uploads are visible to their uploader until sent; then only through public lines.
    const posted = await harness.request("/orders/receipt/ORDERGUEST000001/conversation", {
      method: "POST",
      receipt: true,
      body: JSON.stringify({ body: "Payment screenshot", clientMessageKey: "p1", attachmentIds: [data.attachmentId] }),
    });
    expect(posted.status).toBe(201);
    const served = await harness.request(`/orders/receipt/ORDERGUEST000001/conversation/attachments/${data.attachmentId}`, { receipt: true });
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/webp");
    expect(served.headers.get("Content-Disposition")).toBe("inline");
    expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(served.headers.get("Cache-Control")).toBe("private, no-store");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(WEBP_OUTPUT);

    expect((await harness.request(`/orders/receipt/ORDERGUEST000001/conversation/attachments/${data.attachmentId}`)).status).toBe(404);
    expect((await harness.request(`/customer-auth/conversations/${data.conversationId}/attachments/${data.attachmentId}`, { session: OTHER_SESSION })).status).toBe(404);
  });

  it("rejects non-images by content, oversized uploads, and a file for someone else's order", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const spoofed = await harness.request("/orders/receipt/ORDERGUEST000001/conversation-attachments", {
      method: "POST", receipt: true, body: upload(html, {}, "image/jpeg"),
    });
    expect(spoofed.status).toBe(400);

    const gif = new TextEncoder().encode("GIF89a....");
    expect((await harness.request("/orders/receipt/ORDERGUEST000001/conversation-attachments", {
      method: "POST", receipt: true, body: upload(gif, {}, "image/gif"),
    })).status).toBe(400);

    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(WEBP_OUTPUT);
    expect((await harness.request("/orders/receipt/ORDERGUEST000001/conversation-attachments", {
      method: "POST", receipt: true, body: upload(big),
    })).status).toBe(400);

    expect((await harness.request("/customer-auth/conversation-attachments", {
      method: "POST", session: OTHER_SESSION, body: upload(webpUpload(), { orderId: "ORDEROWNED000001" }),
    })).status).toBe(404);
    expect(harness.r2.size).toBe(0);
  });

  it("caps a message at three images and attaches each once", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await harness.request("/customer-auth/conversation-attachments", {
        method: "POST", session: OWNER_SESSION, body: upload(webpUpload(), { orderId: "ORDEROWNED000001" }),
      });
      ids.push(((await response.json()) as { data: { attachmentId: string } }).data.attachmentId);
    }
    const tooMany = await harness.request("/customer-auth/orders/ORDEROWNED000001/conversation", {
      method: "POST", session: OWNER_SESSION, body: JSON.stringify({ body: "four", clientMessageKey: "c1", attachmentIds: ids }),
    });
    expect(tooMany.status).toBe(400);
    const ok = await harness.request("/customer-auth/orders/ORDEROWNED000001/conversation", {
      method: "POST", session: OWNER_SESSION, body: JSON.stringify({ body: "three", clientMessageKey: "c2", attachmentIds: ids.slice(0, 3) }),
    });
    expect(ok.status).toBe(201);
    const again = await harness.request("/customer-auth/orders/ORDEROWNED000001/conversation", {
      method: "POST", session: OWNER_SESSION, body: JSON.stringify({ body: "again", clientMessageKey: "c3", attachmentIds: [ids[0]] }),
    });
    expect(again.status).toBe(400);
  });

  it("refuses a JPEG or PNG, and a WebP with data after the image, instead of re-encoding on the server", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x04, 0x45, 0x78, 0xff, 0xd9]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const trailing = new Uint8Array([...WEBP_OUTPUT, ...new TextEncoder().encode("<script>alert(1)</script>")]);
    for (const [bytes, type] of [[jpeg, "image/jpeg"], [png, "image/png"], [trailing, "image/webp"]] as const) {
      const response = await harness.request("/orders/receipt/ORDERGUEST000001/conversation-attachments", {
        method: "POST", receipt: true, body: upload(bytes, {}, type),
      });
      expect(response.status).toBe(400);
    }
    expect(harness.r2.size).toBe(0);
  });
});
