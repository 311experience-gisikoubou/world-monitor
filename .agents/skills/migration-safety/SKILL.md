---
name: migration-safety
description: Use with preflight-audit for schema changes, database migrations, table recreation, NOT NULL, CHECK, UNIQUE, foreign key, data copy, or data migration requests. Verify existing migrations remain frozen, migration ordering and numbering, fresh-apply and upgrade-from-existing tests, explicit column copy, transaction boundaries, schema integrity, backup need, and environment-specific differences such as checksums or line endings, and stop on existing migration edits, data loss risk, unknown copy columns, missing tests, or unclear backup policy.
---

# Migration Safety

Use for any schema, database, or migration-related work.

## Common Principles

- Treat already-applied migrations as frozen: do not change their content, comments, whitespace, or line endings.
- Before adding a new migration, confirm migration numbering and ordering, and check for duplicates.
- Run or require a test that applies every migration to a fresh database.
- Run or require a test that applies the new migration on top of an existing database that already has prior migrations and data.
- Confirm schema integrity after the migration as a set — constraints, foreign keys, triggers, and indexes together — rather than assuming it from the migration's SQL alone.
- For a table recreation where the migration tool cannot alter a table directly, prefer this order: create the new table, copy data with explicit column names (never a wildcard column list), drop the old table, then rename the new table into place.
- Confirm whether the migration tool wraps each migration in its own transaction; do not assume it is safe to add nested transaction statements inside a migration file.
- Do not disable foreign-key or constraint enforcement in order to force a migration through. If enforcement must be suspended temporarily, treat it as a specific, reviewed exception, explain why, and re-verify integrity immediately afterward.
- Never apply an untested migration against an environment that holds real data.
- Before applying a migration outside of a test environment, confirm whether a backup is required, and identify the rollback path if the migration fails partway.
- Some migration tools verify already-applied migration files against a stored checksum. If such a check fails, first rule out environment-specific differences (for example, line-ending conversion) before treating it as a real content change.
- Keep migration changes and application/backend code changes in separate, separately reviewable changes when practical.

## Stop Conditions

- An existing, already-applied migration file would be changed.
- Data loss is possible and not fully controlled.
- Column mapping for a data copy is unclear.
- A required migration test cannot be run or designed.
- Backup policy is unclear for an environment that holds real data.
- A checksum or line-ending discrepancy cannot be confidently attributed to an environment difference rather than a real content change.

## Output

Report the migration identifier, files affected, safety checks performed, tests run, backup need, blockers, and whether implementation may proceed.

## Application-Specific Configuration

The specific migration tool, database engine, file-naming and numbering convention, and the exact commands used to run migration tests are repository-specific. Consult that repository's `AGENTS.local.md` — its "Technology Stack" and "Migration Rules" sections — before starting, rather than assuming any of this skill's examples name the tool actually in use.
