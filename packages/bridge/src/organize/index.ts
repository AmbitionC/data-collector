import {
  collectedDocumentSchema,
  type CollectedDocument,
} from '@data-collector/shared';
import { classify } from './classify.js';
import { sanitizeCollectedHtml } from './sanitize.js';
import { summarize } from './summarize.js';

export { classify } from './classify.js';
export { sanitizeCollectedHtml } from './sanitize.js';
export { keywords, summarize } from './summarize.js';

export interface OrganizedDocument {
  document: CollectedDocument;
  sanitizedHtml: string;
  summary: string;
  category: string;
  tags: string[];
}

export function organize(input: CollectedDocument): OrganizedDocument {
  const document = collectedDocumentSchema.parse(input) as CollectedDocument;
  const sanitizedHtml = sanitizeCollectedHtml(document.html, document.canonicalUrl);
  const classification = classify({
    title: document.title,
    text: document.text,
    ...(document.suggestedCategory ? { suggestedCategory: document.suggestedCategory } : {}),
    ...(document.suggestedTags ? { suggestedTags: document.suggestedTags } : {}),
    ...(document.userCategory ? { userCategory: document.userCategory } : {}),
    ...(document.userTags ? { userTags: document.userTags } : {}),
  });
  return {
    document,
    sanitizedHtml,
    summary: summarize(document.text, document.title),
    category: classification.category,
    tags: classification.tags,
  };
}
