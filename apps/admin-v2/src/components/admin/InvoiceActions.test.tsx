// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  html2pdf: vi.fn(),
}));

vi.mock("html2pdf.js", () => ({
  default: mocks.html2pdf,
}));

import { InvoiceActions } from "./InvoiceActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("InvoiceActions", () => {
  let host: HTMLDivElement;
  let invoiceDocument: HTMLDivElement;
  let root: Root;
  let save: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement("div");
    invoiceDocument = document.createElement("div");
    invoiceDocument.id = "invoice-document";
    document.body.append(host, invoiceDocument);
    root = createRoot(host);

    save = vi.fn().mockResolvedValue(undefined);
    const chain = {
      set: vi.fn(),
      from: vi.fn(),
      save,
    };
    chain.set.mockReturnValue(chain);
    chain.from.mockReturnValue(chain);
    mocks.html2pdf.mockReset();
    mocks.html2pdf.mockReturnValue(chain);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    invoiceDocument.remove();
    vi.restoreAllMocks();
  });

  function renderActions() {
    act(() => root.render(
      <InvoiceActions orderId="order_1" invoiceNumber="INV-1001" />,
    ));
  }

  function pdfButton(): HTMLButtonElement {
    const button = [...host.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Download PDF"),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Download PDF button not found");
    }
    return button;
  }

  async function clickPdfButton() {
    await act(async () => {
      pdfButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("keeps a failed PDF action visible and retryable without hiding Printable HTML", async () => {
    save.mockRejectedValueOnce(new Error("canvas failed"));
    renderActions();

    await clickPdfButton();

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("PDF could not be generated");
    expect(alert?.textContent).toContain("Printable HTML");
    expect(alert?.textContent).not.toContain("canvas failed");
    expect(pdfButton().disabled).toBe(false);
    expect(host.textContent).toContain("Printable HTML");

    let resolveRetry: (() => void) | undefined;
    save.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveRetry = resolve;
    }));
    const retryButton = pdfButton();
    await act(async () => {
      retryButton.click();
      await Promise.resolve();
    });

    expect(save).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(retryButton.disabled).toBe(true);
    expect(retryButton.textContent).toContain("Generating");

    await act(async () => {
      resolveRetry?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(pdfButton().disabled).toBe(false);
  });

  it("reports a missing invoice document instead of returning silently", async () => {
    invoiceDocument.remove();
    renderActions();

    await clickPdfButton();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "PDF could not be generated",
    );
    expect(mocks.html2pdf).not.toHaveBeenCalled();
    expect(pdfButton().disabled).toBe(false);
  });
});
