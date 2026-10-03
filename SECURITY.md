# Security Policy

This policy tells you how to report a vulnerability in Scalius Commerce Lite and what the maintainers do next.

## Supported versions

Security fixes go to the default branch (`mono-repo`) and to the latest stable release. Reproduce a report against the default branch when you can.

## Report a vulnerability

**Do not open a public GitHub issue or post in Discord.**

Report privately by either route:

- Email **security@scalius.com**.
- Use the [private security advisory form](https://github.com/scaliuslabs/scalius-commerce-lite/security/advisories/new).

Include:

1. A description of the vulnerability.
2. Steps to reproduce, or a proof of concept.
3. The impact (data leak, authentication bypass, XSS, and so on).
4. The affected component: dashboard, API Worker, storefront, or database layer.

Do not put production credentials, raw buyer data, OTPs, receipt proofs, or other bearer secrets in the first report. If the maintainers need such evidence, they arrange a safer transfer.

## Response timeline

| Step | Target |
|------|--------|
| Acknowledgment | Within 48 hours |
| Assessment | Within 5 business days |
| Resolution | As soon as possible |

## Scope

In scope:

- Authentication and authorization bypass (Better Auth, JWT, RBAC)
- SQL injection in database queries
- Cross-site scripting (XSS) in the dashboard or storefront
- Insecure direct object references (IDOR) in API endpoints
- Exposure of sensitive data (PII, API keys, session tokens)
- CSP bypass or misconfiguration

Out of scope:

- Vulnerabilities in third-party services (Cloudflare, Firebase, Stripe), unless the project's own misconfiguration causes them
- Social engineering and phishing
- Denial of service (DoS)

## Safe harbor

Security research that follows this policy is authorized and non-infringing. The maintainers will not pursue legal action against researchers who follow it.
