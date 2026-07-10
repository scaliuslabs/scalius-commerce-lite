import {
  createScaliusBrowserComputerAdapter,
  normalizeScaliusComputerRoute,
  ScaliusComputerController,
  type ScaliusComputerBinding,
  type ScaliusComputerRequest,
  type ScaliusComputerResult,
} from "@scalius/shared/assistant-computer";

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
  const adapter = createScaliusBrowserComputerAdapter({
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
  const controller = new ScaliusComputerController({ binding, adapter });
  return {
    binding,
    execute: (request) => controller.execute(request),
  };
}

export function isAllowedStorefrontComputerRoute(route: string): boolean {
  const normalized = normalizeScaliusComputerRoute(route);
  if (!normalized) return false;
  const pathname = decodeURIComponent(
    new URL(normalized, "https://storefront.invalid").pathname,
  );
  const firstSegment = pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  return firstSegment !== "admin" && firstSegment !== "api" &&
    firstSegment !== ".well-known" && firstSegment !== "cdn-cgi" &&
    !firstSegment.startsWith("_");
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
