import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../packages/bridge/src/config.js';

describe('Bridge config', () => {
  it('keeps the ZSXQ day ledger in the private config directory', () => {
    const config = loadConfig({
      configDir: '/tmp/data-collector-config',
      libraryRoot: '/tmp/data-collector-library',
    });

    expect(config.zsxqLedgerFile).toBe('/tmp/data-collector-config/zsxq-day-ledger.json');
  });
});
