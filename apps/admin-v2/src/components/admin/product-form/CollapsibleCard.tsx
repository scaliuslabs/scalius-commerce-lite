import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader } from "../../ui/card";
import { cn } from "@scalius/shared/utils";

const REVEAL_EVENT = "scalius:reveal-card";

/**
 * Opens the collapsible card with this id, scrolls it into view and puts the
 * keyboard on its title (e.g. Inventory's "Add file" opens Digital delivery).
 */
export function revealCard(id: string) {
  window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: id }));
}

interface CollapsibleCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  /** One muted line under the title while the card is closed ("2 bundles", "Not set up"). */
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  /** Anchor for `revealCard(id)` and in-page links. */
  id?: string;
  className?: string;
}

/**
 * An advanced section of an editor: its title is always visible, its body
 * opens from the title row. It starts closed when empty (the caller decides).
 * Once opened, the body stays mounted while closed, so an upload or a typed
 * draft inside it survives closing the card.
 */
export function CollapsibleCard({
  title,
  description,
  children,
  summary,
  defaultOpen = false,
  id,
  className,
}: CollapsibleCardProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);
  const [seen, setSeen] = React.useState(defaultOpen);
  const contentId = React.useId();
  const cardRef = React.useRef<HTMLDivElement>(null);
  const toggleRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!id) return;
    const onReveal = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) return;
      setIsOpen(true);
      setSeen(true);
      requestAnimationFrame(() => {
        cardRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
        toggleRef.current?.focus({ preventScroll: true });
      });
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, [id]);

  const toggle = () => {
    setIsOpen((open) => !open);
    setSeen(true);
  };

  return (
    <Card ref={cardRef} id={id} className={cn("scroll-mt-4", className)}>
      <CardHeader>
        <button
          ref={toggleRef}
          type="button"
          // The whole title row is the toggle: 8px of padding above and below the text makes a 36px target (44px on phones, C6) without moving it.
          className="-my-2 flex min-h-11 items-start justify-between gap-3 rounded-lg py-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
          aria-expanded={isOpen}
          aria-controls={contentId}
          onClick={toggle}
        >
          <span className="min-w-0 space-y-1">
            <span className="block text-heading-sm">{title}</span>
            {description ? <span className="block text-body text-muted-foreground">{description}</span> : null}
          </span>
          <span className="flex h-lh shrink-0 items-center">
            <ChevronDown aria-hidden="true" className={cn("size-4 text-muted-foreground", isOpen && "rotate-180")} />
          </span>
        </button>
      </CardHeader>
      {!isOpen && summary ? <CardContent>{summary}</CardContent> : null}
      {seen ? (
        <CardContent id={contentId} hidden={!isOpen} className="space-y-4">
          {children}
        </CardContent>
      ) : null}
    </Card>
  );
}
