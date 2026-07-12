# Variant section prototype decision gate

These files are disposable interaction prototypes. They do not ship in the
admin bundle and must not be treated as production components.

All alternatives are evaluated against the same merchant workflow:

- arbitrary ordered choice axes and values must read as one concept;
- the common add/edit flow must be obvious without sacrificing expert speed;
- price, available/on-hand inventory, SKU identity, and media must remain easy
  to scan across many combinations;
- bulk generation and bulk editing must be reachable without dominating the
  primary interface;
- density must come from hierarchy and alignment, not tiny hit targets;
- validation, reserved inventory, and unsaved state must stay visible;
- desktop must avoid nested scrolling and mobile must reflow without a
  document-level horizontal scrollbar;
- the visual language should fit Scalius's neutral admin rather than copy a
  competitor's branding.

The selected concept will be translated into existing React/shadcn primitives
after review. Prototype-only Tailwind CDN usage must not enter production.
