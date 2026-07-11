import {
  createScaliusBrowserComputerAdapter,
  normalizeScaliusComputerRoute,
  parseScaliusComputerProgram,
  ScaliusComputerController,
  type ScaliusComputerAdapterAction,
  type ScaliusComputerBinding,
  type ScaliusComputerPageAdapter,
  type ScaliusComputerRequest,
  type ScaliusComputerResult,
  type ScaliusComputerTarget,
} from "@scalius/shared/assistant-computer";

const COMMERCE_CONTROL_HINT =
  /\b(?:add(?: this| item)? to (?:cart|bag)|buy now|quick buy|open (?:shopping )?(?:cart|bag)|view (?:my )?cart|go to cart|checkout|place order|pay now|clear (?:the )?cart|remove .+ from (?:cart|bag))\b/iu;

export interface StorefrontAssistantComputerRuntimeOptions {
  threadId: string;
  tabId: string;
  document?: Document;
  navigate?: (route: string) => void | Promise<void>;
  refresh?: () => void | Promise<void>;
  isActive?: () => boolean;
}

export interface StorefrontAssistantComputerRuntime {
  readonly binding: Readonly<ScaliusComputerBinding>;
  execute(request: ScaliusComputerRequest): Promise<ScaliusComputerResult>;
  /** Invalidates the current execution before Stop crosses an async boundary. */
  cancelPending(): void;
}

export function createStorefrontAssistantComputerRuntime(
  options: StorefrontAssistantComputerRuntimeOptions,
): StorefrontAssistantComputerRuntime {
  const pageDocument = resolveDocument(options.document);
  const pageWindow = pageDocument.defaultView;
  if (!pageWindow || !/^https?:$/.test(pageWindow.location.protocol)) {
    throw new Error("Storefront computer requires an http(s) browser document");
  }
  const binding = Object.freeze<ScaliusComputerBinding>({
    surface: "storefront",
    threadId: options.threadId,
    tabId: options.tabId,
  });
  const browserAdapter = createScaliusBrowserComputerAdapter({
    document: pageDocument,
    origin: pageWindow.location.origin,
    currentRoute: () => currentRoute(pageWindow.location),
    goto: options.navigate ?? ((route) => pageWindow.location.assign(route)),
    refresh: options.refresh ?? (() => pageWindow.location.reload()),
    allowsRoute: isAllowedStorefrontComputerRoute,
    isActive: options.isActive ?? (() => pageDocument.visibilityState !== "hidden"),
    textMode: "semantic",
    maxTargets: 64,
    maxTextNodes: 48,
  });
  let cancellationGeneration = 0;
  let activeGeneration: number | null = null;
  const executionIsCurrent = () =>
    activeGeneration !== null && activeGeneration === cancellationGeneration;
  const adapter: ScaliusComputerPageAdapter = {
    ...browserAdapter,
    async act(action: ScaliusComputerAdapterAction) {
      if (!executionIsCurrent()) {
        return { ok: false, code: "EXECUTION_FAILED" };
      }
      const target = browserAdapter
        .capture()
        .targets.find((candidate) => candidate.id === action.targetId);
      if (target && isBlockedCommerceControl(target)) {
        return { ok: false, code: "HUMAN_REQUIRED" };
      }
      return browserAdapter.act(action);
    },
    async goto(route: string) {
      if (!executionIsCurrent()) throw new Error("Computer execution cancelled");
      await browserAdapter.goto(route);
    },
    async refresh() {
      if (!executionIsCurrent()) throw new Error("Computer execution cancelled");
      await browserAdapter.refresh();
    },
  };
  const controller = new ScaliusComputerController({ binding, adapter });
  return {
    binding,
    async execute(request) {
      const generation = cancellationGeneration;
      const ownsActiveGeneration = activeGeneration === null;
      if (ownsActiveGeneration) activeGeneration = generation;
      try {
        if (!bindingMatches(binding, request.binding)) {
          return await controller.execute(request);
        }
        const parsed = parseScaliusComputerProgram(request.program);
        const command = parsed.ok ? parsed.commands[0]?.name : undefined;
        if (
          command && command !== "goto" && command !== "help" && command !== "refresh" &&
          isSensitiveStorefrontComputerRoute(currentRoute(pageWindow.location))
        ) {
          return {
            ok: false,
            code: "HUMAN_REQUIRED",
            output: "This buyer page is private. Use the page directly; computer access is unavailable here.",
            retryable: false,
          };
        }
        const result = await controller.execute(request);
        if (generation !== cancellationGeneration) {
          return {
            ok: false,
            code: "EXECUTION_FAILED",
            output: "The page command was stopped before it finished.",
            retryable: false,
          };
        }
        return result;
      } finally {
        if (ownsActiveGeneration && activeGeneration === generation) {
          activeGeneration = null;
        }
      }
    },
    cancelPending() {
      cancellationGeneration += 1;
    },
  };
}

export function isAllowedStorefrontComputerRoute(route: string): boolean {
  const normalized = normalizeScaliusComputerRoute(route);
  if (!normalized) return false;
  const parsed = new URL(normalized, "https://storefront.invalid");
  if (hasSensitiveQueryKey(parsed)) return false;
  const pathname = decodeURIComponent(parsed.pathname);
  const firstSegment = pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  return firstSegment !== "admin" && firstSegment !== "api" &&
    firstSegment !== ".well-known" && firstSegment !== "cdn-cgi" &&
    !firstSegment.startsWith("_") &&
    !isForbiddenStorefrontNavigationPath(pathname);
}

export function isSensitiveStorefrontComputerRoute(route: string): boolean {
  const normalized = normalizeScaliusComputerRoute(route);
  if (!normalized) return true;
  const parsed = new URL(normalized, "https://storefront.invalid");
  if (hasSensitiveQueryKey(parsed)) return true;
  return isRestrictedStorefrontControlPath(decodeURIComponent(parsed.pathname));
}

function isForbiddenStorefrontNavigationPath(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return normalized === "/checkout" || normalized.startsWith("/checkout/") ||
    normalized === "/buy" || normalized.startsWith("/buy/") ||
    normalized === "/account" || normalized.startsWith("/account/") ||
    normalized === "/order-success" || normalized.startsWith("/order-success/") ||
    normalized === "/payment-recovery" || normalized.startsWith("/payment-recovery/");
}

function isRestrictedStorefrontControlPath(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return (
    normalized === "/cart" ||
    normalized.startsWith("/cart/") ||
    isForbiddenStorefrontNavigationPath(normalized)
  );
}

function isBlockedCommerceControl(target: ScaliusComputerTarget): boolean {
  if (isAllowedAddToCartTarget(target)) return false;
  if (target.humanOnly) return true;
  if (target.route) {
    try {
      const path = new URL(target.route, "https://storefront.invalid").pathname;
      if (isRestrictedStorefrontControlPath(decodeURIComponent(path))) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return (
    isAddToCartTargetName(target.name) ||
    COMMERCE_CONTROL_HINT.test(target.name)
  );
}

function isAllowedAddToCartTarget(
  target: ScaliusComputerTarget,
): boolean {
  return (
    target.humanOnly !== true &&
    target.explicitlyAllowed === true &&
    target.disabled !== true &&
    !target.route &&
    target.actions.length === 1 &&
    target.actions[0] === "click" &&
    isAddToCartTargetName(target.name)
  );
}

function isAddToCartTargetName(value: string): boolean {
  return /^add .+\b to cart$/u.test(normalizeControlName(value));
}

function normalizeControlName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function resolveDocument(provided?: Document): Document {
  if (provided) return provided;
  if (typeof document === "undefined") {
    throw new Error("Storefront computer requires a browser document");
  }
  return document;
}

function currentRoute(location: Location): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function hasSensitiveQueryKey(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) =>
    /(?:token|proof|receipt|otp|code|password|secret)/i.test(key)
  );
}

function bindingMatches(
  expected: Readonly<ScaliusComputerBinding>,
  actual: ScaliusComputerBinding,
): boolean {
  return expected.surface === actual.surface && expected.threadId === actual.threadId &&
    expected.tabId === actual.tabId;
}
