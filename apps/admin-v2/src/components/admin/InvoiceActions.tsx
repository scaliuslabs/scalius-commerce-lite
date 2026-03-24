import { useState } from "react";
import { Printer, Download, Loader2 } from "lucide-react";

interface InvoiceActionsProps {
  invoiceNumber: string;
}

export function InvoiceActions({ invoiceNumber }: InvoiceActionsProps) {
  const [downloading, setDownloading] = useState(false);

  const handlePrint = () => {
    window.print();
  };

  const handleDownloadPdf = async () => {
    setDownloading(true);
    try {
      const { default: html2pdf } = await import("html2pdf.js");
      const element = document.getElementById("invoice-document");
      if (!element) return;
      await html2pdf().set({
        margin: 0,
        filename: `invoice-${invoiceNumber}.pdf`,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          // Strip oklch() CSS variables that html2canvas/html2pdf cannot parse.
          // Tailwind v4 sets oklch-based custom properties on :root which bleed
          // into the cloned document and cause a "unsupported color function" error.
          onclone: (clonedDoc: Document) => {
            const root = clonedDoc.documentElement;
            const rootStyle = root.style;
            // Remove any CSS custom property whose computed value contains oklch
            const computed = getComputedStyle(document.documentElement);
            for (let i = computed.length - 1; i >= 0; i--) {
              const prop = computed[i];
              if (prop.startsWith("--")) {
                const val = computed.getPropertyValue(prop);
                if (val.includes("oklch")) {
                  rootStyle.removeProperty(prop);
                }
              }
            }
            // Also remove from <body>
            const bodyComputed = getComputedStyle(document.body);
            const clonedBody = clonedDoc.body;
            for (let i = bodyComputed.length - 1; i >= 0; i--) {
              const prop = bodyComputed[i];
              if (prop.startsWith("--")) {
                const val = bodyComputed.getPropertyValue(prop);
                if (val.includes("oklch")) {
                  clonedBody.style.removeProperty(prop);
                }
              }
            }
            // Force white background on the invoice element
            const invoiceEl = clonedDoc.getElementById("invoice-document");
            if (invoiceEl) {
              invoiceEl.style.background = "white";
              invoiceEl.style.color = "#374151";
            }
          },
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      }).from(element).save();
    } catch (err) {
      console.error("PDF generation failed:", err);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="print:hidden fixed top-0 left-0 right-0 z-50 bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-[210mm] mx-auto px-4 py-3 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">
          Invoice {invoiceNumber}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={handlePrint}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            <Printer className="h-4 w-4" />
            Print
          </button>
          <button
            onClick={handleDownloadPdf}
            disabled={downloading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 border border-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-60"
          >
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {downloading ? "Generating..." : "Download PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}
