---
name: folio-service-tdd
description: Build or modify a Folio PDF/app service test-first. Use for any work in packages/services, packages/engine-pdfium, packages/db or packages/ai.
---
1. Read the requirement IDs for the service in SPEC §6 and §16.3. Drop anything tagged `Post-R1` or listed in §17.0.
2. Define or adjust the port in `packages/ports`; keep it engine-neutral (no PDFium types, PDF user-space coordinates).
3. Add fixture builders in `packages/testkit/src/fixtures`; never commit binary fixtures larger than 200 KB.
4. Write tests tagged `@FR-…` (unit next to the source as `*.test.ts`, engine behaviour in `tests/conformance`, oracle checks in `tests/interop`). Run them and confirm they fail for the right reason.
5. Implement the service. No UI, Tauri, DOM or Node imports. Throw the typed errors from `@folio/core` (`FolioError` subclasses).
6. Run `pnpm test`, `pnpm test:conformance`, `pnpm test:interop`, `pnpm trace`, `pnpm lint`, `pnpm check`.
7. Update `docs/adr` if a decision was made. Summarise the requirement IDs covered.

Service template:

```ts
export class ExampleService {
  constructor(private readonly deps: { engine: PdfEngine }) {}
  /** FR-XXX-NN */
  async doThing(doc: PdfDocument, input: Input): Promise<Output> { … }
}
```

Document changes that the user can undo are exposed as `Command` factories next to the service (`commands.ts`), never as direct mutations from the application layer.
