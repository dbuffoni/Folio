import { writeFileSync } from 'node:fs';
import { bigDoc } from '@folio/testkit';
writeFileSync(process.argv[2] ?? 'perf-300.pdf', await bigDoc(300));
