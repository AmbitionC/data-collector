import { hotMaterialId } from '@data-collector/shared';
import { canonicalNowcoderDetailUrl } from '../feJourney/nowcoderSearchRecord.js';

/** Validate the separate catalog namespace before excluding private material from interview readers. */
export function isHotMaterialCatalogEntry(entry: {
  id: string; source: string; url: string; materialKind?: unknown; nowcoderReviewOnly?: unknown;
}): boolean {
  if (entry.materialKind === undefined && !entry.id.startsWith('hot-')) return false;
  if ((entry.materialKind !== undefined && entry.materialKind !== 'nowcoder-hot')
    || entry.source !== 'nowcoder' || canonicalNowcoderDetailUrl(entry.url) !== entry.url
    || entry.id !== hotMaterialId(entry.url) || entry.nowcoderReviewOnly === true) {
    throw new Error('热帖素材身份或面经归属不一致');
  }
  return true;
}
