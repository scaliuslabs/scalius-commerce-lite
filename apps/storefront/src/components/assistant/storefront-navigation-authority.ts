import type { FlueConversationMessage, FlueConversationPart } from "@flue/sdk";
import {
  normalizeScaliusComputerRoute,
  parseScaliusComputerProgram,
} from "@scalius/shared/assistant-computer";
import { parseScaliusCommandProgram } from "@scalius/shared/assistant-command";

import { resolveStorefrontAssistantNavigationTarget } from "@/lib/assistant-page-context.client";

const MAX_CANDIDATES = 32;
const MAX_SCALIUS_KEYS = 160;
const MAX_SCALIUS_DEPTH = 6;

export interface StorefrontNavigationCandidate {
  route: string;
  label: string;
  source: "scalius" | "visible-page";
}

export interface StorefrontNavigationAuthority {
  latestUserText: string;
  candidates: readonly StorefrontNavigationCandidate[];
}

type StorefrontNavigationIntent = {
  destination: string;
  mode: "direct" | "discovery";
};

/** Build a short-lived navigation capability from the latest explicit shopper
 * request plus routes proven by authoritative Scalius output or the visible
 * page. Historical turns after an older user request never authorize a goto. */
export function buildStorefrontNavigationAuthority(input: {
  messages: readonly FlueConversationMessage[];
  messageIndex: number;
  partIndex: number;
  document: Document;
}): StorefrontNavigationAuthority {
  const latestUserIndex = findLatestUserIndex(
    input.messages,
    input.messageIndex,
  );
  const latestUser = input.messages[latestUserIndex];
  const candidates = [
    ...collectScaliusCandidates(
      input.messages,
      latestUserIndex,
      input.messageIndex,
      input.partIndex,
      input.document.defaultView?.location.origin ?? "",
    ),
    ...collectVisibleCandidates(input.document),
  ];
  return {
    latestUserText: latestUser ? messageText(latestUser) : "",
    candidates: dedupeCandidates(candidates),
  };
}

export function isAuthorizedStorefrontGoto(
  program: string,
  authority: StorefrontNavigationAuthority | undefined,
): boolean {
  const parsed = parseScaliusComputerProgram(program);
  const command = parsed.ok ? parsed.commands[0] : undefined;
  if (!command || command.name !== "goto") return true;
  if (!authority) return false;

  const target = normalizeScaliusComputerRoute(command.route);
  const intent = storefrontNavigationIntent(authority.latestUserText);
  if (!target || !intent) return false;
  const targetUrl = safeRouteUrl(target);

  const matchingRoutes = new Set<string>();
  for (const candidate of authority.candidates) {
    if (
      intent.mode === "discovery" &&
      targetUrl?.pathname !== "/search" &&
      candidate.source !== "scalius"
    ) {
      continue;
    }
    if (!candidateProvesTarget(candidate.route, target)) continue;
    if (!destinationMatchesCandidate(intent, target, candidate.label)) {
      continue;
    }
    matchingRoutes.add(target);
  }
  if (matchingRoutes.size !== 1) return false;

  // A results page is the non-arbitrary choice when several products match a
  // clear shopper query. The query must be an exact projection of the latest
  // request and the visible page must prove that this store owns /search.
  if (targetUrl?.pathname === "/search") {
    if (!isExactSearchDestination(target, intent)) return false;
    return authority.candidates.some((candidate) => {
      return (
        candidate.source === "scalius" &&
        isSameExactSearchRoute(candidate.route, target)
      );
    });
  }

  // Ambiguous language must not silently select one of several proven routes.
  const semanticMatches = new Set(
    authority.candidates
      .filter(
        (candidate) =>
          intent.mode !== "discovery" ||
          (candidate.source === "scalius" &&
            safeRouteUrl(candidate.route)?.pathname !== "/search"),
      )
      .filter((candidate) =>
        destinationMatchesCandidate(
          intent,
          candidate.route,
          candidate.label,
        ),
      )
      .map((candidate) => candidate.route),
  );
  if (semanticMatches.size > 1) {
    return false;
  }
  return true;
}

/** Return the exact route scope the browser may use for this command. For
 * direct goto, preserve the existing Scalius/visible-page provenance check.
 * For a revision-bound click, pre-authorize only one candidate route matching
 * the latest explicit shopper destination; the runtime still resolves the
 * clicked handle and compares its route before touching the DOM. */
export function getAuthorizedStorefrontNavigationRoutes(
  program: string,
  authority: StorefrontNavigationAuthority | undefined,
): string[] {
  const parsed = parseScaliusComputerProgram(program);
  const command = parsed.ok ? parsed.commands[0] : undefined;
  if (!command || !authority) return [];
  if (command.name === "goto") {
    const route = normalizeScaliusComputerRoute(command.route);
    return route && isAuthorizedStorefrontGoto(program, authority) ? [route] : [];
  }

  const matchingRoutes = new Set(
    authority.candidates
      .map((candidate) => normalizeScaliusComputerRoute(candidate.route))
      .filter((route): route is string => Boolean(route))
      .filter((route) =>
        isAuthorizedStorefrontGoto(`goto ${JSON.stringify(route)}`, authority),
      ),
  );
  return matchingRoutes.size === 1 ? [...matchingRoutes] : [];
}

function findLatestUserIndex(
  messages: readonly FlueConversationMessage[],
  throughIndex: number,
): number {
  for (
    let index = Math.min(throughIndex, messages.length - 1);
    index >= 0;
    index -= 1
  ) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function messageText(message: FlueConversationMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .trim()
    .slice(0, 2_000);
}

function collectScaliusCandidates(
  messages: readonly FlueConversationMessage[],
  afterUserIndex: number,
  throughMessageIndex: number,
  throughPartIndex: number,
  origin: string,
): StorefrontNavigationCandidate[] {
  if (afterUserIndex < 0 || !origin) return [];
  const candidates: StorefrontNavigationCandidate[] = [];
  for (
    let messageIndex = afterUserIndex + 1;
    messageIndex <= throughMessageIndex && candidates.length < MAX_CANDIDATES;
    messageIndex += 1
  ) {
    const message = messages[messageIndex];
    if (!message) continue;
    const partLimit =
      messageIndex === throughMessageIndex
        ? Math.min(throughPartIndex, message.parts.length)
        : message.parts.length;
    for (let partIndex = 0; partIndex < partLimit; partIndex += 1) {
      const part = message.parts[partIndex];
      if (!isAuthoritativeScaliusPart(part)) continue;
      const searchCandidate = authoritativeCatalogSearchCandidate(part, origin);
      if (searchCandidate) candidates.push(searchCandidate);
      collectRoutesFromValue(part.output, origin, candidates, 0, {
        count: 0,
      });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
  }
  return candidates;
}

function authoritativeCatalogSearchCandidate(
  part: Extract<FlueConversationPart, { type: "dynamic-tool" }> & {
    output: Record<string, unknown>;
  },
  origin: string,
): StorefrontNavigationCandidate | null {
  if (
    !isRecord(part.input) ||
    Object.keys(part.input).length !== 1 ||
    typeof part.input.program !== "string" ||
    !isRecord(part.output.data) ||
    part.output.data.command !== "call" ||
    !isRecord(part.output.data.capability) ||
    part.output.data.capability.id !== "catalog.search" ||
    !isRecord(part.output.data.result) ||
    !Array.isArray(part.output.data.result.products) ||
    part.output.data.result.products.length <= 1
  ) {
    return null;
  }
  const parsed = parseScaliusCommandProgram(part.input.program);
  if (
    !parsed.ok ||
    parsed.command.name !== "call" ||
    parsed.command.capabilityId !== "catalog.search"
  ) {
    return null;
  }
  const rawQuery = parsed.command.arguments.query;
  if (typeof rawQuery !== "string") return null;
  const query = rawQuery.trim();
  if (
    !query ||
    query.length > 120 ||
    Array.from(query).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return null;
  }
  const params = new URLSearchParams({ q: query });
  const route = resolveStorefrontAssistantNavigationTarget(
    `/search?${params.toString()}`,
    origin,
  );
  return route
    ? { route, label: `Search ${query}`, source: "scalius" }
    : null;
}

function isAuthoritativeScaliusPart(
  part: FlueConversationPart | undefined,
): part is Extract<FlueConversationPart, { type: "dynamic-tool" }> & {
  output: Record<string, unknown>;
} {
  if (
    !part ||
    part.type !== "dynamic-tool" ||
    part.toolName !== "scalius" ||
    part.state !== "output-available" ||
    !isRecord(part.output)
  ) {
    return false;
  }
  return part.output.ok === true && part.output.authoritative === true;
}

function collectRoutesFromValue(
  value: unknown,
  origin: string,
  candidates: StorefrontNavigationCandidate[],
  depth: number,
  budget: { count: number },
): void {
  if (
    depth > MAX_SCALIUS_DEPTH ||
    budget.count >= MAX_SCALIUS_KEYS ||
    candidates.length >= MAX_CANDIDATES
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectRoutesFromValue(entry, origin, candidates, depth + 1, budget);
      if (candidates.length >= MAX_CANDIDATES) return;
    }
    return;
  }
  if (!isRecord(value)) return;

  budget.count += Object.keys(value).length;
  const route =
    typeof value.route === "string"
      ? resolveStorefrontAssistantNavigationTarget(value.route, origin)
      : null;
  if (route) {
    const label = [value.name, value.title, value.slug]
      .find((candidate): candidate is string => typeof candidate === "string")
      ?.trim()
      .slice(0, 180);
    candidates.push({
      route,
      label: label || routeLabel(route),
      source: "scalius",
    });
  }
  for (const child of Object.values(value)) {
    collectRoutesFromValue(child, origin, candidates, depth + 1, budget);
    if (candidates.length >= MAX_CANDIDATES) return;
  }
}

function collectVisibleCandidates(
  document: Document,
): StorefrontNavigationCandidate[] {
  const origin = document.defaultView?.location.origin;
  if (!origin) return [];
  const candidates: StorefrontNavigationCandidate[] = [];
  const elements = document.querySelectorAll<
    HTMLAnchorElement | HTMLFormElement
  >("a[href], form[action]");
  for (const element of elements) {
    if (
      candidates.length >= MAX_CANDIDATES ||
      element.closest(
        "[data-scalius-computer-exclude], [inert], [hidden], [aria-hidden='true']",
      )
    ) {
      continue;
    }
    const target =
      element instanceof HTMLAnchorElement
        ? element.getAttribute("href")
        : element.getAttribute("action");
    const route = resolveStorefrontAssistantNavigationTarget(target, origin);
    if (!route) continue;
    const label =
      element.getAttribute("aria-label")?.trim() ||
      element.getAttribute("title")?.trim() ||
      element.textContent?.trim() ||
      routeLabel(route);
    candidates.push({
      route,
      label: label.replace(/\s+/g, " ").slice(0, 180),
      source: "visible-page",
    });
  }
  return candidates;
}

function storefrontNavigationIntent(
  value: string,
): StorefrontNavigationIntent | null {
  const direct = explicitNavigationDestination(value);
  if (direct) return { destination: direct, mode: "direct" };
  const discovery = discoveryNavigationDestination(value);
  return discovery
    ? { destination: discovery, mode: "discovery" }
    : null;
}

function explicitNavigationDestination(value: string): string | null {
  const text = normalizeWords(value).replace(/[?]+$/u, "").trim();
  if (!text) return null;
  const patterns = [
    /\b(?:take|bring) me to (.+)$/u,
    /\bgo to (.+)$/u,
    /\bnavigate(?: me)? to (.+)$/u,
    /\bopen (.+)$/u,
    /\bvisit (.+)$/u,
    /\bshow me (.+?) page$/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const destination = match?.[1]
      ?.replace(/\bplease$/u, "")
      .replace(/^the\s+/u, "")
      .replace(/\s+page$/u, "")
      .replace(/[?]+$/u, "")
      .trim();
    if (destination) return destination;
  }
  return null;
}

function discoveryNavigationDestination(value: string): string | null {
  const text = normalizeWords(value).replace(/[?!.]+$/u, "").trim();
  if (!text) return null;
  const patterns = [
    /^(?:do|does) (?:you|this store) (?:sell|have|carry|stock|offer) (.+)$/u,
    /^(?:have|got) (?:you|this store) (?:got )?(.+)$/u,
    /^(?:i am|i m|im) (?:looking|shopping|searching) for (.+)$/u,
    /^(?:can|could|would) you (?:please )?(?:help me )?(?:find|show|recommend) (.+)$/u,
    /^(?:help me )?(?:find|show|recommend) (.+)$/u,
    /^which (.+) (?:do you recommend|would you recommend|are available|are in stock)$/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const destination = cleanDiscoveryDestination(match?.[1] ?? "");
    if (destination) return destination;
  }
  return null;
}

function cleanDiscoveryDestination(value: string): string | null {
  const destination = value
    .replace(/^(?:any|some|a|an|the)\s+/u, "")
    .replace(/^me\s+/u, "")
    .replace(/\s+(?:for sale|available|in stock|here|today)$/u, "")
    .trim();
  if (!destination || meaningfulWords(destination).length === 0) return null;
  const generic = new Set([
    "anything",
    "everything",
    "item",
    "items",
    "product",
    "products",
    "something",
    "stuff",
  ]);
  return generic.has(destination) ? null : destination;
}

function candidateProvesTarget(candidate: string, target: string): boolean {
  if (candidate === target) return true;
  const candidateUrl = safeRouteUrl(candidate);
  const targetUrl = safeRouteUrl(target);
  return Boolean(
    candidateUrl &&
    targetUrl &&
    candidateUrl.pathname === "/search" &&
    targetUrl.pathname === "/search" &&
    targetUrl.searchParams.has("q"),
  );
}

function destinationMatchesCandidate(
  intent: StorefrontNavigationIntent,
  route: string,
  label: string,
): boolean {
  const normalizedDestination = normalizeWords(intent.destination);
  if (!normalizedDestination) return false;
  const normalizedRoute = normalizeWords(route);
  if (normalizedRoute && normalizedDestination.includes(normalizedRoute)) {
    return true;
  }
  const destinationWords = new Set(
    canonicalMeaningfulWords(normalizedDestination),
  );
  const labelWords = canonicalMeaningfulWords(label);
  const routeWords = canonicalMeaningfulWords(routeLabel(route));
  const queryWords = canonicalMeaningfulWords(
    safeRouteUrl(route)?.searchParams.get("q") ?? "",
  );
  return [labelWords, queryWords, routeWords].some(
    (words) => {
      if (words.length === 0) return false;
      if (intent.mode === "direct") {
        return words.every((word) => destinationWords.has(word));
      }
      const candidateWords = new Set(words);
      return [...destinationWords].every((word) => candidateWords.has(word));
    },
  );
}

function isExactSearchDestination(
  route: string,
  intent: StorefrontNavigationIntent,
): boolean {
  const url = safeRouteUrl(route);
  if (!url || url.pathname !== "/search") return false;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "q") return false;
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (!query || query.length > 120) return false;
  const queryWords = canonicalMeaningfulWords(query);
  const destinationWords = canonicalMeaningfulWords(intent.destination);
  return (
    queryWords.length > 0 &&
    queryWords.join("|") === destinationWords.join("|")
  );
}

function isSameExactSearchRoute(left: string, right: string): boolean {
  const leftUrl = safeRouteUrl(left);
  const rightUrl = safeRouteUrl(right);
  if (leftUrl?.pathname !== "/search" || rightUrl?.pathname !== "/search") {
    return false;
  }
  const leftKeys = [...leftUrl.searchParams.keys()];
  const rightKeys = [...rightUrl.searchParams.keys()];
  return (
    leftKeys.length === 1 &&
    leftKeys[0] === "q" &&
    rightKeys.length === 1 &&
    rightKeys[0] === "q" &&
    leftUrl.searchParams.get("q") === rightUrl.searchParams.get("q")
  );
}

function canonicalMeaningfulWords(value: string): string[] {
  return meaningfulWords(value)
    .map((word) =>
      word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word,
    )
    .sort();
}

function meaningfulWords(value: string): string[] {
  const ignored = new Set(["a", "an", "the", "page", "product", "products"]);
  return normalizeWords(value)
    .split(" ")
    .filter((word) => word.length > 1 && !ignored.has(word));
}

function normalizeWords(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/_?=&.-]+/gu, " ")
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function routeLabel(route: string): string {
  const url = safeRouteUrl(route);
  if (!url) return route;
  if (url.pathname === "/") return "home";
  const query = url.searchParams.get("q");
  if (url.pathname === "/search" && query) return `search ${query}`;
  return (
    decodeURIComponent(url.pathname)
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/[-_.]+/g, " ") || route
  );
}

function safeRouteUrl(route: string): URL | null {
  try {
    return new URL(route, "https://storefront.invalid");
  } catch {
    return null;
  }
}

function dedupeCandidates(
  candidates: readonly StorefrontNavigationCandidate[],
): StorefrontNavigationCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.route}\n${normalizeWords(candidate.label)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
