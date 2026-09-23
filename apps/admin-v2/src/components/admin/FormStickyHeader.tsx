import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

export interface FormActionBarProps {
  /** The record being edited; the page header already names it. */
  title: string;
  isEdit: boolean;
  isSubmitting: boolean;
  isDirty?: boolean;
  cancelUrl: string;
  newUrl?: string;
  newLabel?: string;
  canCreateNew?: boolean;
  /**
   * Whether the current operator may submit this form. This is required so a
   * direct form URL cannot accidentally render an enabled save action. API
   * authorization remains the final enforcement boundary.
   */
  canSave: boolean;
  /** Whether the current form values pass client-side validation. */
  isFormValid?: boolean;
  /** Why save is disabled when the operator may not save. */
  saveDisabledReason?: string;
  saveLabel?: string;
  onDiscard?: () => void;
  onSave: () => void;
}

/**
 * Bottom action bar for editors that confirm before saving (orders), portalled
 * into the layout's bottom slot outside the scroll container. Record editors
 * use the contextual save bar (`SaveBarProvider`) instead.
 */
export function FormActionBar({
  isEdit,
  isSubmitting,
  isDirty = false,
  cancelUrl,
  newUrl,
  newLabel,
  canCreateNew = true,
  canSave,
  isFormValid = true,
  saveDisabledReason,
  saveLabel,
  onDiscard,
  onSave,
}: FormActionBarProps) {
  const t = useMessages(resourceMessages);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalTarget(document.getElementById("form-action-bar-slot"));
  }, []);

  const blockedReason = !canSave
    ? saveDisabledReason ?? t("noPermissionToSave")
    : !isDirty
      ? t("noChanges")
      : !isFormValid
        ? t("fixFields")
        : undefined;

  const bar = (
    <div className="flex h-14 items-center justify-between gap-2 border-t bg-background px-4 sm:h-12 sm:gap-4 sm:px-6">
      <p className="min-w-0 truncate text-body text-muted-foreground" aria-live="polite">
        {isDirty ? t("unsavedChanges") : null}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {isSubmitting ? (
          <Button variant="outline" type="button" disabled>
            {t("discard")}
          </Button>
        ) : (
          <Button variant="outline" type="button" asChild>
            <Link to={cancelUrl} onClick={onDiscard}>{t("discard")}</Link>
          </Button>
        )}
        {isEdit && canCreateNew && newUrl && newLabel && !isSubmitting ? (
          // Phones keep the bar to Discard and Save.
          <span className="hidden sm:contents">
            <Button variant="outline" asChild>
              <Link to={newUrl}>
                <Plus aria-hidden="true" />
                {newLabel}
              </Link>
            </Button>
          </span>
        ) : null}
        <Button
          type="button"
          loading={isSubmitting}
          disabled={blockedReason !== undefined}
          title={blockedReason}
          onClick={() => {
            if (blockedReason === undefined) onSave();
          }}
        >
          {saveLabel ?? (isEdit ? t("save") : t("create"))}
        </Button>
      </div>
    </div>
  );

  return portalTarget ? createPortal(bar, portalTarget) : bar;
}
