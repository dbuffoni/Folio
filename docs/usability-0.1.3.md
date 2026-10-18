# Usability and screen-reader pass (release 0.1.3)

Status: **partly done**. The card needs people and machines this build environment does not have. What was
possible was done and is listed here; the rest stays open as explicit follow-ups.

## What was done

| Check | Method | Result |
| --- | --- | --- |
| Automated accessibility scans | axe in both themes on every main screen (`apps/web/tests/screens.spec.ts`), plus the new dialogs of 0.1.3 | green |
| Keyboard reachability | every task reachable by keyboard and the command palette (NFR-11); restricted commands stay focusable and expose their reason (`aria-disabled`) | green |
| Labels and roles | Svelte a11y warnings fixed: colour and fill rows in the Inspector were orphan labels; the document canvas is a focusable scrollable region with its key handling attached as listeners | fixed |
| Dialog focus order | Dialog component traps focus, returns it on close; new "Remove hidden data" dialog focuses its first control and announces results through `role="status"` | by code review and e2e |
| Contrast | tokens reviewed in both themes during the visual polish pass | see `docs/screenshots/0.1.3` |
| Lock state | lock icon in tab and status bar carries a text alternative; lifted state says "owner password" | done |

## Not possible here (open follow-ups, need people or hardware)

1. Usability sessions with 3 to 5 people on open, merge, annotate, fill, sign, compress.
2. Manual Orca pass (open, page navigation, tool menus, dialogs, announcements for errors and progress).
3. Opening the outputs (annotated, form-filled, signed, merged, compressed) in Acrobat Reader and Preview.
   Outputs are checked with poppler, MuPDF, qpdf and pdfcpu in `pnpm test:interop`.

Suggested session script and the fixed output set are `fixtures/generated/{annotated,acroform-prefilled,signed,images,text}.pdf`
processed through the corresponding commands.

## Known gaps carried over

Keyboard text-selection caret (separate card), PDF/UA tagging, localisation: out of scope per the card.
