---
name: i18n-strings
description: Rules for user-facing text. Use when adding any string a user can see.
---
- English only in Release 1. Every string is a key in `apps/web/src/lib/i18n/messages/en.json`, ICU message format for plurals/params.
- Services and view-models return message keys + params (`{ key: 'toast.pagesDeleted', params: { count: 3 } }`), never English sentences. Command labels are keys too.
- The ESLint rule `folio/no-hardcoded-strings` flags literal text in `.svelte` markup. `pnpm lint` also checks that every key used in `packages/app` exists in `en.json`.
- Wording: say what happened, why, and what to do. Whiteout is never called "redact".
