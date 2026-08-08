# Security Policy

We take security seriously. Thank you for helping keep Scalius Commerce Lite safe.

## Supported Versions

Security fixes are provided for the latest stable release. Before the first
stable tag, the default branch is the only supported line. Please reproduce a
report against the latest supported code when practical.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities via email: **security@scalius.com**

Include:
1. Description of the vulnerability
2. Steps to reproduce or proof-of-concept
3. Potential impact (data leak, auth bypass, XSS, etc.)
4. Affected component (Admin dashboard, API worker, Storefront, Database)

Do not include production credentials, raw buyer data, OTPs, receipt proofs, or
other bearer secrets in the initial report. We will arrange a safer transfer if
sensitive evidence is required.

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Assessment**: Within 5 business days
- **Resolution**: As soon as possible

## Scope

### In Scope
- Authentication/authorization bypasses (Better Auth, JWT, RBAC)
- SQL injection (Drizzle ORM / D1 queries)
- Cross-site scripting (XSS) in admin dashboard or storefront
- Insecure direct object references (IDOR) in API endpoints
- Sensitive data exposure (PII, API keys, session tokens)
- CSP bypass or misconfiguration

### Out of Scope
- Vulnerabilities in third-party services (Cloudflare, Firebase, Stripe) unless caused by our misconfiguration
- Social engineering or phishing
- Denial of Service (DoS)

## Safe Harbor

Security research conducted in accordance with this policy is considered authorized and non-infringing. We will not pursue legal action against researchers who follow this policy.
