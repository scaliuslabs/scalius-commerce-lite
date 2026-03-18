import { CheckCircle, XCircle } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlashState =
  | {
      type: "success";
      action: string;
      productName: string;
      oldStock: number;
      newStock: number;
    }
  | {
      type: "error";
      barcode: string;
    };

interface ScanFlashProps {
  flash: FlashState;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScanFlash({ flash }: ScanFlashProps) {
  if (flash.type === "success") {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
        style={{
          backgroundColor: "rgba(34, 197, 94, 0.25)",
          animation: "flash-in-out 500ms ease-out forwards",
        }}
      >
        <div className="rounded-2xl bg-emerald-600 px-8 py-6 text-center shadow-2xl">
          <CheckCircle className="mx-auto h-16 w-16 text-white mb-2" />
          <p className="text-2xl font-bold text-white">{flash.action}</p>
          <p className="text-lg text-emerald-100">{flash.productName}</p>
          <p className="text-sm text-emerald-200">
            Stock: {flash.oldStock} &rarr; {flash.newStock}
          </p>
        </div>

        <style>{`
          @keyframes flash-in-out {
            0% { opacity: 0; }
            10% { opacity: 1; }
            60% { opacity: 1; }
            100% { opacity: 0; }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
      style={{
        backgroundColor: "rgba(239, 68, 68, 0.25)",
        animation: "flash-in-out 500ms ease-out forwards",
      }}
    >
      <div className="rounded-2xl bg-red-600 px-8 py-6 text-center shadow-2xl">
        <XCircle className="mx-auto h-16 w-16 text-white mb-2" />
        <p className="text-2xl font-bold text-white">Not Found</p>
        <p className="text-sm text-red-200">Barcode: {flash.barcode}</p>
      </div>

      <style>{`
        @keyframes flash-in-out {
          0% { opacity: 0; }
          10% { opacity: 1; }
          60% { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
