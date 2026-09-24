// The React twin of StoreContact.astro for islands: "Contact the store: …"
// with call, WhatsApp and email links, or nothing when the store has none.
import type { StoreContactLink } from "@/lib/store-contact";

interface StoreContactLineProps {
  links: StoreContactLink[] | undefined;
  /** "Contact the store:" in the page's checkout language. */
  label: string;
  className?: string;
}

export function StoreContactLine({ links, label, className = "text-sm text-muted-foreground" }: StoreContactLineProps) {
  if (!links || links.length === 0) return null;
  return (
    <p data-store-contact className={className}>
      {label}{" "}
      {links.map((link, index) => (
        <span key={link.kind}>
          {index > 0 ? " · " : null}
          <a
            href={link.href}
            data-store-contact-link={link.kind}
            className={`font-medium text-primary hover:underline${link.kind === "email" ? " break-all" : ""}`}
            {...(link.kind === "whatsapp" ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {link.label}
          </a>
        </span>
      ))}
    </p>
  );
}
