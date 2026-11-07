import { Emitter } from '@folio/core';
import type { PageIndex, SearchHit } from '@folio/ports';
import { stepMatch } from '@folio/services';
import type { DocumentSession } from './session.ts';

export type DialogId = 'settings' | 'merge' | 'split' | 'images' | 'exportImages' | 'compress' | 'ocr' | 'tables' | 'signature' | 'digitalSign' | 'signatures' | 'stampEditor' | 'properties' | 'metadata' | 'hiddenData' | 'insertBlank' | 'print' | 'history' | 'profiles' | 'shortcuts' | 'privacy' | 'about' | 'aiDebug';

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

/** The panes of the Settings dialog. */
export type SettingsPane = 'appearance' | 'smartFill' | 'profiles' | 'ocr' | 'certificates' | 'general' | 'privacy' | 'about';

/** Slides of the tutorial: modes, automatic form filling, profile, AI and key, data on the device, done. */
export const TUTORIAL_SLIDES = 6;

/** Window-level UI state that is not tied to a document. */
export class UiState {
  readonly changed = new Emitter<void>();
  dialog: DialogId | null = null;
  /** The Settings pane to show when the dialog opens (a link such as "Import a certificate in Settings" names it). */
  settingsPane: SettingsPane | null = null;
  palette = false;
  sidebarOpen = true;
  inspectorOpen = true;
  /** Tutorial slide shown (0-based), or null when it is closed. */
  tutorial: number | null = null;
  /** Slide to return to when the Settings opened from a slide is closed. */
  tutorialResume: number | null = null;

  private emit(): void {
    this.changed.emit();
  }
  /** Opens Settings on a given pane, not on the first one. */
  openSettings(pane: SettingsPane): void {
    this.settingsPane = pane;
    this.openDialog('settings');
  }
  openDialog(id: DialogId): void {
    if (id !== 'settings') this.settingsPane = null;
    this.dialog = id;
    this.palette = false;
    this.emit();
  }
  closeDialog(): void {
    this.dialog = null;
    if (this.tutorialResume !== null) {
      this.tutorial = this.tutorialResume;
      this.tutorialResume = null;
    }
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
  /** First start: the tutorial opens by itself unless it was seen before (setting `onboardingDone`). */
  startTutorial(alreadySeen: boolean): void {
    this.tutorial = alreadySeen ? null : 0;
    this.emit();
  }
  /** Help ▸ Tutorial: always from the first slide, over whatever is on screen. */
  openTutorial(): void {
    this.dialog = null;
    this.palette = false;
    this.tutorial = 0;
    this.emit();
  }
  /** Moves on; false after the last slide (the caller then closes the tutorial). */
  nextTutorial(): boolean {
    if (this.tutorial === null || this.tutorial >= TUTORIAL_SLIDES - 1) return false;
    this.tutorial++;
    this.emit();
    return true;
  }
  backTutorial(): void {
    if (this.tutorial === null || this.tutorial === 0) return;
    this.tutorial--;
    this.emit();
  }
  /** A dot of the progress bar. */
  gotoTutorial(slide: number): void {
    if (this.tutorial === null || slide < 0 || slide >= TUTORIAL_SLIDES) return;
    this.tutorial = slide;
    this.emit();
  }
  closeTutorial(): void {
    this.tutorial = null;
    this.tutorialResume = null;
    this.emit();
  }
  /**
   * A slide's link to a Settings pane: the tutorial steps aside, Settings opens on the pane, and closing Settings
   * brings the tutorial back on the same slide.
   */
  tutorialToSettings(pane: SettingsPane): void {
    this.tutorialResume = this.tutorial;
    this.tutorial = null;
    this.openSettings(pane);
  }
}
