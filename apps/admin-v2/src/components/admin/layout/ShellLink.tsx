import * as React from "react";
import { useLinkProps } from "@tanstack/react-router";

type ShellLinkProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "aria-current"> & {
  to: string;
  preload?: "intent" | false;
  /** The page this link stands for is the one on screen (the sidebar pill's rule). */
  current: boolean;
};

/**
 * A router link for the shell whose `aria-current` follows the dashboard's own
 * active rule, not the router's URL match: the router marks a section link
 * current on some pages and not others (search params, detail pages), and
 * marks the logo current everywhere.
 */
export const ShellLink = React.forwardRef<HTMLAnchorElement, ShellLinkProps>(
  ({ to, preload, current, children, ...props }, ref) => {
    const {
      "aria-current": _routerCurrent,
      "data-status": _routerStatus,
      ...link
    } = useLinkProps({ to, preload, ...props } as Parameters<typeof useLinkProps>[0], ref as React.ForwardedRef<Element>) as React.ComponentPropsWithRef<"a"> & {
      "data-status"?: string;
    };
    // useLinkProps keeps `children` for itself; they go back on the anchor here.
    return (
      <a {...link} aria-current={current ? "page" : undefined}>
        {children}
      </a>
    );
  },
);
ShellLink.displayName = "ShellLink";
