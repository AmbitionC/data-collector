import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../packages/bridge/src/config.js';

describe('Bridge config', () => {
  it('accepts only an explicitly absolute private interview history location', () => {
    expect(loadConfig({ interviewHistoryPath: '/tmp/private/source-history.json' }).interviewHistoryPath).toBe('/tmp/private/source-history.json');
    expect(() => loadConfig({ interviewHistoryPath: 'relative/source-history.json' })).toThrow('绝对路径');
  });
  it('keeps the ZSXQ day ledger in the private config directory', () => {
    const config = loadConfig({
      configDir: '/tmp/data-collector-config',
      libraryRoot: '/tmp/data-collector-library',
    });

    expect(config.zsxqLedgerFile).toBe('/tmp/data-collector-config/zsxq-day-ledger.json');
  });
});


it('keeps a separate explicit published inventory root independent of delivery destinations', () => {
  expect(loadConfig({ interviewInventoryRoot: '/tmp/published-snapshot' }).interviewInventoryRoot).toBe('/tmp/published-snapshot');
  expect(() => loadConfig({ interviewInventoryRoot: 'relative/snapshot' })).toThrow('绝对路径');
});


it('accepts an explicit full publication commit and rejects abbreviated or unsafe authority', () => {
  expect(loadConfig({ interviewInventoryCommit: 'd'.repeat(40) }).interviewInventoryCommit).toBe('d'.repeat(40));
  for (const value of ['da1553e', 'HEAD', '../master', 'D'.repeat(40)]) expect(() => loadConfig({ interviewInventoryCommit: value })).toThrow('40');
});
