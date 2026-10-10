import { createContext, useContext, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";

/**
 * Set by the phone card (`DataTable`): the whole card is the row's link, so
 * the title inside it is text, not a second, smaller link (C6, T14).
 */
export const CardRowContext = createContext(false);

/**
 * A row's title link (T15: a real link, so Cmd-click opens a new tab). Inside
 * a phone card it is plain text, because the card itself links.
 */
export function RowLink({ to, title, className, children }: {
  to: string;
  /** The whole value on hover where the text is cut (T7). */
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const inCard = useContext(CardRowContext);
  return inCard ? (
    <span title={title} className={className}>{children}</span>
  ) : (
    <Link to={to} title={title} className={className}>{children}</Link>
  );
}
