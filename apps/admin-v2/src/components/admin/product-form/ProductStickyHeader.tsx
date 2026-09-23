import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";

interface ProductActionBarProps {
  isEdit: boolean;
  isSubmitting: boolean;
  hasRevisionConflict: boolean;
  onDiscard: () => void;
  onSave: () => void;
}

/** Bottom save bar, shown only while the product has unsaved changes. */
export function ProductActionBar({ isEdit, isSubmitting, hasRevisionConflict, onDiscard, onSave }: ProductActionBarProps) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalTarget(document.getElementById("form-action-bar-slot"));
  }, []);

  const bar = (
    <div className="border-t bg-background">
      <div className="flex items-center justify-between gap-2 px-4 py-2 sm:px-6">
        <span role="status" className="min-w-0 truncate text-body font-medium text-muted-foreground">
          {isSubmitting
            ? r("saving")
            : hasRevisionConflict
              ? t("changedElsewhere")
              : isEdit
                ? r("unsavedChanges")
                : t("unsavedProduct")}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" type="button" disabled={isSubmitting} onClick={onDiscard}>
            {r("discard")}
          </Button>
          {/* The label stays put while saving so the bar never shifts. */}
          <Button type="button" disabled={isSubmitting} aria-busy={isSubmitting} onClick={onSave}>
            {hasRevisionConflict ? t("reviewChanges") : r("save")}
          </Button>
        </div>
      </div>
    </div>
  );

  return portalTarget ? createPortal(bar, portalTarget) : bar;
}
