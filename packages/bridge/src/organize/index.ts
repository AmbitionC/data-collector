import {
  collectedDocumentSchema,
  HOT_MATERIAL_CATEGORY,
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
    summary: document.operationMaterial ? '未核实来源短摘；私有运营素材' : summarize(document.text, document.title),
    category: document.operationMaterial ? HOT_MATERIAL_CATEGORY : classification.category,
    tags: document.operationMaterial ? [...document.operationMaterial.editorial.emotionTags] : classification.tags,
  };
}
