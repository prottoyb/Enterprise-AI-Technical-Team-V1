---
paths:
  - "**/routes/**"
  - "**/controllers/**"
  - "**/handlers/**"
  - "**/api/**"
  - "**/endpoints/**"
  - "**/resolvers/**"
  - "**/*.proto"
  - "**/*.graphql"
  - "**/openapi.*"
  - "**/swagger.*"
---

# API and Integration Standards

## Contracts

- Keep the project's existing style for naming, error format, pagination and versioning.
- Validate input with a schema at the boundary. Return consistent, documented error shapes and
  correct status codes. Never return stack traces.
- Every protected endpoint checks authorisation per resource. An endpoint that can read or write
  another user's or tenant's data is a `security` flag.
- Keep changes additive: new optional fields and new endpoints. Removing or renaming a field,
  changing a type or making an optional field required is `public-contract-breaking`, which means
  the architect, an ADR, a migration path, and human approval before merge.
- Update the API description (OpenAPI, proto, GraphQL schema) together with the code.

## Integrations

- Treat external responses as untrusted: validate them, set timeouts, and handle failure with
  bounded retries, backoff and idempotency.
- Verify webhook signatures. Keep integration credentials in the secret store.
- Test integrations against a fake or recorded contract. Never hit real external services in
  tests.
