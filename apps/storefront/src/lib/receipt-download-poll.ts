/**
 * A paid download is prepared in the background after checkout. While a
 * receipt line says "Preparing your download…", the receipt checks its own
 * status a bounded number of times and, once the downloads are delivered,
 * puts the freshly rendered order lines in place (no reload). If they are
 * still not ready after the last check, the line says they will arrive by
 * email. Without JavaScript the line's Refresh link does the checking.
 */
export const DOWNLOAD_POLL_DELAYS_MS = [2000, 3000, 5000, 8000, 13000, 21000] as const;

export function pollPreparingDownloads(options: {
  root: Document;
  orderId: string;
  laterText: string;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}): Promise<"ready" | "later" | "idle"> {
  const { root, orderId, laterText } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const lines = root.querySelector<HTMLElement>("[data-receipt-lines]");
  if (!lines?.querySelector("[data-download-preparing]")) return Promise.resolve("idle");

  const stillPreparing = async (): Promise<boolean> => {
    try {
      const response = await fetchImpl(`/api/order-receipt/status?orderId=${encodeURIComponent(orderId)}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const body = (await response.json()) as { success?: boolean; data?: { downloadsPreparing?: unknown } };
      return !(body.success === true && body.data?.downloadsPreparing === false);
    } catch {
      return true;
    }
  };

  const swapInReadyLines = async (): Promise<boolean> => {
    try {
      const page = await fetchImpl(root.location?.href ?? "", { credentials: "same-origin", cache: "no-store" });
      if (!page.ok) return false;
      const next = new DOMParser().parseFromString(await page.text(), "text/html").querySelector("[data-receipt-lines]");
      if (!next) return false;
      root.querySelector("[data-receipt-lines]")?.replaceWith(root.importNode(next, true));
      return true;
    } catch {
      return false;
    }
  };

  return (async () => {
    for (const delay of DOWNLOAD_POLL_DELAYS_MS) {
      await wait(delay);
      if (!(await stillPreparing()) && (await swapInReadyLines())) return "ready";
    }
    for (const note of root.querySelectorAll<HTMLElement>("[data-download-preparing]")) {
      note.querySelector("[data-download-preparing-spinner]")?.remove();
      const text = note.querySelector<HTMLElement>("[data-download-preparing-text]");
      if (text) text.textContent = laterText;
    }
    return "later";
  })();
}
