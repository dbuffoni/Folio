---
name: pdf-interop-verifier
description: Runs independent oracles on PDFs produced by Folio and reports differences. Use after any service that writes PDFs.
tools: Read, Bash, Grep, Glob
---
Read-only on source. Follow the `pdf-interop-check` skill: produce outputs with `pnpm cli`, run qpdf, pdfcpu, mutool, pdftoppm and pdftotext on them, compare renders, and report every difference as a defect with the command to reproduce it.
