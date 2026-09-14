import type { ReactNode } from "react";
import { useId } from "react";

import { cn } from "@scalius/shared/utils";
import { Card, CardContent, CardFooter, CardHeader } from "~/components/ui/card";

export interface FormCardProps {
  /** Optional card heading. Omit it when a PageHeader already names the content. */
  title?: string;
  description?: ReactNode;
  /** Right-aligned header controls. */
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

/**
 * Plain card for non-annotated layouts (dashboards, detail panes, wizards).
 * Use `SettingsSection` instead on settings pages.
 */
export function FormCard({
  title,
  description,
  actions,
  footer,
  children,
  className,
  contentClassName,
}: FormCardProps) {
  const headingId = useId();

  return (
    <Card
      data-testid="form-card"
      aria-labelledby={title ? headingId : undefined}
      className={cn("rounded-lg shadow-sm", className)}
    >
      {title || description || actions ? (
        <CardHeader
          data-testid="form-card-header"
          className="flex flex-row flex-wrap items-start justify-between gap-x-3 gap-y-2 space-y-0 p-4 sm:p-6"
        >
          <div
            data-testid="form-card-heading"
            className="min-w-0 flex-1 basis-[12rem]"
          >
            {title ? (
              <h2 id={headingId} className="text-sm font-semibold leading-5 text-pretty break-words">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div
              data-testid="form-card-actions"
              className="flex shrink-0 flex-wrap items-center gap-2"
            >
              {actions}
            </div>
          ) : null}
        </CardHeader>
      ) : null}
      <CardContent
        className={cn(
          "p-4 sm:p-6",
          title || description || actions ? "pt-0 sm:pt-0" : undefined,
          contentClassName,
        )}
      >
        {children}
      </CardContent>
      {footer ? (
        <CardFooter className="border-t border-border px-4 py-3 text-[13px] leading-5 text-muted-foreground sm:px-6">
          {footer}
        </CardFooter>
      ) : null}
    </Card>
  );
}

export default FormCard;
