import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";

export interface LibraryPreviewContext {
  origin: string | null;
  ready: boolean;
  path: string | null;
  revision: number;
  retry: () => void;
}

/** One disposable document, never the editor's canvas or an editable draft. */
export function SectionLibraryPreview({ selection, name, preview }: {
  selection: string;
  name: string;
  preview: LibraryPreviewContext;
}) {
  const t = useMessages(themeEditorMessages);
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [document, setDocument] = useState<{ key: string; url: string; nonce: string } | null>(null);
  const [result, setResult] = useState<{ nonce: string; state: "ready" | "empty" | "failed" } | null>(null);
  const key = JSON.stringify([selection, preview.origin, preview.path, preview.revision, attempt]);
  const available = preview.ready && !!preview.origin && !!preview.path
    && typeof window !== "undefined" && preview.origin !== window.location.origin;
  const current = available && document?.key === key ? document : null;
  const state = current && result?.nonce === current.nonce ? result.state : "loading";

  useEffect(() => {
    if (!available) return;
    const timer = window.setTimeout(() => {
      const nonce = crypto.randomUUID();
      const url = new URL("/theme-preview/library", preview.origin!);
      url.searchParams.set("section", selection);
      url.searchParams.set("page", preview.path!);
      url.searchParams.set("v", nonce);
      setDocument({ key, url: url.href, nonce });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [available, key, preview.origin, preview.path, selection]);

  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(() => setResult({ nonce: current.nonce, state: "failed" }), 15_000);
    const message = (event: MessageEvent) => {
      if (event.origin !== preview.origin || event.source !== frame.current?.contentWindow) return;
      const data: unknown = event.data;
      if (!data || typeof data !== "object") return;
      const reply = data as Record<string, unknown>;
      if (reply.type !== "scalius:library-preview" || reply.v !== current.nonce
        || (reply.state !== "ready" && reply.state !== "empty" && reply.state !== "failed")) return;
      window.clearTimeout(timer);
      setResult({ nonce: current.nonce, state: reply.state });
    };
    window.addEventListener("message", message);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", message);
    };
  }, [current, preview.origin]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-library-preview>
      <p className="text-body text-muted-foreground">{t("libraryPreviewSaved")}</p>
      <div className="relative min-h-64 flex-1 overflow-hidden rounded-lg border bg-background" aria-busy={available && state === "loading"}>
        {current && state !== "failed" ? (
          <iframe
            key={current.nonce}
            ref={frame}
            title={t("libraryPreviewTitle", { name })}
            src={current.url}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            tabIndex={-1}
            className="absolute inset-0 h-full w-full border-0"
          />
        ) : null}
        {!available || state !== "ready" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center text-body text-muted-foreground" role="status">
            <p>{t(!available ? "libraryPreviewUnavailable" : state === "failed" ? "libraryPreviewFailed" : state === "empty" ? "libraryPreviewEmpty" : "libraryPreviewLoading")}</p>
            {!available || state === "failed" ? <Button type="button" variant="outline" size="sm" onClick={() => {
              setAttempt((value) => value + 1);
              preview.retry();
            }}>{t("retry")}</Button> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
