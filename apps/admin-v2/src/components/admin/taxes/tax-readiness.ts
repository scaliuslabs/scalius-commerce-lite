import type { TaxConfigurationPayload } from "@/lib/api-functions/taxes";

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

export function getTaxReadiness(configuration: TaxConfigurationPayload): TaxReadiness {
  const defaultClass = configuration.classes.find(
    (taxClass) => taxClass.id === configuration.settings.defaultTaxClassId,
  );
  const activeDefaultRates = defaultClass
    ? configuration.rates.filter(
        (rate) => rate.isActive && rate.taxClassId === defaultClass.id,
      )
    : [];
  const defaultClassReady = Boolean(defaultClass);
  const defaultRatesReady = Boolean(defaultClass?.isExempt || activeDefaultRates.length > 0);
  const effectiveShippingClassId = configuration.settings.taxShipping
    ? configuration.settings.shippingTaxClassId ?? configuration.settings.defaultTaxClassId
    : null;
  const shippingClass = effectiveShippingClassId
    ? configuration.classes.find((taxClass) => taxClass.id === effectiveShippingClassId)
    : null;
  const activeShippingRates = shippingClass
    ? configuration.rates.filter(
        (rate) => rate.isActive && rate.taxClassId === shippingClass.id,
      )
    : [];
  const shippingRatesReady = !configuration.settings.taxShipping || Boolean(
    shippingClass?.isExempt || activeShippingRates.length > 0,
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
      label: "Active default-class rates",
      detail: defaultClass?.isExempt
        ? `${defaultClass.name} is exempt and does not require a rate.`
        : activeDefaultRates.length > 0
          ? `${activeDefaultRates.length} active ${activeDefaultRates.length === 1 ? "rate" : "rates"}`
          : "Add a verified destination rate before collecting tax.",
      ready: defaultRatesReady,
    },
    ...(configuration.settings.taxShipping ? [{
      id: "shipping-rates" as const,
      label: "Active shipping-class rates",
      detail: shippingClass?.isExempt
        ? `${shippingClass.name} is exempt and does not require a rate.`
        : activeShippingRates.length > 0
          ? `${activeShippingRates.length} active ${activeShippingRates.length === 1 ? "rate" : "rates"}`
          : "Add a verified shipping rate before collecting tax on delivery.",
      ready: shippingRatesReady,
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
    return {
      state: "off",
      title: "Tax calculation is off",
      description: "Your class and rate setup is ready, but checkout continues to record zero tax until you enable calculation.",
      nextTab: "policy",
      nextAction: "Review policy",
      steps,
    };
  }

  return {
    state: "ready",
    title: "Tax calculation is ready",
    description: "Checkout uses the saved default class and destination rates. Run a preview after changing tax rules.",
    nextTab: "preview",
    nextAction: "Test calculation",
    steps,
  };
}
