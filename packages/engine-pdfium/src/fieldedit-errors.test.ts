import { describe, expect, it } from 'vitest';
import { InvalidPdfError } from '@folio/core';
import { addFields, deleteField, moveWidget, patchField } from './fieldedit.ts';

const garbage = new TextEncoder().encode('this is not a PDF at all');

describe('Field authoring on bytes the structural helper cannot read (R7) @FR-FRM-08 @FR-FRM-11', () => {
  it('reports an invalid PDF with its own message, not an encrypted file @FR-FRM-08 @FR-FRM-11', async () => {
    const rect = { x: 10, y: 10, width: 100, height: 20 };
    for (const run of [
      () => addFields(garbage, [{ type: 'text', name: 'a', page: 0, rect }]),
      () => patchField(garbage, 'a', { required: true }),
      () => moveWidget(garbage, 'a', 0, rect),
      () => deleteField(garbage, 'a'),
    ]) {
      const err = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(InvalidPdfError);
      expect(err).toMatchObject({ code: 'invalidPdf', params: { reason: 'formEdit' } });
    }
  });
});
