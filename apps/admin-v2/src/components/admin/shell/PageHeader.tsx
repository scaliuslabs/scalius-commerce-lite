import { ChevronRight, MoreHorizontal } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useId } from "react";

import { cn } from "@scalius/shared/utils";
import { Button, type ButtonProps } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

export type PageHeaderIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export interface PageHeaderAction {
  /** Stable identity for the action; also used as the React key. */
  id: string;
  label: string;
  onClick?: () => void;
  icon?: PageHeaderIcon;
  disabled?: boolean;
  /** Styling only. Destructive actions still need their own confirmation dialog. */
  variant?: ButtonProps["variant"];
  /** Optional explanation surfaced on a disabled action. */
  disabledReason?: string;
}

export interface PageHeaderBreadcrumb {
  label: string;
  /** Link target. Omit for the current, non-clickable trail item. */
  href?: string;
  onClick?: () => void;
}

export interface PageHeaderLinkProps {
  href: string;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}

export interface PageHeaderTitleContext {
  /** Put this on the heading: the header points `aria-labelledby` at it. */
  id: string;
  /** The classes the default `h1` would have used. */
  className: string;
  title: string;
}

export interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /**
   * Status line under the title: a `StatusBadge` and at most one short
   * sentence saying what the state means for the merchant.
   */
  status?: ReactNode;
  /** Content inline after the title, e.g. a "Rename" pencil. */
  titleSlot?: ReactNode;
  /**
   * Escape hatch for a title the operator can edit in place. It replaces the
   * default `h1` entirely, so the caller must render a heading carrying
   * `context.id` — even a visually hidden one while an input has the focus.
   */
  renderTitle?: (context: PageHeaderTitleContext) => ReactNode;
  breadcrumbs?: readonly PageHeaderBreadcrumb[];
  /**
   * One primary action per page. Anything else belongs in `secondaryActions`.
   */
  primaryAction?: PageHeaderAction;
  secondaryActions?: readonly PageHeaderAction[];
  /**
   * How many secondary actions stay inline once the header itself is wide
   * enough (`@lg`, 32rem of header width). The rest always move into the
   * overflow menu; in a narrower header every secondary action is in the menu.
   */
  inlineActionCount?: number;
  /** Extra content between the title block and the actions (status badge, tabs). */
  children?: ReactNode;
  /**
   * Router-aware link used for breadcrumbs. Defaults to a plain anchor so the
   * header can be rendered (and tested) without a router context.
   */
  linkComponent?: ComponentType<PageHeaderLinkProps>;
  className?: string;
}

export interface HeaderActionSplit {
  inline: PageHeaderAction[];
  overflow: PageHeaderAction[];
}

/**
 * Splits secondary actions into the inline group and the overflow group.
 * Exported so the collapse rule can be asserted without measuring layout.
 */
export function splitHeaderActions(
  actions: readonly PageHeaderAction[],
  inlineActionCount: number,
): HeaderActionSplit {
  const limit = Math.max(0, inlineActionCount);
  return {
    inline: actions.slice(0, limit),
    overflow: actions.slice(limit),
  };
}

const titleClassName = "text-xl font-semibold tracking-tight text-pretty break-words";

function DefaultLink({ href, className, onClick, children }: PageHeaderLinkProps) {
  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  );
}

function ActionButton({
  action,
  className,
  defaultVariant,
}: {
  action: PageHeaderAction;
  className?: string;
  defaultVariant: ButtonProps["variant"];
}) {
  const Icon = action.icon;
  return (
    <Button
      type="button"
      variant={action.variant ?? defaultVariant}
      disabled={action.disabled}
      title={action.disabled ? action.disabledReason : undefined}
      className={cn("min-h-11 sm:min-h-9", className)}
      onClick={action.onClick}
    >
      {Icon ? <Icon className="h-4 w-4" aria-hidden /> : null}
      {action.label}
    </Button>
  );
}

/**
 * The "More actions" menu. There are two of them so the menu contents stay
 * correct in both layouts: the menu is portalled out of the header, so a
 * container query cannot reach its items — only the triggers, which live in
 * the header, can be switched by one.
 */
function OverflowMenu({
  actions,
  testId,
  className,
}: {
  actions: readonly PageHeaderAction[];
  testId: string;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="More actions"
          data-testid={testId}
          className={cn("h-11 w-11 sm:h-9 sm:w-9", className)}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <DropdownMenuItem
              key={action.id}
              disabled={action.disabled}
              onSelect={() => action.onClick?.()}
            >
              {Icon ? <Icon className="h-4 w-4" aria-hidden /> : null}
              {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Page title block: optional breadcrumb trail, title, subtitle and a
 * right-aligned action area.
 *
 * The title block and the action cluster are one wrapping flex row measured by
 * the header's own width (`@container`), never the viewport: the title keeps a
 * 16rem basis and wraps its text, and the actions drop to a line of their own
 * as soon as both no longer fit — which is what a 560px content column beside
 * the settings navigation needs. Secondary actions only sit inline once the
 * header is at least `@lg` wide; below that they are all in the "..." menu.
 */
export function PageHeader({
  title,
  subtitle,
  status,
  titleSlot,
  renderTitle,
  breadcrumbs,
  primaryAction,
  secondaryActions = [],
  inlineActionCount = 2,
  children,
  linkComponent,
  className,
}: PageHeaderProps) {
  const headingId = useId();
  const Link = linkComponent ?? DefaultLink;
  const { inline, overflow } = splitHeaderActions(secondaryActions, inlineActionCount);
  const hasSecondary = secondaryActions.length > 0;
  const hasOverflow = overflow.length > 0;

  return (
    <header
      data-testid="page-header"
      aria-labelledby={headingId}
      className={cn("@container mb-4 flex flex-col gap-3", className)}
    >
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {breadcrumbs.map((crumb, index) => (
              <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                {index > 0 ? (
                  <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
                ) : null}
                {crumb.href ? (
                  <Link
                    href={crumb.href}
                    onClick={crumb.onClick}
                    className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="text-foreground">
                    {crumb.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      <div
        data-testid="page-header-row"
        className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3"
      >
        <div data-testid="page-header-title-block" className="min-w-0 flex-1 basis-[16rem]">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {renderTitle ? (
              renderTitle({ id: headingId, className: titleClassName, title })
            ) : (
              <h1 id={headingId} className={titleClassName}>
                {title}
              </h1>
            )}
            {titleSlot}
          </div>
          {status ? (
            <div
              data-testid="page-header-status"
              className="mt-1 flex flex-wrap items-center gap-2 text-[13px] leading-5 text-muted-foreground"
            >
              {status}
            </div>
          ) : null}
          {subtitle ? (
            <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>

        {primaryAction || hasSecondary || children ? (
          <div
            data-testid="page-header-actions"
            className="flex w-full shrink-0 flex-wrap items-center gap-2 @md:w-auto @md:justify-end"
          >
            {children}
            {inline.map((action) => (
              <ActionButton
                key={action.id}
                action={action}
                defaultVariant="outline"
                className="hidden @lg:inline-flex"
              />
            ))}
            {hasSecondary ? (
              <OverflowMenu
                actions={secondaryActions}
                testId="page-header-overflow"
                className="@lg:hidden"
              />
            ) : null}
            {hasOverflow ? (
              <OverflowMenu
                actions={overflow}
                testId="page-header-overflow-wide"
                className="hidden @lg:inline-flex"
              />
            ) : null}
            {primaryAction ? (
              <ActionButton action={primaryAction} defaultVariant="default" />
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}

export default PageHeader;
