import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessTokenManager } from '../../packages/bridge/src/auth.js';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();

afterEach(() => temporaryDirectories.cleanup());

describe('access token storage', () => {
  it('creates a protected token once and reuses it after reopening', async () => {
    const root = await temporaryDirectories.create('data-collector-bridge-auth-');
    const authFile = join(root, 'auth.json');
    const token = 'a'.repeat(43);
    const manager = await AccessTokenManager.open(authFile, { token: () => token });

    expect(manager.token()).toBeUndefined();
    expect(await manager.ensureToken()).toBe(token);
    expect(manager.verify(token)).toBe(true);

    const reopened = await AccessTokenManager.open(authFile);
    expect(await reopened.ensureToken()).toBe(token);
    expect((await stat(authFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(authFile, 'utf8'))).toEqual({ version: 1, token });
  });

  it('rejects a dependency token shorter than 32 characters', async () => {
    const root = await temporaryDirectories.create('data-collector-bridge-auth-');
    const manager = await AccessTokenManager.open(join(root, 'auth.json'), { token: () => 'short-token' });

    await expect(manager.ensureToken()).rejects.toThrow('访问令牌长度不足');
  });

  it('does not expose pairing-code APIs', async () => {
    const root = await temporaryDirectories.create('data-collector-bridge-auth-');
    const manager = await AccessTokenManager.open(join(root, 'auth.json'));

    expect(manager).not.toHaveProperty('createPairingCode');
    expect(manager).not.toHaveProperty('exchange');
  });
});
