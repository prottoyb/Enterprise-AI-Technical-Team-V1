---
paths:
  - "**/migrations/**"
  - "**/migrate/**"
  - "**/alembic/**"
  - "**/flyway/**"
  - "**/liquibase/**"
  - "**/db/**"
  - "**/database/**"
  - "**/prisma/**"
  - "**/drizzle/**"
  - "**/supabase/**"
  - "**/*.sql"
  - "**/schema.*"
  - "**/models/**"
  - "**/entities/**"
  - "**/repositories/**"
---

# Database Standards

## Integrity

Enforce integrity in the database where the platform allows it: constraints, foreign keys,
uniqueness, `NOT NULL`. Use transactions for multi-step writes. Handle concurrent updates
explicitly, with optimistic locking, row locks or idempotency keys, whenever two requests can
touch the same row.

## Migrations

- Every schema change is a versioned migration in the project's tool. Never make manual changes.
- Make changes backward-compatible across a deploy (expand → migrate/backfill → contract). Old
  and new code must both work while the deploy rolls out.
- Consider locking and duration on large tables: create indexes concurrently where supported,
  batch backfills, and avoid long exclusive locks.
- Give every migration a tested rollback, or record why it cannot be reversed and what the restore
  path is.
- Verify on a disposable database: apply, roll back, re-apply, and check that existing data
  survived.

## Destructive Changes

Dropping, truncating, overwriting or irreversibly transforming data is the `data-destructive`
flag. Writing and testing the migration locally is autonomous work. **Executing** it against any
non-disposable environment needs human approval, a verified backup or restore path, and a written
rollback plan.

## Queries

- Parameterise every query.
- Avoid N+1 queries on list paths.
- Paginate unbounded reads.
- Add indexes for new filter and sort paths, with the evidence (a query plan) when performance is
  the concern.
