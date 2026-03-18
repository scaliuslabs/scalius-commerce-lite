// src/modules/fraud-checker/index.ts
export {
  getFraudProviders,
  getFraudProvider,
  saveFraudProvider,
  deleteFraudProvider,
  testFraudProvider,
  fraudLookup,
  fraudLookupWithActiveProvider,
} from "./service";
export type { FraudCheckerProvider, FraudCheckResult } from "./service";
export type {
  FraudCheckProvider,
  FraudCheckResult as ProviderFraudCheckResult,
} from "./provider";
export {
  DefaultFraudCheckProvider,
  getFraudCheckProvider,
  registerFraudCheckProvider,
} from "./provider";
