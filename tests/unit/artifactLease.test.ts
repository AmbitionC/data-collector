import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireArtifactLease,
  artifactLeasePath,
  withArtifactLease,
} from '../../scripts/artifact-lease.mjs';
import { createTemporaryDirectoryTracker } from '../helpers/temp.js';

const temporaryDirectories = createTemporaryDirectoryTracker();

afterEach(() => temporaryDirectories.cleanup());

function errorWithCode(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

async function writeCanonicalOwner(
  workspace: string,
  owner: unknown,
): Promise<string> {
  const canonical = artifactLeasePath(workspace);
  await mkdir(canonical, { recursive: true });
  await writeFile(join(canonical, 'owner.json'), JSON.stringify(owner), 'utf8');
  return canonical;
}

describe('artifact lease', () => {
  it('atomically gives the canonical lease to one contender and makes the next wait', async () => {
    const workspace = await temporaryDirectories.create('data-collector-artifact-lease-');
    const first = await acquireArtifactLease(workspace, {
      role: 'zsxq-sink',
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    let secondAcquired = false;
    const secondPromise = acquireArtifactLease(workspace, {
      role: 'package',
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    }).then(lease => {
      secondAcquired = true;
      return lease;
    });

    await new Promise(resolve => setTimeout(resolve, 30));
    expect(secondAcquired).toBe(false);
    expect(JSON.parse(await readFile(
      join(artifactLeasePath(workspace), 'owner.json'),
      'utf8',
    ))).toMatchObject({ token: first.token, role: 'zsxq-sink' });

    await first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    expect(JSON.parse(await readFile(
      join(artifactLeasePath(workspace), 'owner.json'),
      'utf8',
    ))).toMatchObject({ token: second.token, role: 'package' });
    await second.release();
  });

  it('always releases the lease when the protected operation throws', async () => {
    const workspace = await temporaryDirectories.create('data-collector-artifact-lease-');

    await expect(withArtifactLease(workspace, {
      role: 'package',
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    }, async () => {
      throw new Error('injected package failure');
    })).rejects.toThrow('injected package failure');

    const replacement = await acquireArtifactLease(workspace, {
      role: 'zsxq-sink',
      timeoutMs: 100,
      pollIntervalMs: 5,
    });
    await replacement.release();
  });

  it('recovers a valid lock only after kill(pid, 0) proves its owner is gone', async () => {
    const workspace = await temporaryDirectories.create('data-collector-artifact-lease-');
    const staleToken = 'stale-owner-token';
    await writeCanonicalOwner(workspace, {
      version: 1,
      pid: 424_242,
      token: staleToken,
      role: 'package',
      startedAt: '2026-08-25T00:00:00.000Z',
    });

    const lease = await acquireArtifactLease(workspace, {
      role: 'zsxq-sink',
      timeoutMs: 200,
      pollIntervalMs: 5,
      processKill: pid => {
        expect(pid).toBe(424_242);
        throw errorWithCode('ESRCH');
      },
    });

    expect(lease.token).not.toBe(staleToken);
    expect(await readdir(join(workspace, 'artifacts'))).toContain(
      `.data-collector-extension-lease.stale-${staleToken}`,
    );
    await lease.release();
  });

  it.each([
    ['a live owner', JSON.stringify({
      version: 1,
      pid: 525_252,
      token: 'live-owner-token',
      role: 'package',
      startedAt: '2026-08-25T00:00:00.000Z',
    }), undefined],
    ['an owner hidden by EPERM', JSON.stringify({
      version: 1,
      pid: 626_262,
      token: 'eperm-owner-token',
      role: 'zsxq-sink',
      startedAt: '2026-08-25T00:00:00.000Z',
    }), 'EPERM'],
    ['malformed owner metadata', '{broken-json', 'ESRCH'],
  ])('fails closed instead of stealing from %s', async (_label, owner, processError) => {
    const workspace = await temporaryDirectories.create('data-collector-artifact-lease-');
    const canonical = artifactLeasePath(workspace);
    await mkdir(canonical, { recursive: true });
    await writeFile(join(canonical, 'owner.json'), owner, 'utf8');

    await expect(acquireArtifactLease(workspace, {
      role: 'package',
      timeoutMs: 40,
      pollIntervalMs: 5,
      processKill: () => {
        if (processError) throw errorWithCode(processError);
      },
    })).rejects.toThrow(/artifact lease.*timeout/i);
    expect(await readFile(join(canonical, 'owner.json'), 'utf8')).toBe(owner);
  });

  it('fails closed on an empty canonical directory instead of replacing it on POSIX', async () => {
    const workspace = await temporaryDirectories.create('data-collector-artifact-lease-');
    const canonical = artifactLeasePath(workspace);
    await mkdir(canonical, { recursive: true });

    await expect(acquireArtifactLease(workspace, {
      role: 'package',
      timeoutMs: 40,
      pollIntervalMs: 5,
      processKill: () => { throw errorWithCode('ESRCH'); },
    })).rejects.toThrow(/artifact lease.*timeout/i);
    expect(await readdir(canonical)).toEqual([]);
  });

  it('fails closed when canonical exists but its owner file is missing', async () => {
    const workspace = await temporaryDirectories.create('data-collector-artifact-lease-');
    const canonical = artifactLeasePath(workspace);
    await mkdir(canonical, { recursive: true });
    await writeFile(join(canonical, 'unexpected-entry'), 'do not replace', 'utf8');

    await expect(acquireArtifactLease(workspace, {
      role: 'zsxq-sink',
      timeoutMs: 40,
      pollIntervalMs: 5,
      processKill: () => { throw errorWithCode('ESRCH'); },
    })).rejects.toThrow(/artifact lease.*timeout/i);
    expect(await readFile(join(canonical, 'unexpected-entry'), 'utf8')).toBe('do not replace');
  });

  it('uses the stale-owner token as an ABA tombstone so a second reaper cannot move the new owner', async () => {
    const workspace = await temporaryDirectories.create('data-collector-artifact-lease-');
    const stalePid = 737_373;
    const staleToken = 'shared-stale-token';
    await writeCanonicalOwner(workspace, {
      version: 1,
      pid: stalePid,
      token: staleToken,
      role: 'package',
      startedAt: '2026-08-25T00:00:00.000Z',
    });
    const options = {
      role: 'zsxq-sink',
      timeoutMs: 1_000,
      pollIntervalMs: 2,
      processKill: (pid: number) => {
        if (pid === stalePid) throw errorWithCode('ESRCH');
      },
    } as const;

    const contenders = [
      acquireArtifactLease(workspace, options),
      acquireArtifactLease(workspace, { ...options, role: 'package' }),
    ];
    const winner = await Promise.race(contenders.map(async (lease, index) => ({
      index,
      lease: await lease,
    })));
    const loserIndex = winner.index === 0 ? 1 : 0;
    let loserAcquired = false;
    void contenders[loserIndex]!.then(() => { loserAcquired = true; });

    await new Promise(resolve => setTimeout(resolve, 30));
    expect(loserAcquired).toBe(false);
    expect(JSON.parse(await readFile(
      join(artifactLeasePath(workspace), 'owner.json'),
      'utf8',
    ))).toMatchObject({ token: winner.lease.token, pid: process.pid });

    await winner.lease.release();
    const loser = await contenders[loserIndex]!;
    await loser.release();
  });

  it('refuses to release a canonical lease that has been replaced by another token', async () => {
    const workspace = await temporaryDirectories.create('data-collector-artifact-lease-');
    const lease = await acquireArtifactLease(workspace, {
      role: 'zsxq-sink',
      timeoutMs: 100,
      pollIntervalMs: 5,
    });
    const canonical = artifactLeasePath(workspace);
    await rename(canonical, `${canonical}.displaced`);
    await writeCanonicalOwner(workspace, {
      version: 1,
      pid: process.pid,
      token: 'replacement-owner-token',
      role: 'package',
      startedAt: new Date().toISOString(),
    });

    await expect(lease.release()).rejects.toThrow(/ownership.*changed/i);
    expect(JSON.parse(await readFile(join(canonical, 'owner.json'), 'utf8')))
      .toMatchObject({ token: 'replacement-owner-token' });
  });
});
