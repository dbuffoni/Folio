// Shared helpers for service tests (not exported from the package index).
import { History } from '@folio/core';
import type { PdfDocument, PdfEngine } from '@folio/ports';
import { fixture, sharedEngine } from '@folio/testkit';

export async function openFixture(name: string, password?: string): Promise<{ engine: PdfEngine; doc: PdfDocument; history: History }> {
  const engine = await sharedEngine();
  const doc = await engine.open(await fixture(name), { password });
  return { engine, doc, history: new History({ doc, engine }) };
}
/** "Page N of M" / "marker-N" number of every page, 0 for pages without one. */
export async function markers(doc: PdfDocument): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < doc.pageCount; i++) {
    const t = (await doc.getTextLayer(i)).text;
    out.push(Number(/Page (\d+) of/.exec(t)?.[1] ?? 0));
  }
  return out;
}
/** Compact structural state used to compare a document before and after undo. */
export async function shape(doc: PdfDocument): Promise<string> {
  const parts: string[] = [];
  for (let i = 0; i < doc.pageCount; i++) {
    const info = await doc.getPageInfo(i);
    const t = (await doc.getTextLayer(i)).text;
    const annots = (await doc.listAnnotations(i)).map((a) => `${a.type}@${Math.round(a.rect.x)},${Math.round(a.rect.y)}`).join(';');
    parts.push(`${Math.round(info.size.width)}x${Math.round(info.size.height)}r${info.rotation}:${t.slice(0, 24).replace(/\s+/g, ' ')}[${annots}]`);
  }
  return parts.join('|');
}
