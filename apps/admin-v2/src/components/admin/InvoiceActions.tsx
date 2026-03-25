import { useState } from "react";
import { Printer, Download, Loader2 } from "lucide-react";

interface InvoiceActionsProps {
  invoiceNumber: string;
}

/**
 * Self-contained invoice styles for PDF generation.
 * html2pdf.js cannot parse oklch() colors from Tailwind v4,
 * so we strip ALL external stylesheets from the cloned document
 * and inject these standalone styles instead.
 */
const PDF_STYLES = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, -apple-system, sans-serif; color: #374151; background: white; }
.invoice-document { background: white; padding: 40px; }
.invoice-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 2px solid #e5e7eb; }
.business-info h1 { font-size: 24px; font-weight: 700; color: #111827; margin: 0; }
.business-info .legal-name { font-size: 13px; color: #6b7280; margin-top: 2px; }
.business-info .details { font-size: 13px; color: #4b5563; margin-top: 8px; line-height: 1.6; }
.business-info .details div { margin: 0; }
.business-logo img { max-height: 60px; max-width: 180px; object-fit: contain; }
.invoice-meta { display: flex; gap: 24px; margin-bottom: 32px; }
.invoice-meta .meta-block { flex: 1; }
.meta-block h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #9ca3af; font-weight: 600; margin-bottom: 8px; }
.meta-block p { font-size: 14px; color: #374151; line-height: 1.5; margin: 0; }
.meta-block .value { font-weight: 600; }
.items-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
.items-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; font-weight: 600; padding: 8px 12px; border-bottom: 2px solid #e5e7eb; }
.items-table th:last-child, .items-table td:last-child { text-align: right; }
.items-table th:nth-child(4), .items-table td:nth-child(4) { text-align: right; }
.items-table td { padding: 10px 12px; font-size: 14px; border-bottom: 1px solid #f3f4f6; vertical-align: top; color: #374151; }
.items-table .variant { font-size: 12px; color: #6b7280; }
.invoice-totals { display: flex; justify-content: flex-end; margin-bottom: 32px; }
.totals-table { width: 280px; }
.totals-table .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; color: #374151; }
.totals-table .row.discount { color: #059669; }
.totals-table .row.grand-total { border-top: 2px solid #1f2937; margin-top: 8px; padding-top: 12px; font-size: 16px; font-weight: 700; color: #111827; }
.invoice-footer { border-top: 1px solid #e5e7eb; padding-top: 16px; text-align: center; font-size: 12px; color: #9ca3af; line-height: 1.6; }
.invoice-footer p { margin: 0; }
`;

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
        margin: [10, 12, 10, 12],
        filename: `invoice-${invoiceNumber}.pdf`,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          onclone: (clonedDoc: Document) => {
            // Remove ALL <style> and <link rel="stylesheet"> tags — they contain
            // Tailwind v4's oklch() colors that html2canvas cannot parse.
            clonedDoc.querySelectorAll('style, link[rel="stylesheet"]').forEach((el) => el.remove());

            // Inject clean, self-contained invoice styles
            const style = clonedDoc.createElement("style");
            style.textContent = PDF_STYLES;
            clonedDoc.head.appendChild(style);

            // Ensure clean background
            clonedDoc.body.style.background = "white";
            clonedDoc.body.style.margin = "0";
            clonedDoc.body.style.padding = "0";
          },
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      }).from(element).save();
    } catch (err) {
      if (import.meta.env.DEV) console.error("PDF generation failed:", err);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        background: "white",
        borderBottom: "1px solid #e5e7eb",
        boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
      }}
      className="print:hidden"
    >
      <div style={{ maxWidth: "210mm", margin: "0 auto", padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: "14px", fontWeight: 500, color: "#374151" }}>
          Invoice {invoiceNumber}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <button
            onClick={handlePrint}
            type="button"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              fontSize: "14px",
              fontWeight: 500,
              color: "#374151",
              background: "white",
              border: "1px solid #d1d5db",
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            <Printer style={{ width: 16, height: 16 }} />
            Print
          </button>
          <button
            onClick={handleDownloadPdf}
            disabled={downloading}
            type="button"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              fontSize: "14px",
              fontWeight: 500,
              color: "white",
              background: downloading ? "#93c5fd" : "#2563eb",
              border: "1px solid #2563eb",
              borderRadius: "6px",
              cursor: downloading ? "not-allowed" : "pointer",
              opacity: downloading ? 0.6 : 1,
            }}
          >
            {downloading ? <Loader2 style={{ width: 16, height: 16, animation: "spin 1s linear infinite" }} /> : <Download style={{ width: 16, height: 16 }} />}
            {downloading ? "Generating..." : "Download PDF"}
          </button>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @media print { .print\\:hidden { display: none !important; } }
      ` }} />
    </div>
  );
}
