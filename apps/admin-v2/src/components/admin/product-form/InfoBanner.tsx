// src/components/admin/product-form/InfoBanner.tsx
import { Info } from "lucide-react";

interface InfoBannerProps {
  title: string;
  message: string;
}

export function InfoBanner({ title, message }: InfoBannerProps) {
  return (
    <div className="flex items-start gap-3 p-4 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg">
      <Info className="h-5 w-5 text-blue-500 dark:text-blue-400 mt-0.5 shrink-0" />
      <div>
        <p className="text-sm text-blue-800 dark:text-blue-200">
          <strong className="font-semibold">{title}:</strong> {message}
        </p>
      </div>
    </div>
  );
}
