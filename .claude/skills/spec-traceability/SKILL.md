---
name: spec-traceability
description: Tag tests with requirement IDs and keep the traceability matrix complete. Use when finishing a requirement.
---
- Put the IDs in the test title: `it('splits every N pages @FR-MRG-04 @FR-MRG-06', …)`. A `describe` title tag applies to all tests inside.
- `pnpm trace` parses the requirement tables in SPEC.md (§6, §10.1), drops `Post-R1` rows and everything in §17.0, scans all `*.test.ts` / `*.spec.ts`, writes `docs/traceability.md` and exits non-zero if a Release 1 requirement has no test.
- `pnpm trace -- --phase P3` limits the failure check to the requirement set of a phase (see `tools/phases.ts`).
- A requirement that can only be proven at UI level is tagged in a Playwright spec under `tests/e2e`; before P8 it is listed in the matrix as "UI-pending" and does not fail service-phase gates.
