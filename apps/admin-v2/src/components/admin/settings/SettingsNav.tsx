import { ChevronRight } from "lucide-react";
import { useId, type ComponentType, type ReactNode } from "react";

import { cn } from "@scalius/shared/utils";
import {
  isSettingsNavItemCurrent,
  type SettingsNavGroup,
  type SettingsNavItem,
  type SettingsNavLocation,
} from "./settings-navigation";

export interface SettingsNavLinkProps {
  href: string;
  className?: string;
  "aria-current"?: "page" | undefined;
  children: ReactNode;
}

export interface SettingsNavProps {
  /** Already filtered by permission; empty groups must not be passed in. */
  groups: readonly SettingsNavGroup[];
  location: SettingsNavLocation;
  /** Opens a section of the general settings page. */
  onSelectSection: (item: Extract<SettingsNavItem, { kind: "section" }>) => void;
  /**
   * Router-aware link for the standalone settings routes. Defaults to a plain
   * anchor so the nav renders (and is testable) without a router context.
   */
  linkComponent?: ComponentType<SettingsNavLinkProps>;
  /**
   * `sidebar` is the persistent column shown from `lg` up. `index` is the
   * full-width settings index used below `lg`, where each row also shows what
   * the destination controls and reads as a link to its own page.
   */
  variant?: "sidebar" | "index";
  className?: string;
}

function DefaultLink({ children, ...rest }: SettingsNavLinkProps) {
  return <a {...rest}>{children}</a>;
}

const ROW_BASE =
  "group flex w-full min-w-0 items-center gap-3 text-left transition-colors";

const SIDEBAR_ROW =
  "min-h-11 rounded-sm px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground sm:min-h-9";
const SIDEBAR_ROW_CURRENT = "bg-muted text-foreground";

const INDEX_ROW =
  "min-h-14 px-3 py-3 text-sm hover:bg-muted/60 focus-visible:bg-muted/60";

/**
 * The settings area's own navigation: every settings destination in one list,
 * whether it is a section of the general settings page or its own route.
 *
 * Highlighting is derived from the location, never from local state, so a
 * browser back/forward step and a `?section=` deep link agree with each other.
 */
export function SettingsNav({
  groups,
  location,
  onSelectSection,
  linkComponent,
  variant = "sidebar",
  className,
}: SettingsNavProps) {
  const Link = linkComponent ?? DefaultLink;
  const navId = useId();
  const isIndex = variant === "index";

  return (
    <nav
      aria-label="Settings"
      data-settings-nav={variant}
      className={cn(
        isIndex
          ? "divide-y divide-border overflow-hidden rounded-lg border border-border bg-card"
          : "min-w-0 rounded-md border border-border bg-card p-1",
        className,
      )}
    >
      {groups.map((group) => {
        const labelId = `${navId}-${group.id}`;
        return (
          <div key={group.id} className={isIndex ? undefined : "w-full py-1 first:pt-0 last:pb-0"}>
            <p
              id={labelId}
              className={cn(
                "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
                isIndex
                  ? "bg-muted/40 px-3 py-2"
                  : "px-2 pb-1 pt-2 first:pt-1",
              )}
            >
              {group.label}
            </p>
            <ul aria-labelledby={labelId} className={isIndex ? "divide-y divide-border" : undefined}>
              {group.items.map((item) => {
                const current = isSettingsNavItemCurrent(item, location);
                const Icon = item.icon;
                const body = (
                  <>
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        current ? "text-foreground" : "text-muted-foreground",
                      )}
                      aria-hidden
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn("truncate", isIndex && "font-medium")}>
                        {item.label}
                      </span>
                      {isIndex ? (
                        <span className="mt-0.5 text-xs leading-5 text-muted-foreground">
                          {item.description}
                        </span>
                      ) : null}
                    </span>
                    {isIndex ? (
                      <ChevronRight
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    ) : null}
                  </>
                );
                const rowClassName = cn(
                  ROW_BASE,
                  isIndex ? INDEX_ROW : SIDEBAR_ROW,
                  !isIndex && current && SIDEBAR_ROW_CURRENT,
                  isIndex && current && "bg-muted/60",
                );

                return (
                  <li key={item.id} className="min-w-0">
                    {item.kind === "route" ? (
                      <Link
                        href={item.href}
                        className={rowClassName}
                        aria-current={current ? "page" : undefined}
                      >
                        {body}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        data-settings-nav-section={item.section}
                        aria-current={current ? "page" : undefined}
                        className={rowClassName}
                        onClick={() => onSelectSection(item)}
                      >
                        {body}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export default SettingsNav;
