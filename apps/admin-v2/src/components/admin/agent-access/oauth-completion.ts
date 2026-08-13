export function getTrustedOAuthCompletionUrl(
  value: string,
  trustedApiOrigin: string,
): string | null {
  let completion: URL;
  try {
    completion = new URL(value);
  } catch {
    return null;
  }
  if (
    completion.origin !== trustedApiOrigin ||
    !completion.pathname.startsWith("/oauth/complete/") ||
    completion.pathname.slice("/oauth/complete/".length).includes("/") ||
    completion.search !== "" ||
    completion.hash !== ""
  ) {
    return null;
  }
  const requestId = completion.pathname.slice("/oauth/complete/".length);
  if (!/^aar_[A-Za-z0-9_-]{8,120}$/.test(requestId)) return null;
  return completion.href;
}

export function getOAuthDecisionCompletionUrl(
  result: { status: string; completionUrl?: string },
  trustedApiOrigin: string,
): string | null {
  if (
    (result.status !== "approved" && result.status !== "denied") ||
    !result.completionUrl
  ) {
    return null;
  }
  return getTrustedOAuthCompletionUrl(result.completionUrl, trustedApiOrigin);
}

export function navigateOAuthDecisionCompletion(
  result: { status: string; completionUrl?: string },
  trustedApiOrigin: string,
  assign: (url: string) => void = (url) => window.location.assign(url),
): boolean {
  const completionUrl = getOAuthDecisionCompletionUrl(
    result,
    trustedApiOrigin,
  );
  if (!completionUrl) return false;
  assign(completionUrl);
  return true;
}
