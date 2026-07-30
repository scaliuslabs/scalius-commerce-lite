const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";
const RATE_LIMIT_MESSAGE =
  "Too many sign-in attempts. Wait a moment and try again.";
const CONNECTION_MESSAGE =
  "Unable to reach Scalius. Check your connection and try again.";
const RETRY_MESSAGE = "Unable to sign in right now. Please try again.";

function getErrorDetails(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (typeof error !== "object" || error === null) return "";

  return ["message", "code", "status", "statusCode"]
    .map((key) => {
      const value = Reflect.get(error, key);
      return typeof value === "string" || typeof value === "number"
        ? String(value)
        : "";
    })
    .filter(Boolean)
    .join(" ");
}

export function getSignInErrorMessage(error: unknown): string {
  const details = getErrorDetails(error).toLowerCase();

  if (/(?:^|\D)429(?:\D|$)|too many|rate.?limit/.test(details)) {
    return RATE_LIMIT_MESSAGE;
  }

  if (
    /failed to fetch|fetch failed|network|offline|timed? ?out|connection (?:failed|refused|reset|lost)/.test(
      details,
    )
  ) {
    return CONNECTION_MESSAGE;
  }

  if (
    /(?:^|\D)401(?:\D|$)|unauthori[sz]ed|invalid.+(?:email|password|credential)|credential.+invalid|invalid_email_or_password|user not found|incorrect password/.test(
      details,
    )
  ) {
    return INVALID_CREDENTIALS_MESSAGE;
  }

  return RETRY_MESSAGE;
}
