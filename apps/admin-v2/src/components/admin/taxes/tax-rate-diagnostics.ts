import type {
  TaxConfigurationPayload,
  TaxJurisdictionType,
  TaxRateRecord,
} from "@/lib/api-functions/taxes";

const MAX_VISIBLE_OVERLAPS = 8;

export type TaxCoverageState = "all" | "scoped" | "none" | "exempt";
export type TaxOverlapKind = "same-scope" | "all-with-scoped" | "nested-scope";

export interface TaxClassCoverageDiagnostic {
  classId: string;
  className: string;
  state: TaxCoverageState;
  roles: string[];
  activeRateCount: number;
  scopedDestinationCount: number;
  hasStacking: boolean;
  detail: string;
  needsBroadRate: boolean;
}

export interface TaxRateOverlapDiagnostic {
  id: string;
  kind: TaxOverlapKind;
  classId: string;
  className: string;
  title: string;
  detail: string;
  rateIds: string[];
}

export interface TaxRateDiagnostics {
  coverage: TaxClassCoverageDiagnostic[];
  overlaps: TaxRateOverlapDiagnostic[];
  overlapCount: number;
  hiddenOverlapCount: number;
}

export interface TaxRateDraftCandidate {
  taxClassId: string;
  jurisdictionType: TaxJurisdictionType;
  jurisdictionId: string | null;
  priority: number;
  isActive: boolean;
}

export interface TaxRateDraftOverlap {
  count: number;
  rateNames: string[];
  detail: string;
}

interface ScopeGroup {
  key: string;
  type: TaxJurisdictionType;
  id: string | null;
  label: string;
  rates: TaxRateRecord[];
}

type JurisdictionMap = Map<string, TaxConfigurationPayload["jurisdictions"][number]>;

function activeRatesForClass(
  configuration: TaxConfigurationPayload,
  classId: string,
): TaxRateRecord[] {
  return configuration.rates.filter(
    (rate) => rate.taxClassId === classId && rate.isActive && rate.deletedAt === null,
  );
}

function scopeKey(type: TaxJurisdictionType, id: string | null): string {
  return type === "all" ? "all" : `${type}:${id ?? "missing"}`;
}

function scopeLabel(
  type: TaxJurisdictionType,
  id: string | null,
  jurisdictions: JurisdictionMap,
  fallback?: string | null,
): string {
  if (type === "all") return "All destinations";
  return (id ? jurisdictions.get(id)?.name : null)
    ?? fallback
    ?? `${type[0]?.toUpperCase()}${type.slice(1)} destination`;
}

function groupRates(
  rates: TaxRateRecord[],
  jurisdictions: JurisdictionMap,
): ScopeGroup[] {
  const groups = new Map<string, ScopeGroup>();
  for (const rate of rates) {
    const key = scopeKey(rate.jurisdictionType, rate.jurisdictionId);
    const group = groups.get(key);
    if (group) {
      group.rates.push(rate);
      continue;
    }
    groups.set(key, {
      key,
      type: rate.jurisdictionType,
      id: rate.jurisdictionId,
      label: scopeLabel(
        rate.jurisdictionType,
        rate.jurisdictionId,
        jurisdictions,
        rate.jurisdictionLabel,
      ),
      rates: [rate],
    });
  }
  return [...groups.values()];
}

function priorityDetail(rates: TaxRateRecord[]): string {
  const priorities = [...new Set(rates.map((rate) => rate.priority))].sort((a, b) => a - b);
  if (priorities.length === 1) {
    return `They apply together in priority ${priorities[0] ?? 0}.`;
  }
  return `They apply from priority ${priorities[0]} to ${priorities.at(-1)}; a compound rate can include completed earlier priorities.`;
}

function sampleRateIds(groups: ScopeGroup[]): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    for (const rate of group.rates) {
      ids.push(rate.id);
      if (ids.length === 3) return ids;
    }
  }
  return ids;
}

function parentGroups(
  group: ScopeGroup,
  groupsByKey: Map<string, ScopeGroup>,
  jurisdictions: JurisdictionMap,
): ScopeGroup[] {
  if (!group.id || group.type === "all") return [];
  const parents: ScopeGroup[] = [];
  const seen = new Set<string>([group.id]);
  let parentId = jurisdictions.get(group.id)?.parentId ?? null;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = jurisdictions.get(parentId);
    if (!parent) break;
    const parentGroup = groupsByKey.get(scopeKey(parent.type, parent.id));
    if (parentGroup) parents.push(parentGroup);
    parentId = parent.parentId;
  }
  return parents;
}

function scopesOverlap(
  left: Pick<TaxRateRecord, "jurisdictionType" | "jurisdictionId">,
  right: Pick<TaxRateRecord, "jurisdictionType" | "jurisdictionId">,
  jurisdictions: JurisdictionMap,
): boolean {
  if (left.jurisdictionType === "all" || right.jurisdictionType === "all") return true;
  if (!left.jurisdictionId || !right.jurisdictionId) return false;
  if (left.jurisdictionType === right.jurisdictionType) {
    return left.jurisdictionId === right.jurisdictionId;
  }

  const isAncestor = (ancestorId: string, descendantId: string): boolean => {
    const seen = new Set<string>([descendantId]);
    let parentId = jurisdictions.get(descendantId)?.parentId ?? null;
    while (parentId && !seen.has(parentId)) {
      if (parentId === ancestorId) return true;
      seen.add(parentId);
      parentId = jurisdictions.get(parentId)?.parentId ?? null;
    }
    return false;
  };

  return isAncestor(left.jurisdictionId, right.jurisdictionId)
    || isAncestor(right.jurisdictionId, left.jurisdictionId);
}

function configuredRoles(configuration: TaxConfigurationPayload, classId: string): string[] {
  const roles: string[] = [];
  if (configuration.settings.defaultTaxClassId === classId) roles.push("default products");
  const shippingClassId = configuration.settings.taxShipping
    ? configuration.settings.shippingTaxClassId ?? configuration.settings.defaultTaxClassId
    : null;
  if (shippingClassId === classId) roles.push("shipping");
  return roles;
}

function coverageDiagnostic(
  configuration: TaxConfigurationPayload,
  classId: string,
  className: string,
  isExempt: boolean,
  activeRates: TaxRateRecord[],
  jurisdictions: JurisdictionMap,
): TaxClassCoverageDiagnostic {
  const groups = groupRates(activeRates, jurisdictions);
  const hasAllDestinationRate = groups.some((group) => group.type === "all");
  const scopedDestinationCount = groups.filter((group) => group.type !== "all").length;
  const roles = configuredRoles(configuration, classId);
  const roleCopy = roles.length > 0 ? ` Used for ${roles.join(" and ")}.` : "";

  if (isExempt) {
    return {
      classId,
      className,
      state: "exempt",
      roles,
      activeRateCount: activeRates.length,
      scopedDestinationCount,
      hasStacking: false,
      detail: `Exempt items stay at zero tax in every destination.${roleCopy}`,
      needsBroadRate: false,
    };
  }
  if (hasAllDestinationRate) {
    return {
      classId,
      className,
      state: "all",
      roles,
      activeRateCount: activeRates.length,
      scopedDestinationCount,
      hasStacking: false,
      detail: `Every destination matches. More-specific matching rates are added too.${roleCopy}`,
      needsBroadRate: false,
    };
  }
  if (scopedDestinationCount > 0) {
    return {
      classId,
      className,
      state: "scoped",
      roles,
      activeRateCount: activeRates.length,
      scopedDestinationCount,
      hasStacking: false,
      detail: `${scopedDestinationCount} saved ${scopedDestinationCount === 1 ? "destination matches" : "destinations match"}; every other destination receives zero tax.${roleCopy}`,
      needsBroadRate: true,
    };
  }
  return {
    classId,
    className,
    state: "none",
    roles,
    activeRateCount: 0,
    scopedDestinationCount: 0,
    hasStacking: false,
    detail: `No active rate. Items assigned to this class receive zero tax.${roleCopy}`,
    needsBroadRate: true,
  };
}

export function getTaxRateDiagnostics(
  configuration: TaxConfigurationPayload,
): TaxRateDiagnostics {
  const jurisdictions: JurisdictionMap = new Map(
    configuration.jurisdictions.map((jurisdiction) => [jurisdiction.id, jurisdiction]),
  );
  const activeRatesByClass = new Map<string, TaxRateRecord[]>();
  for (const rate of configuration.rates) {
    if (!rate.isActive || rate.deletedAt !== null) continue;
    const classRates = activeRatesByClass.get(rate.taxClassId);
    if (classRates) classRates.push(rate);
    else activeRatesByClass.set(rate.taxClassId, [rate]);
  }
  const overlaps: TaxRateOverlapDiagnostic[] = [];
  const classesWithStacking = new Set<string>();
  let overlapCount = 0;
  const recordOverlap = (diagnostic: TaxRateOverlapDiagnostic) => {
    overlapCount += 1;
    classesWithStacking.add(diagnostic.classId);
    if (overlaps.length < MAX_VISIBLE_OVERLAPS) overlaps.push(diagnostic);
  };

  for (const taxClass of configuration.classes) {
    if (taxClass.isExempt) continue;
    const activeRates = activeRatesByClass.get(taxClass.id) ?? [];
    const groups = groupRates(activeRates, jurisdictions);
    const groupsByKey = new Map(groups.map((group) => [group.key, group]));
    const allGroup = groupsByKey.get("all");
    const scopedGroups = groups.filter((group) => group.type !== "all");

    for (const group of groups) {
      if (group.rates.length < 2) continue;
      recordOverlap({
        id: `${taxClass.id}:same:${group.key}`,
        kind: "same-scope",
        classId: taxClass.id,
        className: taxClass.name,
        title: `${group.rates.length} active rates share ${group.label}`,
        detail: `${priorityDetail(group.rates)} Review duplicates, then test this destination.`,
        rateIds: group.rates.slice(0, 3).map((rate) => rate.id),
      });
    }

    if (allGroup && scopedGroups.length > 0) {
      const scopedRateCount = scopedGroups.reduce((sum, group) => sum + group.rates.length, 0);
      recordOverlap({
        id: `${taxClass.id}:all-with-scoped`,
        kind: "all-with-scoped",
        classId: taxClass.id,
        className: taxClass.name,
        title: `Broad and local rates stack for ${taxClass.name}`,
        detail: `${allGroup.rates.length} all-destination ${allGroup.rates.length === 1 ? "rate applies" : "rates apply"} everywhere. On ${scopedGroups.length} saved ${scopedGroups.length === 1 ? "destination" : "destinations"}, ${scopedRateCount} local ${scopedRateCount === 1 ? "rate is" : "rates are"} added too.`,
        rateIds: sampleRateIds([allGroup, ...scopedGroups]),
      });
    }

    for (const group of scopedGroups) {
      for (const parentGroup of parentGroups(group, groupsByKey, jurisdictions)) {
        const combinedRates = [...parentGroup.rates, ...group.rates];
        recordOverlap({
          id: `${taxClass.id}:nested:${parentGroup.key}:${group.key}`,
          kind: "nested-scope",
          classId: taxClass.id,
          className: taxClass.name,
          title: `${parentGroup.label} and ${group.label} rates stack`,
          detail: `A checkout in ${group.label} matches both locations for ${taxClass.name}. ${priorityDetail(combinedRates)}`,
          rateIds: combinedRates.slice(0, 3).map((rate) => rate.id),
        });
      }
    }
  }

  const coverage = configuration.classes.map((taxClass) => ({
    ...coverageDiagnostic(
      configuration,
      taxClass.id,
      taxClass.name,
      taxClass.isExempt,
      activeRatesByClass.get(taxClass.id) ?? [],
      jurisdictions,
    ),
    hasStacking: classesWithStacking.has(taxClass.id),
  }));
  return {
    coverage,
    overlaps,
    overlapCount,
    hiddenOverlapCount: Math.max(0, overlapCount - overlaps.length),
  };
}

export function getTaxRateDraftOverlap(
  configuration: TaxConfigurationPayload,
  candidate: TaxRateDraftCandidate,
  editingRateId: string | null,
): TaxRateDraftOverlap | null {
  if (!candidate.isActive || !candidate.taxClassId) return null;
  const taxClass = configuration.classes.find((item) => item.id === candidate.taxClassId);
  if (!taxClass || taxClass.isExempt) return null;
  const jurisdictions: JurisdictionMap = new Map(
    configuration.jurisdictions.map((jurisdiction) => [jurisdiction.id, jurisdiction]),
  );
  const overlappingRates = activeRatesForClass(configuration, candidate.taxClassId).filter(
    (rate) => rate.id !== editingRateId && scopesOverlap(candidate, rate, jurisdictions),
  );
  if (overlappingRates.length === 0) return null;

  const samePriorityCount = overlappingRates.filter(
    (rate) => rate.priority === candidate.priority,
  ).length;
  const sampledNames = overlappingRates.slice(0, 3).map((rate) => rate.name);
  const extraCount = overlappingRates.length - sampledNames.length;
  const names = `${sampledNames.join(", ")}${extraCount > 0 ? `, and ${extraCount} more` : ""}`;
  const layerCopy = samePriorityCount > 0
    ? `${samePriorityCount} ${samePriorityCount === 1 ? "rate shares" : "rates share"} priority ${candidate.priority} and will use the same calculation layer.`
    : "Their priorities determine calculation order; compound rates can include completed earlier priorities.";
  return {
    count: overlappingRates.length,
    rateNames: sampledNames,
    detail: `This active rate will apply together with ${names} on matching destinations. ${layerCopy}`,
  };
}
