import type { TaxConfigurationPayload, TaxRateRecord } from "@/lib/api-functions/taxes";
import {
  getTaxRateDiagnostics,
  type TaxClassCoverageDiagnostic,
} from "./tax-rate-diagnostics";

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

function coverageDetail(
  coverage: TaxClassCoverageDiagnostic | undefined,
): string {
  if (!coverage) return "Choose a class before reviewing destination coverage.";
  if (coverage.state === "exempt") {
    return `${coverage.className} is exempt; every destination resolves to zero tax.`;
  }
  if (coverage.state === "all") {
    const rateCount = `${coverage.activeRateCount} active ${coverage.activeRateCount === 1 ? "rate" : "rates"}`;
    return coverage.hasStacking
      ? `${rateCount}; all destinations are covered and matching rates apply together.`
      : `${rateCount}; an all-destination rate covers every checkout destination.`;
  }
  if (coverage.state === "scoped") {
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
  const rateDiagnostics = getTaxRateDiagnostics(configuration);
  const defaultClass = configuration.classes.find(
    (taxClass) => taxClass.id === configuration.settings.defaultTaxClassId,
  );
  const defaultCoverage = rateDiagnostics.coverage.find(
    (coverage) => coverage.classId === defaultClass?.id,
  );
  const defaultClassReady = Boolean(defaultClass);
  const defaultRatesReady = Boolean(defaultCoverage && defaultCoverage.state !== "none");
  const effectiveShippingClassId = configuration.settings.taxShipping
    ? configuration.settings.shippingTaxClassId ?? configuration.settings.defaultTaxClassId
    : null;
  const shippingClass = effectiveShippingClassId
    ? configuration.classes.find((taxClass) => taxClass.id === effectiveShippingClassId)
    : null;
  const shippingCoverage = rateDiagnostics.coverage.find(
    (coverage) => coverage.classId === shippingClass?.id,
  );
  const shippingRatesReady = !configuration.settings.taxShipping || Boolean(
    shippingCoverage && shippingCoverage.state !== "none",
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
      detail: coverageDetail(defaultCoverage),
      ready: defaultCoverage?.state === "all" || defaultCoverage?.state === "exempt",
    },
    ...(configuration.settings.taxShipping ? [{
      id: "shipping-rates" as const,
      label: "Shipping destination coverage",
      detail: shippingClass
        ? coverageDetail(shippingCoverage)
        : "Choose an effective shipping class before reviewing destination coverage.",
      ready: shippingCoverage?.state === "all" || shippingCoverage?.state === "exempt",
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
    const hasScopedCoverage = defaultCoverage?.state === "scoped"
      || (configuration.settings.taxShipping && shippingCoverage?.state === "scoped");
    return {
      state: "off",
      title: "Tax calculation is off",
      description: hasScopedCoverage
        ? "Checkout records zero tax while disabled. Saved rates cover selected destinations only; every other destination would remain untaxed after enabling."
        : "Your saved classes and rates cover all destinations, but checkout continues to record zero tax until you enable calculation.",
      nextTab: hasScopedCoverage ? "rates" : "policy",
      nextAction: hasScopedCoverage ? "Review coverage" : "Review policy",
      steps,
    };
  }

  const productCoverageIsGlobal = defaultCoverage?.state === "all"
    || defaultCoverage?.state === "exempt";
  const shippingCoverageIsGlobal = !configuration.settings.taxShipping
    || shippingCoverage?.state === "all"
    || shippingCoverage?.state === "exempt";
  if (!productCoverageIsGlobal || !shippingCoverageIsGlobal) {
    const scopedRoles = [
      !productCoverageIsGlobal ? "products" : null,
      !shippingCoverageIsGlobal ? "shipping" : null,
    ].filter(Boolean).join(" and ");
    return {
      state: "attention",
      title: "Tax is live for selected destinations",
      description: `Tax is on, but ${scopedRoles} only match selected saved destinations. Other destinations receive zero tax; matching destination rates are added together.`,
      nextTab: "preview",
      nextAction: "Test destinations",
      steps,
    };
  }

  return {
    state: "ready",
    title: "Tax has all-destination coverage",
    description: "Every destination matches a rate for each taxable class in use. Any more-specific matching rates are added too, so preview layered destinations after changes.",
    nextTab: "preview",
    nextAction: "Test calculation",
    steps,
  };
}
