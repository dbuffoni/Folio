import { Emitter } from '@folio/core';
import type { PageIndex, SearchHit } from '@folio/ports';
import { stepMatch } from '@folio/services';
import type { DocumentSession } from './session.ts';

export type DialogId = 'settings' | 'merge' | 'split' | 'images' | 'exportImages' | 'compress' | 'signature' | 'stampEditor' | 'properties' | 'metadata' | 'insertBlank' | 'print' | 'history' | 'profiles' | 'shortcuts' | 'privacy' | 'about';

/** Search state of one document (FR-VIEW-04). */
export class FindModel {
  readonly changed = new Emitter<void>();
  open = false;
  query = '';
  matchCase = false;
  wholeWord = false;
  hits: SearchHit[] = [];
  current = -1;
  searching = false;
  private run = 0;

  constructor(private readonly session: DocumentSession) {
    // Edits can move or remove matches: search again when the content changes.
    session.invalidated.on((inv) => {
      if (this.open && this.query && inv.kind !== 'annotations' && inv.kind !== 'meta') void this.search();
    });
  }
  toggle(open = !this.open): void {
    this.open = open;
    if (!open) {
      this.hits = [];
      this.current = -1;
    }
    this.changed.emit();
  }
  async setQuery(query: string): Promise<void> {
    this.query = query;
    await this.search();
  }
  async setOptions(opts: { matchCase?: boolean; wholeWord?: boolean }): Promise<void> {
    Object.assign(this, opts);
    await this.search();
  }
  /** Fills the result list page by page; a newer search supersedes an older one. */
  async search(): Promise<void> {
    const run = ++this.run;
    this.hits = [];
    this.current = -1;
    this.searching = this.query !== '';
    this.changed.emit();
    if (this.query === '') return;
    const all: SearchHit[] = [];
    try {
      await this.session.text.search(
        { text: this.query, matchCase: this.matchCase, wholeWord: this.wholeWord },
        {
          onPage: (_page, hits) => {
            if (run !== this.run || hits.length === 0) return;
            all.push(...hits);
            this.hits = [...all];
            // Jump to the first match on or after the page being read as soon as one is known.
            if (this.current < 0 && all[all.length - 1]!.page >= this.session.view.page) this.select(this.firstFrom(this.session.view.page));
            else this.changed.emit();
          },
        },
      );
    } finally {
      if (run === this.run) {
        if (this.current < 0 && this.hits.length) this.select(this.firstFrom(this.session.view.page));
        this.searching = false;
        this.changed.emit();
      }
    }
  }
  /** The first match on or after the page the user is looking at. */
  private firstFrom(page: PageIndex): number {
    const at = this.hits.findIndex((h) => h.page >= page);
    return at < 0 ? 0 : at;
  }
  select(index: number): void {
    if (index < 0 || index >= this.hits.length) return;
    this.current = index;
    this.session.goToPage(this.hits[index]!.page);
    this.changed.emit();
  }
  /** Enter / Shift+Enter, wrapping around. */
  step(direction: 1 | -1): void {
    this.select(stepMatch(this.hits.length, this.current, direction));
  }
  /** "2 of 7". */
  get position(): { index: number; total: number } {
    return { index: this.current + 1, total: this.hits.length };
  }
  hitsOnPage(page: PageIndex): Array<SearchHit & { active: boolean }> {
    return this.hits.map((h, i) => ({ ...h, active: i === this.current })).filter((h) => h.page === page);
  }
}

/** Window-level UI state that is not tied to a document. */
export class UiState {
  readonly changed = new Emitter<void>();
  dialog: DialogId | null = null;
  palette = false;
  sidebarOpen = true;
  inspectorOpen = true;
  /** Coach marks step (0–2), or null when finished or skipped. */
  coach: number | null = null;

  private emit(): void {
    this.changed.emit();
  }
  openDialog(id: DialogId): void {
    this.dialog = id;
    this.palette = false;
    this.emit();
  }
  closeDialog(): void {
    this.dialog = null;
    this.emit();
  }
  togglePalette(open = !this.palette): void {
    this.palette = open;
    if (open) this.dialog = null;
    this.emit();
  }
  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
    this.emit();
  }
  toggleInspector(): void {
    this.inspectorOpen = !this.inspectorOpen;
    this.emit();
  }
  /** First run: three skippable coach marks (modes, sign, command palette). */
  startCoach(done: boolean): void {
    this.coach = done ? null : 0;
    this.emit();
  }
  nextCoach(): boolean {
    if (this.coach === null) return false;
    this.coach = this.coach >= 2 ? null : this.coach + 1;
    this.emit();
    return this.coach === null;
  }
  skipCoach(): void {
    this.coach = null;
    this.emit();
  }
}
