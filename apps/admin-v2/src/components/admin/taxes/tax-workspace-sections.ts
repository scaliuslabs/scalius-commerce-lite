/**
 * Tabs rendered by the tax workspace.
 *
 * Rates leads because a merchant arrives to answer "what does checkout charge
 * where", the same way Shopify opens "Taxes and duties" on its regions list.
 */
export const TAX_WORKSPACE_SECTIONS = [
  "rates",
  "classes",
  "settings",
  "classification",
] as const;

export type TaxWorkspaceSection = (typeof TAX_WORKSPACE_SECTIONS)[number];

export const DEFAULT_TAX_WORKSPACE_SECTION: TaxWorkspaceSection = "rates";

/**
 * `?section=` values the route still accepts. The pre-redesign names stay in
 * this list so saved links, bookmarks, and readiness targets keep working:
 * `policy` became `settings`, and `preview` became a side sheet opened on top
 * of the rates tab rather than a tab of its own.
 */
export const TAX_WORKSPACE_ROUTE_SECTIONS = [
  "settings",
  "policy",
  "classes",
  "rates",
  "classification",
  "preview",
] as const;

export type TaxWorkspaceRouteSection =
  (typeof TAX_WORKSPACE_ROUTE_SECTIONS)[number];

export interface TaxWorkspaceTarget {
  section: TaxWorkspaceSection;
  /** The calculation preview opens as a sheet over the resolved tab. */
  preview: boolean;
}

const ROUTE_SECTION_TARGETS: Record<
  TaxWorkspaceRouteSection,
  TaxWorkspaceTarget
> = {
  settings: { section: "settings", preview: false },
  policy: { section: "settings", preview: false },
  classes: { section: "classes", preview: false },
  rates: { section: "rates", preview: false },
  classification: { section: "classification", preview: false },
  preview: { section: "rates", preview: true },
};

function isRouteSection(value: unknown): value is TaxWorkspaceRouteSection {
  return (
    typeof value === "string"
    && (TAX_WORKSPACE_ROUTE_SECTIONS as readonly string[]).includes(value)
  );
}

/**
 * Resolves any accepted `?section=` value to the tab that renders it and
 * whether the calculation preview should open with it.
 */
export function resolveTaxWorkspaceTarget(value: unknown): TaxWorkspaceTarget {
  const target = isRouteSection(value)
    ? ROUTE_SECTION_TARGETS[value]
    : { section: DEFAULT_TAX_WORKSPACE_SECTION, preview: false };
  return { ...target };
}

export function normalizeTaxWorkspaceSection(
  value: unknown,
): TaxWorkspaceSection {
  return resolveTaxWorkspaceTarget(value).section;
}

/**
 * The preview sheet is open when the search carries `preview`, or when a saved
 * link still points at the retired `section=preview` tab.
 */
export function normalizeTaxWorkspacePreview(
  search: Record<string, unknown>,
): boolean {
  if (resolveTaxWorkspaceTarget(search.section).preview) return true;
  const raw = search.preview;
  return raw === true || raw === "true" || raw === "1" || raw === 1;
}
