# Security Policy

Thank you for helping keep Scalius Commerce Lite and our community safe. We take security seriously and appreciate the community's efforts in identifying and remediating vulnerabilities.

## Supported Versions

Please verify that you are testing against the latest version of the codebase.

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.** Publicly disclosing a security bug can put the entire community at risk before a fix is available.

If you have discovered a security vulnerability in Scalius Commerce Lite, please report it via email to:

**security@scalius.com**

### What to Include
To help us triage and resolve the issue quickly, please include:
1.  **Description:** A clear description of the vulnerability.
2.  **Steps to Reproduce:** Detailed steps or a proof-of-concept (PoC) script.
3.  **Impact:** The potential security impact (e.g., data leak, auth bypass, XSS).
4.  **Affected Components:** (e.g., Admin API, Storefront Hono API, Database Schema).

## Response Timeline

We are committed to resolving security issues promptly. Here is what you can expect:

*   **Acknowledgment:** We will acknowledge receipt of your report within **48 hours**.
*   **Assessment:** We will confirm the validity of the issue and determine its severity within **5 business days**.
*   **Resolution:** We will work to provide a patch or workaround as soon as possible.
*   **Notification:** We will notify you when the fix is released.

## Scope

### In Scope
*   Authentication and Authorization bypasses (issues with our implementation of Clerk/JWTs).
*   SQL Injection (issues within our Drizzle ORM usage).
*   Cross-Site Scripting (XSS) in the Admin Dashboard or Storefront.
*   Insecure Direct Object References (IDOR) in API endpoints.
*   Sensitive data exposure (PII, API keys).

### Out of Scope
*   Vulnerabilities in third-party providers (e.g., Clerk, Cloudflare, OpenRouter, Turso) unless caused by our misconfiguration.
*   Social engineering or phishing attacks.
*   Denial of Service (DoS) attacks.
*   Spam or automated operational noise.

## Safe Harbor

If you conduct security research and disclose vulnerabilities to us in accordance with this policy, we consider your research to be:
*   **Authorized** concerning any applicable anti-hacking laws.
*   **Non-infringing** regarding any applicable anti-circumvention laws.

We will not pursue legal action against you for research that adheres to this policy.

---

*This policy is subject to change. Please check this file for the latest version.*
