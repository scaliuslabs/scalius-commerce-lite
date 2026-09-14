import type { ReactNode } from "react";
import { useId } from "react";

import { cn } from "@scalius/shared/utils";

export interface SettingsSectionProps {
  /** Left-column heading. Sentence case, no trailing punctuation. */
  title: string;
  /** Left-column description. Says what the setting does, not what it "is". */
  description?: ReactNode;
  children: ReactNode;
  /** Card footer, separated by a border. Never put a per-section Save here. */
  footer?: ReactNode;
  /** Header-level controls for the card (a toggle, an "Add" button). */
  actions?: ReactNode;
  /** Anchor id so settings navigation can deep-link to the section. */
  id?: string;
  className?: string;
  cardClassName?: string;
  contentClassName?: string;
}

/**
 * The annotated settings section: an explanatory left column and a card with
 * the controls on the right. Stacks to one column below `lg`.
 *
 * Settings pages save through a single `ContextualSaveBar`; sections do not get
 * their own Save buttons.
 */
export function SettingsSection({
  title,
  description,
  children,
  footer,
  actions,
  id,
  className,
  cardClassName,
  contentClassName,
}: SettingsSectionProps) {
  const headingId = useId();

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      data-testid="settings-section"
      className={cn(
        // Two columns only when the section itself is wide enough (container
        // query, not viewport): beside the settings navigation a 1024px window
        // leaves ~560px, which must stack.
        "@container grid gap-3 @3xl:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] @3xl:gap-8",
        className,
      )}
    >
      <div className="@3xl:pt-1">
        <h2 id={headingId} className="text-sm font-semibold leading-5">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 max-w-[28ch] text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>

      <div
        className={cn(
          "min-w-0 rounded-lg border border-border bg-card text-card-foreground shadow-sm",
          cardClassName,
        )}
      >
        {actions ? (
          <div
            data-testid="settings-section-actions"
            className="flex flex-wrap items-center justify-end gap-2 border-b border-border px-4 py-2 sm:px-6"
          >
            {actions}
          </div>
        ) : null}
        <div className={cn("p-4 sm:p-6", contentClassName)}>{children}</div>
        {footer ? (
          <div className="border-t border-border bg-muted/30 px-4 py-3 text-[13px] leading-5 text-muted-foreground sm:px-6">
            {footer}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default SettingsSection;
