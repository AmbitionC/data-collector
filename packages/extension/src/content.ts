import type { CollectedDocument } from '@data-collector/shared';
import { ExtractionError, extractDocument } from './extractors/index.js';

interface ExtractMessage {
  type: 'extract.document';
  overrides?: {
    userCategory?: string;
    userTags?: string[];
  };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as Partial<ExtractMessage>;
  if (request.type !== 'extract.document') return false;
  try {
    const extracted = extractDocument(document, location.href);
    const result: CollectedDocument = {
      ...extracted,
      ...(request.overrides?.userCategory
        ? { userCategory: request.overrides.userCategory }
        : {}),
      ...(request.overrides?.userTags ? { userTags: request.overrides.userTags } : {}),
    };
    sendResponse({ ok: true, document: result });
  } catch (error) {
    sendResponse({
      ok: false,
      error: {
        code: error instanceof ExtractionError ? error.code : 'COLLECTION_FAILED',
        message: error instanceof Error ? error.message : '页面采集失败',
      },
    });
  }
  return false;
});
