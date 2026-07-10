import type { ReactNode } from "react";

const MAX_COMPACT_RESULTS = 3;
const MAX_SHORT_ANSWER_LENGTH = 420;

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function shorten(text: string, maximum: number) {
  if (text.length <= maximum) return text;
  const candidate = text.slice(0, maximum + 1);
  const boundary = candidate.lastIndexOf(" ");
  return `${candidate.slice(0, boundary > maximum * 0.7 ? boundary : maximum).trim()}…`;
}

export interface AssistantShortAnswerProps {
  summary: string;
  details?: ReactNode;
  label?: string;
  className?: string;
}

export function AssistantShortAnswer({
  summary,
  details,
  label = "Answer",
  className,
}: AssistantShortAnswerProps) {
  const compactSummary = shorten(summary.trim(), MAX_SHORT_ANSWER_LENGTH);
  return (
    <section
      className={classNames("sc-assistant-answer", className)}
      aria-label={label}
      data-assistant-short-answer=""
    >
      <p>{compactSummary}</p>
      {details ? (
        <AssistantDisclosure summary="More detail">
          {details}
        </AssistantDisclosure>
      ) : null}
    </section>
  );
}

export interface AssistantResultAction {
  label: string;
  href?: string;
  onSelect?: () => void;
}

export interface AssistantResult {
  id: string;
  title: string;
  description?: string;
  meta?: string;
  badge?: string;
  image?: {
    src: string;
    alt: string;
  };
  leading?: ReactNode;
  action?: AssistantResultAction;
}

export interface AssistantFeaturedResultProps {
  result: AssistantResult;
  className?: string;
}

/** A single featured result; use AssistantResultList for every additional option. */
export function AssistantFeaturedResult({
  result,
  className,
}: AssistantFeaturedResultProps) {
  return (
    <article
      className={classNames("sc-assistant-featured", className)}
      data-assistant-featured-result=""
    >
      {result.image ? (
        <img
          className="sc-assistant-featured__image"
          src={result.image.src}
          alt={result.image.alt}
          width={640}
          height={360}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : null}
      <div className="sc-assistant-featured__body">
        <ResultHeading result={result} />
        {result.description ? <p>{result.description}</p> : null}
        {result.action ? <ResultAction action={result.action} /> : null}
      </div>
    </article>
  );
}

export interface AssistantResultListProps {
  items: readonly AssistantResult[];
  label?: string;
  maximumVisible?: number;
  onShowAll?: () => void;
  showAllLabel?: string;
  className?: string;
}

export function AssistantResultList({
  items,
  label = "Results",
  maximumVisible = MAX_COMPACT_RESULTS,
  onShowAll,
  showAllLabel,
  className,
}: AssistantResultListProps) {
  const requestedLimit = Number.isFinite(maximumVisible)
    ? Math.floor(maximumVisible)
    : MAX_COMPACT_RESULTS;
  const visibleLimit = Math.min(
    MAX_COMPACT_RESULTS,
    Math.max(1, requestedLimit),
  );
  const visibleItems = items.slice(0, visibleLimit);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);

  return (
    <section
      className={classNames("sc-assistant-results", className)}
      aria-label={label}
      data-assistant-result-list=""
    >
      <div className="sc-assistant-results__rows">
        {visibleItems.map((result) => (
          <AssistantResultRow key={result.id} result={result} />
        ))}
      </div>
      {hiddenCount > 0 ? (
        onShowAll ? (
          <button
            className="sc-assistant-results__more"
            type="button"
            onClick={onShowAll}
          >
            {showAllLabel ?? `View all ${items.length} results`}
            <span aria-hidden="true">→</span>
          </button>
        ) : (
          <p className="sc-assistant-results__overflow-note">
            {hiddenCount} more {hiddenCount === 1 ? "result" : "results"}.
            Refine the request to narrow this list.
          </p>
        )
      ) : null}
    </section>
  );
}

export function AssistantResultRow({ result }: { result: AssistantResult }) {
  return (
    <article className="sc-assistant-result-row" data-assistant-result-row="">
      {result.image ? (
        <img
          className="sc-assistant-result-row__image"
          src={result.image.src}
          alt={result.image.alt}
          width={52}
          height={52}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : result.leading ? (
        <span className="sc-assistant-result-row__leading" aria-hidden="true">
          {result.leading}
        </span>
      ) : null}
      <div className="sc-assistant-result-row__body">
        <ResultHeading result={result} />
        {result.description ? <p>{result.description}</p> : null}
      </div>
      {result.action ? <ResultAction action={result.action} compact /> : null}
    </article>
  );
}

function ResultHeading({ result }: { result: AssistantResult }) {
  return (
    <div className="sc-assistant-result-heading">
      <strong>{result.title}</strong>
      {result.badge ? <span>{result.badge}</span> : null}
      {result.meta ? <small>{result.meta}</small> : null}
    </div>
  );
}

function ResultAction({
  action,
  compact = false,
}: {
  action: AssistantResultAction;
  compact?: boolean;
}) {
  const className = classNames(
    "sc-assistant-result-action",
    compact && "sc-assistant-result-action--compact",
  );
  const safeHref = action.href ? safeAssistantRoute(action.href) : null;
  if (safeHref) {
    return (
      <a className={className} href={safeHref} onClick={action.onSelect}>
        <span>{action.label}</span>
        <span aria-hidden="true">→</span>
      </a>
    );
  }
  if (!action.onSelect) return null;
  return (
    <button className={className} type="button" onClick={action.onSelect}>
      <span>{action.label}</span>
      <span aria-hidden="true">→</span>
    </button>
  );
}

function safeAssistantRoute(candidate: string) {
  if (
    candidate !== candidate.trim() ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    hasUnsafeRouteCharacter(candidate)
  ) {
    return null;
  }

  try {
    const parsed = new URL(candidate, "https://assistant.invalid");
    const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (
      parsed.origin !== "https://assistant.invalid" ||
      normalized !== candidate ||
      parsed.pathname.includes("//")
    ) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

function hasUnsafeRouteCharacter(candidate: string) {
  return Array.from(candidate).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      character.trim() === ""
    );
  });
}

export interface AssistantDisclosureProps {
  summary: string;
  children: ReactNode;
  className?: string;
}

export function AssistantDisclosure({
  summary,
  children,
  className,
}: AssistantDisclosureProps) {
  return (
    <details
      className={classNames("sc-assistant-disclosure", className)}
      data-assistant-disclosure=""
    >
      <summary>
        <span>{summary}</span>
        <span aria-hidden="true" className="sc-assistant-disclosure__chevron">
          ↓
        </span>
      </summary>
      <div className="sc-assistant-disclosure__body">{children}</div>
    </details>
  );
}

export interface AssistantToolStep {
  id: string;
  label: string;
  status: "queued" | "running" | "complete" | "failed";
}

export interface AssistantToolProgressProps {
  label: string;
  steps: readonly AssistantToolStep[];
  className?: string;
}

export function AssistantToolProgress({
  label,
  steps,
  className,
}: AssistantToolProgressProps) {
  const boundedSteps = steps.slice(0, 8);
  const complete = steps.filter((step) => step.status === "complete").length;
  const failed = steps.some((step) => step.status === "failed");
  const active = steps.some((step) => step.status === "running");
  const allComplete = steps.length > 0 && complete === steps.length;
  const state = failed
    ? "Needs attention"
    : active
      ? "Working"
      : allComplete
        ? "Complete"
        : "Queued";

  return (
    <details
      className={classNames("sc-assistant-tool-progress", className)}
      data-assistant-tool-progress=""
    >
      <summary aria-live="polite">
        <span
          className="sc-assistant-tool-progress__pulse"
          data-state={state}
        />
        <span>{label}</span>
        <small>
          {state} · {complete}/{steps.length}
        </small>
      </summary>
      <ol>
        {boundedSteps.map((step) => (
          <li key={step.id} data-status={step.status}>
            <span aria-hidden="true" />
            <span>{step.label}</span>
            <small>{step.status}</small>
          </li>
        ))}
      </ol>
    </details>
  );
}
