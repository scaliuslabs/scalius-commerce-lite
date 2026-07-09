const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BANGLADESH_PHONE_PATTERN = /(^|[^\d])(?:\+?88)?01[3-9]\d{8}(?!\d)/g;
const BROAD_PHONE_PATTERN = /(^|[^\d])\+?\d[\d\s().-]{6,}\d(?!\d)/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const CREDENTIAL_PREFIX_PATTERN =
  /\b(?:approval|chk|cst|otp|pk|secret|session|sk|tok|token)_[A-Za-z0-9_-]{6,}\b/gi;
const JWT_PATTERN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b/g;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;
const PERSISTED_STRUCTURED_VALUE_PATTERN =
  /((?:["']?(?:address(?:line[12])?|shipping[_ -]?address|billing[_ -]?address|name|first[_ -]?name|last[_ -]?name|full[_ -]?name|customer[_ -]?name|email|phone|mobile|password|passcode|otp|receipt(?:[_ -]?(?:proof|token))?|recovery(?:[_ -]?(?:proof|token))?|credential|secret|api[_ -]?key|token)["']?)\s*(?::|=|\bis\b)\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\n;]{1,500})/gi;

const EMAIL_TEST_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const BANGLADESH_PHONE_TEST_PATTERN = /(?:^|[^\d])(?:\+?88)?01[3-9]\d{8}(?!\d)/;
const BROAD_PHONE_TEST_PATTERN = /(?:^|[^\d])\+?\d[\d\s().-]{6,}\d(?!\d)/;
const BEARER_TEST_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i;
const CREDENTIAL_PREFIX_TEST_PATTERN =
  /\b(?:approval|chk|cst|otp|pk|secret|session|sk|tok|token)_[A-Za-z0-9_-]{6,}\b/i;
const JWT_TEST_PATTERN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b/;
const LONG_TOKEN_TEST_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/;

export function redactAssistantSensitiveText(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [redacted-token]")
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(BANGLADESH_PHONE_PATTERN, "$1[redacted-phone]")
    .replace(BROAD_PHONE_PATTERN, "$1[redacted-number]")
    .replace(CREDENTIAL_PREFIX_PATTERN, "[redacted-token]")
    .replace(JWT_PATTERN, "[redacted-token]")
    .replace(LONG_TOKEN_PATTERN, "[redacted-token]");
}

export function containsAssistantSensitiveText(value: string): boolean {
  return BEARER_TEST_PATTERN.test(value) ||
    EMAIL_TEST_PATTERN.test(value) ||
    BANGLADESH_PHONE_TEST_PATTERN.test(value) ||
    BROAD_PHONE_TEST_PATTERN.test(value) ||
    CREDENTIAL_PREFIX_TEST_PATTERN.test(value) ||
    JWT_TEST_PATTERN.test(value) ||
    LONG_TOKEN_TEST_PATTERN.test(value);
}

/**
 * Stricter redaction for text that may be persisted in assistant conversation
 * state. Values attached to common identity, address, authentication, and
 * recovery labels are removed before the general token/contact redactor runs.
 */
export function redactAssistantPersistedText(value: string): string {
  return redactAssistantSensitiveText(
    value.replace(PERSISTED_STRUCTURED_VALUE_PATTERN, "$1[redacted]"),
  );
}
