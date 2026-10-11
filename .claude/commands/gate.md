---
description: Run the exit-gate checklist for a phase and report pass/fail
argument-hint: <P0..P9 | services-complete>
---
Run `bash tools/gate.sh $ARGUMENTS` and report each check (tests, coverage, trace, lint, type-check, AppImage build + smoke) as pass/fail with the failing output. `services-complete` runs the gates of P0–P7 and, only if all pass, creates `.claude/state/ui-unlocked`. Then have spec-guardian review the phase scope. Update docs/PROGRESS.md.
