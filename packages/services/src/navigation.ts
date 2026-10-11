import type { LinkInfo, LinkTarget, OutlineNode, PageIndex, PdfDocument, Point } from '@folio/ports';
import { containsPoint } from '@folio/core';

export interface FlatOutlineItem {
  title: string;
  depth: number;
  /** 0-based page, when the bookmark points into the document. */
  page?: PageIndex;
  target?: LinkTarget;
  hasChildren: boolean;
  /** Path of child indexes from the root, usable as a stable key. */
  path: number[];
}

/** What activating a link or bookmark should do. External links always need confirmation (FR-VIEW-05). */
export type LinkAction =
  | { kind: 'goto'; page: PageIndex; point?: Point; zoom?: number }
  | { kind: 'confirmExternal'; uri: string; host: string }
  | { kind: 'blocked'; reason: string };

/** Outline and links (FR-VIEW-02/05). */
export class NavigationService {
  constructor(private readonly doc: PdfDocument) {}

  async outline(): Promise<OutlineNode[]> {
    return this.doc.getOutline();
  }
  /** Outline flattened for a virtualised tree; `collapsed` holds the joined paths of closed nodes. */
  flatten(nodes: OutlineNode[], collapsed: ReadonlySet<string> = new Set()): FlatOutlineItem[] {
    const out: FlatOutlineItem[] = [];
    const walk = (list: OutlineNode[], depth: number, prefix: number[]): void => {
      list.forEach((n, k) => {
        const path = [...prefix, k];
        out.push({ title: n.title, depth, page: n.target?.kind === 'page' ? n.target.page : undefined, target: n.target, hasChildren: n.children.length > 0, path });
        if (n.children.length && !collapsed.has(path.join('.'))) walk(n.children, depth + 1, path);
      });
    };
    walk(nodes, 0, []);
    return out;
  }

  links(page: PageIndex): Promise<LinkInfo[]> {
    return this.doc.getLinks(page);
  }
  linkAt(links: LinkInfo[], p: Point): LinkInfo | undefined {
    return links.find((l) => containsPoint(l.rect, p));
  }

  /** Never opens anything by itself: page jumps are returned, web links must be confirmed, the rest is blocked. */
  resolve(target: LinkTarget | undefined): LinkAction {
    if (!target) return { kind: 'blocked', reason: 'none' };
    if (target.kind === 'page') {
      if (target.page < 0 || target.page >= this.doc.pageCount) return { kind: 'blocked', reason: 'missingPage' };
      return { kind: 'goto', page: target.page, point: target.point, zoom: target.zoom };
    }
    if (target.kind === 'uri') {
      let host = '';
      try {
        const url = new URL(target.uri);
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return { kind: 'blocked', reason: 'scheme' };
        host = url.protocol === 'mailto:' ? url.pathname : url.host;
      } catch {
        return { kind: 'blocked', reason: 'malformed' };
      }
      return { kind: 'confirmExternal', uri: target.uri, host };
    }
    return { kind: 'blocked', reason: target.reason };
  }
}
