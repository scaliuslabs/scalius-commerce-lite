import type { ComponentType, ReactNode } from "react";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { HELP_LINKS } from "~/lib/help-links";

interface EmptyStateProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  /** The one primary action. */
  action?: ReactNode;
  /** A first-run page also says where to ask for help. Default: no (a filtered list, a trash, a placeholder). */
  help?: boolean;
}

/**
 * Polaris' EmptyState, for a screen with nothing on it yet: what this is
 * (title and a sentence), one primary action, and a way to ask for help.
 */
export function EmptyState({ icon: Icon, title, description, action, help = false }: EmptyStateProps) {
  const t = useMessages(resourceMessages);
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <Icon className="h-7 w-7 text-muted-foreground" />
      </span>
      <h2 className="text-heading-md font-semibold">{title}</h2>
      {description ? <p className="mt-1 max-w-sm text-body text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
      {help ? (
        <a
          href={HELP_LINKS.questions}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 rounded-md text-body text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("emptyHelp")}
        </a>
      ) : null}
    </div>
  );
}
