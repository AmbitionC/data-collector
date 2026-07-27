import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APP_VERSION,
  MANIFEST_PUBLIC_KEY,
  TRUSTED_EXTENSION_ID,
  TRUSTED_EXTENSION_ORIGINS,
  bridgeAuthorizedPayloadSchema,
} from '@data-collector/shared';

describe('fixed extension identity and authorization payload', () => {
  it('derives the fixed extension ID from the manifest public key', () => {
    const digest = createHash('sha256').update(Buffer.from(MANIFEST_PUBLIC_KEY, 'base64')).digest();
    const derived = [...digest.subarray(0, 16)]
      .flatMap(byte => [byte >> 4, byte & 15])
      .map(nibble => String.fromCharCode(97 + nibble)).join('');
    expect(derived).toBe('ehblgjpcidoabjhojfhiaaobaacphhck');
    expect(TRUSTED_EXTENSION_ID).toBe(derived);
    expect(TRUSTED_EXTENSION_ORIGINS).toEqual(new Set([
      `chrome-extension://${derived}`,
      `extension://${derived}`,
    ]));
    expect(APP_VERSION).toBe('0.2.1');
  });

  it('accepts only strong authorization tokens', () => {
    expect(bridgeAuthorizedPayloadSchema.parse({ token: 'x'.repeat(43) })).toEqual({ token: 'x'.repeat(43) });
    expect(() => bridgeAuthorizedPayloadSchema.parse({ token: 'short' })).toThrow();
  });
});
