import type { FlueConversationMessage, FlueConversationPart } from "@flue/sdk";
import {
  normalizeScaliusComputerRoute,
  parseScaliusComputerProgram,
} from "@scalius/shared/assistant-computer";

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
  const destination = explicitNavigationDestination(authority.latestUserText);
  if (!target || !destination) return false;

  const matchingRoutes = new Set<string>();
  for (const candidate of authority.candidates) {
    if (!candidateProvesTarget(candidate.route, target)) continue;
    if (!destinationMatchesCandidate(destination, target, candidate.label)) {
      continue;
    }
    matchingRoutes.add(target);
  }
  if (matchingRoutes.size !== 1) return false;

  // Ambiguous language must not silently select one of several proven routes.
  const semanticMatches = new Set(
    authority.candidates
      .filter((candidate) =>
        destinationMatchesCandidate(
          destination,
          candidate.route,
          candidate.label,
        ),
      )
      .map((candidate) => candidate.route),
  );
  const targetUrl = safeRouteUrl(target);
  const targetIsSearch = targetUrl?.pathname === "/search";
  if (
    semanticMatches.size > 1 &&
    !(
      targetIsSearch &&
      [...semanticMatches].every(
        (route) => safeRouteUrl(route)?.pathname === "/search",
      )
    )
  ) {
    return false;
  }
  return true;
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
      collectRoutesFromValue(part.output, origin, candidates, 0, {
        count: 0,
      });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
  }
  return candidates;
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
  destination: string,
  route: string,
  label: string,
): boolean {
  const normalizedDestination = normalizeWords(destination);
  if (!normalizedDestination) return false;
  const normalizedRoute = normalizeWords(route);
  if (normalizedRoute && normalizedDestination.includes(normalizedRoute)) {
    return true;
  }
  const destinationWords = new Set(normalizedDestination.split(" "));
  const labelWords = meaningfulWords(label);
  const routeWords = meaningfulWords(routeLabel(route));
  const queryWords = meaningfulWords(
    safeRouteUrl(route)?.searchParams.get("q") ?? "",
  );
  return [labelWords, queryWords, routeWords].some(
    (words) =>
      words.length > 0 && words.every((word) => destinationWords.has(word)),
  );
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
