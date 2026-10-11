---
description: Run the TDD recipe for one service (test-author, then service-implementer)
argument-hint: <ServiceName>
---
Build the service `$ARGUMENTS` following SPEC §16.7:
1. spec-guardian: extract in-scope requirement IDs and acceptance criteria from SPEC §6/§16.3; list out-of-scope items.
2. test-author: write fixtures and failing tests tagged with the IDs (no access to the implementation).
3. service-implementer: implement until green.
4. pdf-interop-verifier: run the oracles on outputs.
5. security-reviewer if the service parses untrusted data or touches secrets.
6. `pnpm trace`, `pnpm lint`, `pnpm check`; summarise covered IDs.
