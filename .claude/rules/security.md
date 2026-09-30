# Security Standards

Security is built in. A full security review, however, is reserved for work that needs it.

## When Security Is In Scope

Set the `security` flag (security-engineer, HIGH) when work touches any of these:

- authentication, authorisation, sessions or permissions;
- secrets or cryptography;
- untrusted input reaching a database, shell, filesystem, template or another service;
- file uploads, user-generated content or webhooks;
- personal, customer or payment data;
- security controls or configuration;
- a dependency with a known vulnerability.

When in doubt, set it. Everyone applies the baseline below, whether or not the flag is set.

## Baseline Controls

- **Secrets.** Keep them out of source, git history, logs, screenshots, handoffs and the ledger.
  Use environment variables or a secret manager, and commit only `.env.example`. Never open,
  print or copy a `.env` or credential file for analysis. If exposure is suspected, stop and tell
  the human (rotation is a gated action).
- **Authentication and authorisation.** Authentication establishes identity and never implies
  permission. Authorisation is checked server-side on every protected operation, per resource
  (ownership, role, tenant). Frontend checks are UX only. Use the framework's or a proven
  provider's auth. Never hand-roll crypto or password storage; use argon2, bcrypt or scrypt.
- **Input.** Validate with a schema at every trust boundary. Use parameterised queries. Build no
  shell commands from strings. Deserialise nothing unsafely. Render no raw HTML from untrusted
  content without sanitising it.
- **Exposure.** Return only what the client needs. No stack traces, internal IDs or other users'
  data in responses or logs.
- **Web.**
  - Cookies are `Secure`, `HttpOnly`, with an explicit `SameSite`.
  - Cookie-authenticated state changes are protected against CSRF.
  - CORS allow-lists explicit origins.
  - Abuse-prone endpoints are rate-limited.
  - Security headers are set.

## Dependencies

Run the ecosystem's vulnerability scan (`npm audit`, `pip-audit`, `cargo audit`,
`dotnet list package --vulnerable`, …) whenever dependencies change. A known-vulnerable
dependency is accepted only with all of the following:

1. non-vulnerable alternatives were investigated;
2. a reachability and risk assessment was made;
3. a compensating control is in place;
4. `security-engineer` has independently verified 2 and 3;
5. the human has explicitly approved it, naming the package and version.

Until then it is not installed or committed.

## Never

- Disable or weaken auth, validation or another control, even temporarily or "for testing".
- Leave test credentials behind.
- Suppress a security warning without investigating it.
