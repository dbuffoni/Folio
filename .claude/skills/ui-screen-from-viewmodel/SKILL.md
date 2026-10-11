---
name: ui-screen-from-viewmodel
description: Build a Svelte screen from an existing view-model. Phase P8 only (requires .claude/state/ui-unlocked).
---
1. Find the view-model in `packages/app/src` and its tests; the screen adds no business logic.
2. Match `docs/mockup/index.html`: same structure, class semantics and tokens (`--color-*`, `--radius-*`), light and dark.
3. Use components from `apps/web/src/lib/ui`; add a missing primitive there first.
4. Strings via i18n keys; icons from Lucide with tooltip + shortcut hint.
5. Accessibility: roles/labels, focus-visible, full keyboard path, targets ≥ 32 px, reduced motion.
6. Add a Playwright spec in `tests/e2e` tagged with the requirement IDs, plus an axe check and a screenshot baseline for light and dark.
