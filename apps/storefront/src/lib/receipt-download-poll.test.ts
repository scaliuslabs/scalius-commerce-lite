// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { DOWNLOAD_POLL_DELAYS_MS, pollPreparingDownloads } from "./receipt-download-poll";

const PREPARING = `<div data-receipt-lines><p data-download-preparing><span data-download-preparing-spinner></span><span data-download-preparing-text>Preparing your download…</span><a href="/order-success?orderId=o1">Refresh</a></p></div>`;
const READY = `<html><body><main><div data-receipt-lines><a href="#download-1" data-ready>Download</a></div></main></body></html>`;

function status(downloadsPreparing: boolean) {
  return new Response(JSON.stringify({ success: true, data: { state: "order_placed", downloadsPreparing } }));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("receipt download polling", () => {
  it("does nothing when no line is being prepared", async () => {
    document.body.innerHTML = `<div data-receipt-lines><p>Mug</p></div>`;
    const fetchImpl = vi.fn();
    expect(await pollPreparingDownloads({ root: document, orderId: "o1", laterText: "Later", fetchImpl })).toBe("idle");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks the receipt status until the download is ready, then puts the delivered lines in place", async () => {
    document.body.innerHTML = PREPARING;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(status(true))
      .mockResolvedValueOnce(status(false))
      .mockResolvedValueOnce(new Response(READY, { status: 200 }));
    const waits: number[] = [];
    const result = await pollPreparingDownloads({
      root: document, orderId: "o1", laterText: "Later", fetchImpl,
      wait: async (ms) => { waits.push(ms); },
    });
    expect(result).toBe("ready");
    expect(waits).toEqual(DOWNLOAD_POLL_DELAYS_MS.slice(0, 2));
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/order-receipt/status?orderId=o1");
    expect(document.querySelector("[data-download-preparing]")).toBeNull();
    expect(document.querySelector("[data-ready]")?.textContent).toBe("Download");
  });

  it("stops after a bounded number of checks and says the download comes by email", async () => {
    document.body.innerHTML = PREPARING;
    const fetchImpl = vi.fn(async () => status(true));
    const result = await pollPreparingDownloads({ root: document, orderId: "o1", laterText: "It will arrive by email.", fetchImpl, wait: async () => {} });
    expect(result).toBe("later");
    expect(fetchImpl).toHaveBeenCalledTimes(DOWNLOAD_POLL_DELAYS_MS.length);
    expect(document.querySelector("[data-download-preparing-text]")?.textContent).toBe("It will arrive by email.");
    expect(document.querySelector("[data-download-preparing-spinner]")).toBeNull();
    // The Refresh link stays for the buyer.
    expect(document.querySelector("[data-download-preparing] a")?.textContent).toBe("Refresh");
  });
});
