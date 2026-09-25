// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_COPY,
  downloadFileMarkup,
  downloadFileState,
  downloadFlagForApi,
  downloadUsageText,
  formatFileSize,
  isDownloadTicketHref,
  licenceKeyMarkup,
  readBuyerDigitalLines,
  readDownloadNotice,
  readTicketParams,
  renderDownloadLines,
  safeDownloadReturnPath,
  withDownloadStatus,
  type DeliveryMarkupContext,
  type DownloadFileView,
} from "./account-downloads";

const NOW = Date.parse("2026-09-25T00:00:00Z");
const SIG = "A".repeat(43);

function file(overrides: Partial<DownloadFileView> = {}): DownloadFileView {
  return {
    entitlementId: "dge_file0000000001",
    displayName: "Guide.pdf",
    downloadCount: 1,
    downloadLimit: 5,
    expiresAt: null,
    revoked: false,
    ...overrides,
  };
}

const accountContext: DeliveryMarkupContext = {
  access: { kind: "account" },
  returnTo: "/account/downloads",
  askHref: "/account/orders/ord_1#conversation",
  nowMs: NOW,
};

describe("ticket params and links", () => {
  it("accepts well-formed params only", () => {
    expect(readTicketParams({ entitlementId: "dge_1", exp: "1790000000", sig: SIG })).toEqual({ entitlementId: "dge_1", exp: "1790000000", sig: SIG });
    expect(readTicketParams({ entitlementId: "dge 1", exp: "1", sig: SIG })).toBeNull();
    expect(readTicketParams({ entitlementId: "dge_1", exp: "12a", sig: SIG })).toBeNull();
    expect(readTicketParams({ entitlementId: "dge_1", exp: "1", sig: "a+b/c=" })).toBeNull();
    expect(readTicketParams({ entitlementId: "dge_1", exp: "1", sig: "a".repeat(65) })).toBeNull();
    expect(readTicketParams({ entitlementId: "x".repeat(81), exp: "1", sig: SIG })).toBeNull();
    expect(readTicketParams({})).toBeNull();
  });

  it("only redirects to the stream path of the same access and file", () => {
    const account = { kind: "account" } as const;
    const receipt = { kind: "receipt", orderId: "ord_1" } as const;
    expect(isDownloadTicketHref(`/api/downloads/account/dge_1/1790000000/${SIG}`, account, "dge_1")).toBe(true);
    expect(isDownloadTicketHref(`/api/downloads/order/ord_1/dge_1/1790000000/${SIG}`, receipt, "dge_1")).toBe(true);
    expect(isDownloadTicketHref(`/api/downloads/order/ord_1/dge_1/1790000000/${SIG}`, account, "dge_1")).toBe(false);
    expect(isDownloadTicketHref(`/api/downloads/order/ord_2/dge_1/1790000000/${SIG}`, receipt, "dge_1")).toBe(false);
    expect(isDownloadTicketHref(`/api/downloads/account/dge_2/1790000000/${SIG}`, account, "dge_1")).toBe(false);
    expect(isDownloadTicketHref(`https://evil.test/api/downloads/account/dge_1/1/${SIG}`, account, "dge_1")).toBe(false);
    expect(isDownloadTicketHref(`/api/downloads/account/dge_1/1/${SIG}/extra`, account, "dge_1")).toBe(false);
    expect(isDownloadTicketHref(null, account, "dge_1")).toBe(false);
  });
});

describe("return paths and outcome flags", () => {
  it("keeps same-origin download pages with only the order id", () => {
    expect(safeDownloadReturnPath("/account/downloads")).toBe("/account/downloads");
    expect(safeDownloadReturnPath("/account/orders/ord_1?download=limit")).toBe("/account/orders/ord_1");
    expect(safeDownloadReturnPath("/order-success?orderId=ord_1&payment=x&token=secret")).toBe("/order-success?orderId=ord_1");
    expect(safeDownloadReturnPath("/track-order?order=1001")).toBe("/track-order?order=1001");
    for (const bad of ["https://evil.test/account/downloads", "//evil.test/account/downloads", "/\\evil", "/checkout", "account/downloads", "/account/down\nloads", 42, null]) {
      expect(safeDownloadReturnPath(bad)).toBeNull();
    }
  });

  it("adds the flag and the file anchor, and reads them back", () => {
    const location = withDownloadStatus("/order-success?orderId=ord_1", "limit", "dge_1");
    expect(location).toBe("/order-success?orderId=ord_1&download=limit#download-dge_1");
    const url = new URL(location, "https://shop.test");
    expect(readDownloadNotice(url.search, url.hash)).toEqual({ flag: "limit", entitlementId: "dge_1" });
    expect(readDownloadNotice(url.search)).toEqual({ flag: "limit", entitlementId: null });
    expect(readDownloadNotice("?download=bogus")).toBeNull();
  });

  it("maps API refusals to buyer flags", () => {
    const account = { kind: "account" } as const;
    const receipt = { kind: "receipt", orderId: "ord_1" } as const;
    expect(downloadFlagForApi(409, "DOWNLOAD_LIMIT_REACHED", account)).toBe("limit");
    expect(downloadFlagForApi(409, "DOWNLOAD_REVOKED", account)).toBe("revoked");
    expect(downloadFlagForApi(409, "DOWNLOAD_EXPIRED", account)).toBe("expired");
    expect(downloadFlagForApi(429, null, account)).toBe("rate");
    expect(downloadFlagForApi(401, null, account)).toBe("signin");
    expect(downloadFlagForApi(401, null, receipt)).toBe("missing");
    expect(downloadFlagForApi(404, null, receipt)).toBe("missing");
    expect(downloadFlagForApi(503, null, account)).toBe("unavailable");
  });
});

describe("file state and wording", () => {
  it("decides why a file is off", () => {
    expect(downloadFileState(file(), NOW)).toBe("available");
    expect(downloadFileState(file({ downloadCount: 5 }), NOW)).toBe("limit");
    expect(downloadFileState(file({ revoked: true, downloadCount: 5 }), NOW)).toBe("revoked");
    expect(downloadFileState(file({ expiresAt: "2026-09-24T00:00:00Z" }), NOW)).toBe("expired");
    expect(downloadFileState(file({ downloadLimit: null, downloadCount: 99 }), NOW)).toBe("available");
    expect(downloadFileState(file({ available: false }), NOW)).toBe("unavailable");
  });

  it("words usage and sizes", () => {
    expect(downloadUsageText(file())).toBe("1 of 5 downloads used");
    expect(downloadUsageText(file({ downloadLimit: null }))).toBe(DOWNLOAD_COPY.unlimited);
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(1024 * 1024 * 250)).toBe("250 MB");
    expect(formatFileSize(null)).toBe("");
  });
});

describe("markup", () => {
  it("renders a Download POST form with ids only and escapes names", () => {
    const html = downloadFileMarkup(file({ displayName: "<img src=x onerror=alert(1)>" }), accountContext);
    expect(html).toContain('method="post" action="/api/downloads/ticket"');
    expect(html).toContain('name="entitlementId" value="dge_file0000000001"');
    expect(html).toContain('name="returnTo" value="/account/downloads"');
    expect(html).not.toContain('name="orderId"');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain('id="download-dge_file0000000001"');
  });

  it("adds the order id on receipt pages", () => {
    const html = downloadFileMarkup(file(), { ...accountContext, access: { kind: "receipt", orderId: "ord_1" } });
    expect(html).toContain('name="orderId" value="ord_1"');
  });

  it("replaces the button with the reason when a file is off", () => {
    const used = downloadFileMarkup(file({ downloadCount: 5 }), accountContext);
    expect(used).not.toContain("<form");
    expect(used).toContain(DOWNLOAD_COPY.askForMore);
    expect(used).toContain('href="/account/orders/ord_1#conversation"');
    expect(downloadFileMarkup(file({ revoked: true }), accountContext)).toContain(DOWNLOAD_COPY.revoked);
    expect(downloadFileMarkup(file({ expiresAt: "2026-09-01T00:00:00Z" }), accountContext)).toContain(DOWNLOAD_COPY.expired);
  });

  it("shows a refused download's message on its row only", () => {
    const notice = { flag: "limit", entitlementId: "dge_file0000000001" } as const;
    expect(downloadFileMarkup(file(), { ...accountContext, notice })).toContain("used every download of this file");
    expect(downloadFileMarkup(file({ entitlementId: "dge_other" }), { ...accountContext, notice })).not.toContain("used every download of this file");
    const serverSide = downloadFileMarkup(file(), { ...accountContext, notice: { flag: "limit", entitlementId: null } });
    expect(serverSide).toContain("hidden group-target:block");
  });

  it("masks licence keys behind a Show key POST", () => {
    const html = licenceKeyMarkup({ keyId: "dlk_1", last4: "AB<D" }, accountContext);
    expect(html).toContain('method="post" action="/account/licence-key"');
    expect(html).toContain('name="keyId" value="dlk_1"');
    expect(html).toContain("•••• AB&lt;D");
  });
});

describe("the account list", () => {
  const raw = {
    lines: [
      { orderId: "ord_old", orderNumber: 1001, orderItemId: "oi_1", productName: "Old", variantLabel: null, deliveredAt: "2026-09-01T00:00:00Z", files: [file()], licenceKeys: [] },
      { orderId: "ord_new", orderNumber: 1002, orderItemId: "oi_2", productName: "New", variantLabel: "Pro", deliveredAt: "2026-09-20T00:00:00Z", files: [], licenceKeys: [{ keyId: "dlk_1", last4: "WXYZ" }] },
      { orderId: "ord_bad", orderItemId: "oi_3", files: [{ entitlementId: "bad id" }], licenceKeys: [] },
      "junk",
    ],
  };

  it("narrows, drops empty lines and sorts newest first", () => {
    const lines = readBuyerDigitalLines(raw)!;
    expect(lines.map((line) => line.orderId)).toEqual(["ord_new", "ord_old"]);
    expect(readBuyerDigitalLines({})).toBeNull();
  });

  it("links each line to its order", () => {
    const html = renderDownloadLines(readBuyerDigitalLines(raw)!, { returnTo: "/account/downloads", nowMs: NOW });
    expect(html).toContain('href="/account/orders/ord_new"');
    expect(html).toContain("Order #1002");
    expect(html).toContain("•••• WXYZ");
    expect(html).toContain("1 of 5 downloads used");
  });
});
