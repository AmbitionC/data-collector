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
