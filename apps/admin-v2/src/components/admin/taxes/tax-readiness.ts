import type { TaxConfigurationPayload, TaxRateRecord } from "@/lib/api-functions/taxes";

export type TaxWorkspaceTab = "policy" | "classes" | "rates" | "classification" | "preview";

export interface TaxReadinessStep {
  id: "default-class" | "rates" | "shipping-rates" | "calculation";
  label: string;
  detail: string;
  ready: boolean;
}

export interface TaxReadiness {
  state: "off" | "attention" | "ready";
  title: string;
  description: string;
  nextTab: TaxWorkspaceTab;
  nextAction: string;
  steps: TaxReadinessStep[];
}

export type RequiredTaxRateRole = "default products" | "shipping";

type TaxDestinationCoverage = "exempt" | "all" | "scoped" | "none";

interface TaxClassCoverage {
  activeRateCount: number;
  coverage: TaxDestinationCoverage;
  scopedDestinationCount: number;
  hasLayeredRates: boolean;
}

function getTaxClassCoverage(
  configuration: TaxConfigurationPayload,
  taxClassId: string | null | undefined,
): TaxClassCoverage {
  const taxClass = configuration.classes.find((candidate) => candidate.id === taxClassId);
  if (taxClass?.isExempt) {
    return {
      activeRateCount: 0,
      coverage: "exempt",
      scopedDestinationCount: 0,
      hasLayeredRates: false,
    };
  }

  const activeRates = configuration.rates.filter(
    (rate) => rate.isActive && rate.deletedAt === null && rate.taxClassId === taxClassId,
  );
  const allDestinationRates = activeRates.filter(
    (rate) => rate.jurisdictionType === "all" && rate.jurisdictionId === null,
  );
  const scopedDestinations = new Set(
    activeRates
      .filter((rate) => rate.jurisdictionType !== "all" && rate.jurisdictionId)
      .map((rate) => `${rate.jurisdictionType}:${rate.jurisdictionId}`),
  );

  return {
    activeRateCount: activeRates.length,
    coverage: allDestinationRates.length > 0
      ? "all"
      : scopedDestinations.size > 0
        ? "scoped"
        : "none",
    scopedDestinationCount: scopedDestinations.size,
    // All-destination rates and exact destination rates are cumulative in the
    // calculator. Keep that fact visible without attempting to infer legal
    // jurisdiction hierarchy from labels.
    hasLayeredRates: allDestinationRates.length > 1
      || (allDestinationRates.length > 0 && scopedDestinations.size > 0),
  };
}

function coverageDetail(
  taxClassName: string,
  coverage: TaxClassCoverage,
): string {
  if (coverage.coverage === "exempt") {
    return `${taxClassName} is exempt; every destination resolves to zero tax.`;
  }
  if (coverage.coverage === "all") {
    const rateCount = `${coverage.activeRateCount} active ${coverage.activeRateCount === 1 ? "rate" : "rates"}`;
    return coverage.hasLayeredRates
      ? `${rateCount}; all destinations are covered and matching rates apply together.`
      : `${rateCount}; an all-destination rate covers every checkout destination.`;
  }
  if (coverage.coverage === "scoped") {
    const destinationCount = `${coverage.scopedDestinationCount} exact saved ${coverage.scopedDestinationCount === 1 ? "destination" : "destinations"}`;
    return `${destinationCount}; every other destination receives zero tax for this class.`;
  }
  return "Add a verified destination rate before collecting tax.";
}

export function getRequiredTaxRateRoles(
  configuration: TaxConfigurationPayload,
  rate: TaxRateRecord | null,
): RequiredTaxRateRole[] {
  if (!configuration.settings.enabled || !rate?.isActive) return [];

  const taxClass = configuration.classes.find(
    (candidate) => candidate.id === rate.taxClassId,
  );
  if (!taxClass || taxClass.isExempt) return [];

  const activeClassRates = configuration.rates.filter(
    (candidate) => candidate.isActive && candidate.taxClassId === rate.taxClassId,
  );
  if (activeClassRates.length !== 1 || activeClassRates[0]?.id !== rate.id) return [];

  const roles: RequiredTaxRateRole[] = [];
  if (configuration.settings.defaultTaxClassId === rate.taxClassId) {
    roles.push("default products");
  }
  const effectiveShippingClassId = configuration.settings.taxShipping
    ? configuration.settings.shippingTaxClassId ?? configuration.settings.defaultTaxClassId
    : null;
  if (effectiveShippingClassId === rate.taxClassId) roles.push("shipping");
  return roles;
}

export function getTaxReadiness(configuration: TaxConfigurationPayload): TaxReadiness {
  const defaultClass = configuration.classes.find(
    (taxClass) => taxClass.id === configuration.settings.defaultTaxClassId,
  );
  const defaultCoverage = getTaxClassCoverage(configuration, defaultClass?.id);
  const defaultClassReady = Boolean(defaultClass);
  const defaultRatesReady = defaultCoverage.coverage !== "none";
  const effectiveShippingClassId = configuration.settings.taxShipping
    ? configuration.settings.shippingTaxClassId ?? configuration.settings.defaultTaxClassId
    : null;
  const shippingClass = effectiveShippingClassId
    ? configuration.classes.find((taxClass) => taxClass.id === effectiveShippingClassId)
    : null;
  const shippingCoverage = getTaxClassCoverage(configuration, shippingClass?.id);
  const shippingRatesReady = !configuration.settings.taxShipping || Boolean(
    shippingCoverage.coverage !== "none",
  );
  const calculationReady = configuration.settings.enabled
    && defaultClassReady
    && defaultRatesReady
    && shippingRatesReady;

  const steps: TaxReadinessStep[] = [
    {
      id: "default-class",
      label: "Default product class",
      detail: defaultClass ? defaultClass.name : "Choose the fallback class for unclassified products.",
      ready: defaultClassReady,
    },
    {
      id: "rates",
      label: "Product destination coverage",
      detail: defaultClass
        ? coverageDetail(defaultClass.name, defaultCoverage)
        : "Choose a default class before reviewing destination coverage.",
      ready: defaultCoverage.coverage === "all" || defaultCoverage.coverage === "exempt",
    },
    ...(configuration.settings.taxShipping ? [{
      id: "shipping-rates" as const,
      label: "Shipping destination coverage",
      detail: shippingClass
        ? coverageDetail(shippingClass.name, shippingCoverage)
        : "Choose an effective shipping class before reviewing destination coverage.",
      ready: shippingCoverage.coverage === "all" || shippingCoverage.coverage === "exempt",
    }] : []),
    {
      id: "calculation",
      label: "Checkout calculation",
      detail: configuration.settings.enabled
        ? calculationReady
          ? "Checkout uses the saved tax configuration."
          : "Enabled, but setup is incomplete and needs attention."
        : "Off — checkout records zero tax.",
      ready: calculationReady,
    },
  ];

  if (!defaultClassReady) {
    return {
      state: configuration.settings.enabled ? "attention" : "off",
      title: configuration.settings.enabled ? "Tax setup needs attention" : "Tax calculation is off",
      description: configuration.settings.enabled
        ? "Choose a default class so checkout can resolve unclassified products."
        : "Checkout records zero tax. Choose a default class before turning calculation on.",
      nextTab: "policy",
      nextAction: "Choose default class",
      steps,
    };
  }

  if (!defaultRatesReady) {
    return {
      state: configuration.settings.enabled ? "attention" : "off",
      title: configuration.settings.enabled ? "Tax setup needs attention" : "Tax calculation is off",
      description: configuration.settings.enabled
        ? "The default class has no active rate, so matching checkout amounts receive zero tax."
        : "Checkout records zero tax. Add a verified rate before turning calculation on.",
      nextTab: "rates",
      nextAction: "Add an active rate",
      steps,
    };
  }

  if (!shippingRatesReady) {
    return {
      state: configuration.settings.enabled ? "attention" : "off",
      title: configuration.settings.enabled ? "Tax setup needs attention" : "Tax calculation is off",
      description: configuration.settings.enabled
        ? "The effective shipping class has no active rate, so delivery charges receive zero tax."
        : "Checkout records zero tax. Add a verified shipping rate before turning calculation on.",
      nextTab: "rates",
      nextAction: "Add a shipping rate",
      steps,
    };
  }

  if (!configuration.settings.enabled) {
    const hasScopedCoverage = defaultCoverage.coverage === "scoped"
      || (configuration.settings.taxShipping && shippingCoverage.coverage === "scoped");
    return {
      state: "off",
      title: "Tax calculation is off",
      description: hasScopedCoverage
        ? "Checkout records zero tax while disabled. Saved rates cover selected destinations only; every other destination would remain untaxed after enabling."
        : "Your class and all-destination coverage pass lifecycle checks, but checkout continues to record zero tax until you enable calculation.",
      nextTab: hasScopedCoverage ? "rates" : "policy",
      nextAction: hasScopedCoverage ? "Review coverage" : "Review policy",
      steps,
    };
  }

  const productCoverageIsGlobal = defaultCoverage.coverage === "all"
    || defaultCoverage.coverage === "exempt";
  const shippingCoverageIsGlobal = !configuration.settings.taxShipping
    || shippingCoverage.coverage === "all"
    || shippingCoverage.coverage === "exempt";
  if (!productCoverageIsGlobal || !shippingCoverageIsGlobal) {
    const scopedRoles = [
      !productCoverageIsGlobal ? "products" : null,
      !shippingCoverageIsGlobal ? "shipping" : null,
    ].filter(Boolean).join(" and ");
    return {
      state: "attention",
      title: "Tax is live for selected destinations",
      description: `Lifecycle checks pass, but ${scopedRoles} have exact saved coverage only. Other destinations receive zero tax; matching destination scopes apply together.`,
      nextTab: "preview",
      nextAction: "Test destinations",
      steps,
    };
  }

  return {
    state: "ready",
    title: "Tax has all-destination coverage",
    description: "Lifecycle checks pass and each effective taxable class has an all-destination rate. Any matching scoped rates apply together, so preview layered destinations after changes.",
    nextTab: "preview",
    nextAction: "Test calculation",
    steps,
  };
}
