import { OpenAiProvider } from '@folio/ai';
import { DEFAULT_SETTINGS, aiCapabilities, uuid, type Settings } from '@folio/core';
import { AiRunsRepo, CertificateRepo, DataCipher, FieldTemplateRepo, FormMappingRepo, ProfileRepo, RecentFilesRepo, SettingsRepo, SignatureRepo, StampRepo, migrate } from '@folio/db';
import type { AiProvider, OcrEngine, PdfEngine, Platform } from '@folio/ports';
import {
  AnnotationService,
  CertificateService,
  CompressService,
  DocumentService,
  ExportService,
  FormAuthoringService,
  FieldDetectionService,
  FormService,
  OcrLanguageRepo,
  OcrService,
  ImageToPdfService,
  MergeService,
  ObjectEditService,
  OutlineService,
  PageService,
  RecoveryService,
  SignatureService,
  SmartFillService,
  SplitService,
  TableService,
  StampService,
  TextEditService,
  type HandwritingFont,
} from '@folio/services';

export interface ServicesOptions {
  platform: Platform;
  engine: PdfEngine;
  /** Loads a bundled handwriting font (typed signatures). */
  loadFont: (name: HandwritingFont) => Promise<Uint8Array>;
  /** Overrides the OpenAI provider (tests). */
  ai?: AiProvider;
  /** Text recognition (FR-OCR-01); absent where it cannot run. */
  ocr?: OcrEngine;
  /** Reads the data of an OCR language that ships with the app. */
  loadOcrLanguage?: (code: string) => Promise<Uint8Array>;
  newId?: () => string;
}

/** Every service and repository, wired once at start-up. The UI and view-models only ever see this. */
export class Services {
  settings: Settings = { ...DEFAULT_SETTINGS };
  readonly newId: () => string;
  readonly settingsRepo: SettingsRepo;
  readonly recents: RecentFilesRepo;
  readonly signaturesRepo: SignatureRepo;
  readonly stampsRepo: StampRepo;
  readonly profiles: ProfileRepo;
  readonly templates: FieldTemplateRepo;
  readonly mappings: FormMappingRepo;
  readonly aiRuns: AiRunsRepo;
  readonly certificatesRepo: CertificateRepo;
  readonly certificates: CertificateService;
  readonly documents: DocumentService;
  readonly pages: PageService;
  readonly merge: MergeService;
  readonly split: SplitService;
  readonly imagesToPdf: ImageToPdfService;
  readonly exporter: ExportService;
  readonly compress: CompressService;
  readonly annotations: AnnotationService;
  readonly signatures: SignatureService;
  readonly stamps: StampService;
  readonly forms: FormService;
  readonly authoring: FormAuthoringService;
  readonly detection: FieldDetectionService;
  readonly textEdit: TextEditService;
  readonly objects: ObjectEditService;
  readonly outline: OutlineService;
  readonly recovery: RecoveryService;
  readonly smartFill: SmartFillService;
  readonly ocr: OcrService;
  readonly tables: TableService;
  readonly ocrLanguages: OcrLanguageRepo;
  readonly ai: AiProvider;
  readonly openAi?: OpenAiProvider;

  constructor(readonly opts: ServicesOptions) {
    const { platform, engine } = opts;
    const newId = (this.newId = opts.newId ?? (() => uuid()));
    const clock = platform.clock;
    const cipher = new DataCipher(platform.crypto, platform.secrets);
    this.settingsRepo = new SettingsRepo(platform.db, clock);
    this.recents = new RecentFilesRepo(platform.db, clock, newId);
    this.signaturesRepo = new SignatureRepo(platform.db, clock, newId, cipher);
    this.stampsRepo = new StampRepo(platform.db, clock, newId);
    this.profiles = new ProfileRepo(platform.db, clock, newId, cipher);
    this.templates = new FieldTemplateRepo(platform.db, clock, newId);
    this.mappings = new FormMappingRepo(platform.db, clock, newId);
    this.aiRuns = new AiRunsRepo(platform.db, clock, newId);
    this.certificatesRepo = new CertificateRepo(platform.db, clock);
    this.certificates = new CertificateService({ repo: this.certificatesRepo, secrets: platform.secrets, clock });
    this.documents = new DocumentService({ engine, files: platform.files, crypto: platform.crypto });
    this.pages = new PageService(engine);
    this.merge = new MergeService({ engine, images: platform.images });
    this.split = new SplitService(engine);
    this.imagesToPdf = new ImageToPdfService({ engine, images: platform.images });
    this.exporter = new ExportService(platform.images);
    this.compress = new CompressService({ engine, images: platform.images });
    // The author name setting wins; the OS user name is the default (FR-ANN-08).
    this.annotations = new AnnotationService({ author: () => this.settings.authorName || platform.app.userName || '', now: () => clock.now(), newId });
    this.signatures = new SignatureService({ engine, images: platform.images, font: opts.loadFont });
    this.stamps = new StampService({ now: () => clock.now(), locale: () => platform.app.locale });
    this.forms = new FormService({ newId });
    this.authoring = new FormAuthoringService();
    this.textEdit = new TextEditService();
    this.objects = new ObjectEditService(platform.images);
    this.outline = new OutlineService();
    this.recovery = new RecoveryService({ storage: platform.storage, clock });
    if (opts.ai) {
      this.ai = opts.ai;
    } else {
      this.openAi = new OpenAiProvider({ http: platform.http, secrets: platform.secrets, config: () => ({ baseUrl: this.settings.ai.baseUrl, model: this.settings.ai.model, structured: aiCapabilities(this.settings.ai).structured }) });
      this.ai = this.openAi;
    }
    this.smartFill = new SmartFillService({ crypto: platform.crypto, forms: this.forms, annotations: this.annotations, stamps: this.stamps, signatures: this.signatures, mappings: this.mappings, ai: this.ai, runs: this.aiRuns, images: platform.images, authoring: this.authoring });
    this.detection = new FieldDetectionService({ ai: this.ai, images: platform.images });
    this.tables = new TableService({ ai: this.ai, images: platform.images });
    this.ocr = new OcrService({ engine: opts.ocr, ai: this.ai, images: platform.images });
    this.ocrLanguages = new OcrLanguageRepo({
      storage: platform.storage,
      crypto: platform.crypto,
      downloader: platform.downloader,
      bundled: opts.loadOcrLanguage ?? (async (code) => Promise.reject(new Error(`No bundled OCR data for ${code}`))),
    });
  }

  get platform(): Platform {
    return this.opts.platform;
  }
  get engine(): PdfEngine {
    return this.opts.engine;
  }

  /** Runs migrations and loads settings. Call once before anything else. */
  async init(): Promise<void> {
    await migrate(this.platform.db);
    this.settings = await this.settingsRepo.load();
  }
}
