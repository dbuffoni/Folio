#!/usr/bin/env -S npx tsx
// folio-cli — development and verification driver for the headless services (SPEC §16.1.8).
// Not a product feature: it exists so services can be exercised from a terminal or a script.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parsePageRanges, isFolioError } from '@folio/core';
import { createNodeEngine } from '@folio/engine-pdfium/node';
import { ExportService, FormService, ImageToPdfService, MergeService, PageService, SplitService, TextEditService, planFiles, planSplit } from '@folio/services';

type Flags = Record<string, string | boolean>;
function parse(argv: string[]): { args: string[]; flags: Flags } {
  const args: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-o') flags.out = argv[++i]!;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k!] = v ?? (argv[i + 1] && !argv[i + 1]!.startsWith('-') ? argv[++i]! : true);
    } else args.push(a);
  }
  return { args, flags };
}
const need = (flags: Flags, name: string): string => {
  const v = flags[name];
  if (typeof v !== 'string') throw new Error(`Missing --${name}`);
  return v;
};
const USAGE = `folio-cli <command>

  info <file> [--password=…]                      pages, metadata, fields, annotations
  text <file> [--page=N]                          extracted text
  merge <a.pdf|a.png> <b.pdf> … -o out.pdf        [--no-bookmarks] [--flatten-forms]
  split <file> --every=N | --ranges=1-3,4- | --single  -o outDir [--template={name}_{n}]
  rotate <file> --pages=1-3 --deg=90 -o out.pdf
  delete <file> --pages=2,5 -o out.pdf
  extract <file> --pages=1-3 -o out.pdf
  images <a.jpg> <b.png> … -o out.pdf             [--page-size=A4|image] [--margin=36]
  export <file> --dpi=150 [--format=png|jpeg] [--pages=1-2] -o outDir
  fill <file> --set name=value [--set …] -o out.pdf   (repeat --set by comma: a=1,b=2)
  edit-text <file> --page=1 --find=Invoce --replace=Invoice -o out.pdf
  flatten <file> -o out.pdf
  fixtures [-o fixtures/generated]                write every generated fixture
`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { args, flags } = parse(rest);
  if (!command || command === 'help' || flags.help) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  const { NodeImageCodec, FIXTURES, fixture } = await import('@folio/testkit');
  const engine = await createNodeEngine();
  const images = new NodeImageCodec();
  const open = async (path: string) => engine.open(await readFile(path), { password: typeof flags.password === 'string' ? flags.password : undefined });
  const save = async (path: string, bytes: Uint8Array) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    process.stdout.write(`wrote ${path} (${bytes.length} bytes)\n`);
  };
  try {
    switch (command) {
      case 'info': {
        const doc = await open(args[0]!);
        const fields = await doc.listFormFields();
        const annots: Record<string, number> = {};
        for (let p = 0; p < doc.pageCount; p++) for (const a of await doc.listAnnotations(p)) annots[a.type] = (annots[a.type] ?? 0) + 1;
        process.stdout.write(`${JSON.stringify({ pages: doc.pageCount, meta: await doc.getMeta(), fields: fields.map((f) => ({ name: f.name, type: f.type, value: f.value })), annotations: annots, outline: (await doc.getOutline()).map((n) => n.title) }, null, 2)}\n`);
        break;
      }
      case 'text': {
        const doc = await open(args[0]!);
        const pages = flags.page ? [Number(flags.page) - 1] : Array.from({ length: doc.pageCount }, (_, i) => i);
        for (const p of pages) process.stdout.write(`${(await doc.getTextLayer(p)).text.replace(/\r\n/g, '\n')}\n`);
        break;
      }
      case 'merge': {
        const sources = [];
        for (const path of args) sources.push({ name: basename(path), bytes: await readFile(path) });
        const out = await new MergeService({ engine, images }).merge(sources, { bookmarks: !flags['no-bookmarks'], keepFormFields: !flags['flatten-forms'] });
        await save(need(flags, 'out'), await out.save());
        break;
      }
      case 'split': {
        const doc = await open(args[0]!);
        const mode = flags.every ? ({ kind: 'everyN', n: Number(flags.every) } as const) : flags.single ? ({ kind: 'single' } as const) : ({ kind: 'ranges', ranges: need(flags, 'ranges').split(';') } as const);
        const dir = need(flags, 'out');
        const files = await planFiles(planSplit(doc.pageCount, mode), { template: typeof flags.template === 'string' ? flags.template : '{name}_{n}', sourceName: basename(args[0]!), policy: 'overwrite', exists: async () => false });
        await new SplitService(engine).execute(doc, files, (name, bytes) => save(join(dir, name), bytes), { overwrite: () => true });
        break;
      }
      case 'rotate':
      case 'delete': {
        const doc = await open(args[0]!);
        const pages = parsePageRanges(need(flags, 'pages'), doc.pageCount);
        const svc = new PageService(engine);
        const cmd = command === 'rotate' ? svc.rotate(doc, pages, Number(flags.deg ?? 90) as 90 | 180 | 270) : svc.delete(doc, pages);
        await cmd.apply({ doc, engine, invalidate: () => undefined });
        await save(need(flags, 'out'), await doc.save());
        break;
      }
      case 'extract': {
        const doc = await open(args[0]!);
        const out = await new PageService(engine).extract(doc, parsePageRanges(need(flags, 'pages'), doc.pageCount));
        await save(need(flags, 'out'), await out.save());
        break;
      }
      case 'images': {
        const inputs = [];
        for (const path of args) inputs.push({ name: basename(path), bytes: await readFile(path) });
        const doc = await new ImageToPdfService({ engine, images }).create(inputs, { pageSize: (flags['page-size'] as 'A4' | 'image' | undefined) ?? 'A4', margin: Number(flags.margin ?? 36) });
        await save(need(flags, 'out'), await doc.save());
        break;
      }
      case 'export': {
        const doc = await open(args[0]!);
        const pages = parsePageRanges(typeof flags.pages === 'string' ? flags.pages : '', doc.pageCount);
        const out = await new ExportService(images).exportPages(doc, pages, { format: (flags.format as 'png' | 'jpeg' | undefined) ?? 'png', dpi: Number(flags.dpi ?? 150) }, basename(args[0]!));
        for (const img of out) await save(join(need(flags, 'out'), img.name), img.bytes);
        break;
      }
      case 'fill': {
        const doc = await open(args[0]!);
        const forms = new FormService({ newId: () => 'cli' });
        const fields = await forms.fields(doc);
        for (const pair of need(flags, 'set').split(',')) {
          const [name, ...value] = pair.split('=');
          const field = fields.find((f) => f.name === name);
          if (!field) throw new Error(`No field "${name}". Fields: ${fields.map((f) => f.name).join(', ')}`);
          const v = value.join('=');
          await forms.fill(field, field.type === 'checkbox' ? /^(true|yes|1|on)$/i.test(v) : field.type === 'listbox' ? v.split('|') : v).apply({ doc, engine, invalidate: () => undefined });
        }
        await save(need(flags, 'out'), await doc.save());
        break;
      }
      case 'edit-text': {
        const doc = await open(args[0]!);
        const page = Number(flags.page ?? 1) - 1;
        const svc = new TextEditService();
        const layer = await doc.getTextLayer(page);
        const find = need(flags, 'find');
        const line = svc.lines(layer).find((l) => l.text.includes(find));
        if (!line) throw new Error(`"${find}" not found on page ${page + 1}`);
        const res = await svc.editLine(page, layer, line, line.text.replace(find, need(flags, 'replace')), await doc.getPageInfo(page)).apply({ doc, engine, invalidate: () => undefined });
        process.stdout.write(`${JSON.stringify({ font: res.font, overflow: res.overflow })}\n`);
        await save(need(flags, 'out'), await doc.save());
        break;
      }
      case 'flatten': {
        const doc = await open(args[0]!);
        await doc.flattenForm();
        await doc.flattenAnnotations();
        await save(need(flags, 'out'), await doc.save());
        break;
      }
      case 'fixtures': {
        const dir = typeof flags.out === 'string' ? flags.out : 'fixtures/generated';
        for (const [name, entry] of Object.entries(FIXTURES)) if (!entry.heavy || flags.all) await save(join(dir, `${name}.pdf`), await fixture(name));
        break;
      }
      default:
        process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${isFolioError(e) ? `${e.code}: ${e.message}` : (e as Error).message}\n`);
    return 1;
  } finally {
    await engine.dispose();
  }
}

process.exit(await main());
