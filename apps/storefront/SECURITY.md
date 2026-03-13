# Security Policy

Thank you for helping keep Scalius Commerce Storefront and our community safe. We take security seriously and appreciate the community's efforts in identifying and remediating vulnerabilities.

## Supported Versions

Please verify that you are testing against the latest version of the codebase.

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.** Publicly disclosing a security bug can put the entire community at risk before a fix is available.

If you have discovered a security vulnerability in Scalius Commerce Storefront, please report it via email to:

**security@scalius.com**

### What to Include

To help us triage and resolve the issue quickly, please include:

1.  **Description:** A clear description of the vulnerability.
2.  **Steps to Reproduce:** Detailed steps or a proof-of-concept (PoC) script.
3.  **Impact:** The potential security impact (e.g., XSS, Data Leak, Session Hijacking).
4.  **Affected Components:** (e.g., Checkout Flow, User Profile, Search Component).

## Response Timeline

We are committed to resolving security issues promptly. Here is what you can expect:

- **Acknowledgment:** We will acknowledge receipt of your report within **48 hours**.
- **Assessment:** We will confirm the validity of the issue and determine its severity within **5 business days**.
- **Resolution:** We will work to provide a patch or workaround as soon as possible.
- **Notification:** We will notify you when the fix is released.

## Scope

### In Scope

- **Cross-Site Scripting (XSS):** Vulnerabilities where user input is not properly sanitized in the UI.
- **Cross-Site Request Forgery (CSRF):** Issues allowing unauthorized actions on behalf of a user.
- **Sensitive Data Exposure:** Unintentional leaking of sensitive tokens or user data in the browser.
- **Authentication Flaws:** Client-side handling of auth states that leads to unauthorized access.

### Out of Scope

- Vulnerabilities in the backend API (Scalius Commerce Lite) - report those to the backend repo.
- Vulnerabilities in third-party providers (e.g., Clerk, Cloudflare) unless caused by our misconfiguration.
- Social engineering or phishing attacks.
- Denial of Service (DoS) attacks.

## Safe Harbor

If you conduct security research and disclose vulnerabilities to us in accordance with this policy, we consider your research to be:

- **Authorized** concerning any applicable anti-hacking laws.
- **Non-infringing** regarding any applicable anti-circumvention laws.

We will not pursue legal action against you for research that adheres to this policy.

---

_This policy is subject to change. Please check this file for the latest version._
