import { describe, expect, it } from 'vitest';
import * as protocolModule from '../../packages/extension/src/contentProtocol.js';

describe('content-script request build fence', () => {
  it('derives disjoint request types for every content operation when the exact build changes', () => {
    const contentRequestType = (
      protocolModule as unknown as {
        contentRequestType?: (request: string, buildId: string) => string;
      }
    ).contentRequestType;

    expect(contentRequestType).toBeTypeOf('function');
    if (!contentRequestType) return;

    const operations = [
      'extract.document',
      'extract.list',
      'list.selectView',
      'list.restore',
      'list.advance',
      'list.refreshTopics',
      'list.diagnose',
      'list.highlight',
      'list.itemDiagnose',
      'list.hookStats',
      'list.focusLast',
    ];
    for (const operation of operations) {
      const buildA = contentRequestType(operation, 'v0.4.29 · build-A');
      const buildB = contentRequestType(operation, 'v0.4.29 · build-B');
      expect(buildA).not.toBe(buildB);
      expect(buildA).toContain('build-A');
      expect(buildB).toContain('build-B');
    }
  });

  it('exports one exact-current-build request type for every production operation', () => {
    const protocol = protocolModule as unknown as Record<string, unknown> & {
      CONTENT_BUILD_ID: string;
      contentRequestType: (request: string, buildId: string) => string;
    };
    const operations = {
      CONTENT_DOCUMENT_REQUEST: 'extract.document',
      CONTENT_LIST_REQUEST: 'extract.list',
      CONTENT_SELECT_VIEW_REQUEST: 'list.selectView',
      CONTENT_RESTORE_REQUEST: 'list.restore',
      CONTENT_ADVANCE_REQUEST: 'list.advance',
      CONTENT_REFRESH_TOPICS_REQUEST: 'list.refreshTopics',
      CONTENT_DIAGNOSE_REQUEST: 'list.diagnose',
      CONTENT_HIGHLIGHT_REQUEST: 'list.highlight',
      CONTENT_ITEM_DIAGNOSE_REQUEST: 'list.itemDiagnose',
      CONTENT_HOOK_STATS_REQUEST: 'list.hookStats',
      CONTENT_FOCUS_LAST_REQUEST: 'list.focusLast',
    };

    for (const [exportName, operation] of Object.entries(operations)) {
      expect(protocol[exportName]).toBe(
        protocol.contentRequestType(operation, protocol.CONTENT_BUILD_ID),
      );
    }
  });
});
