import type { OrganizedDocument } from '../organize/index.js';
import { LIBRARY_CATEGORIES } from '../organize/classify.js';
import { MarkdownLibrary, type MarkdownLibraryOptions } from '../library/index.js';
import type { ContentSink, SinkResult } from './types.js';
import type { LocalDocumentEvidence } from '../library/storedDocument.js';

/**
 * 本机 Markdown 知识库 sink：包住既有 MarkdownLibrary，保持 0.2.0 行为不变，
 * 是默认且永远开启的落地目标。
 */
export class MarkdownLibrarySink implements ContentSink {
  readonly id = 'markdown';
  readonly label = '本机库';
  readonly categories = LIBRARY_CATEGORIES;
  readonly root: string;
  private readonly library: MarkdownLibrary;

  constructor(options: MarkdownLibraryOptions) {
    this.root = options.root;
    this.library = new MarkdownLibrary(options);
  }

  async save(input: OrganizedDocument): Promise<SinkResult> {
    return await this.saveLocal(input);
  }

  async saveLocal(
    input: OrganizedDocument,
    localEvidence?: LocalDocumentEvidence,
  ): Promise<SinkResult> {
    const saved = await this.library.save(input, localEvidence);
    return {
      sinkId: this.id,
      ok: true,
      outputRef: saved.markdownPath,
      detail: {
        id: saved.id,
        downloadedImages: saved.downloadedImages,
        failedImages: saved.failedImages,
      },
    };
  }
}
