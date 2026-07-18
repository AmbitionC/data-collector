import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

interface PairingDependencies {
  now: () => number;
  code: () => string;
  token: () => string;
}

interface PairingCode {
  code: string;
  expiresAt: number;
}

const DEFAULT_DEPENDENCIES: PairingDependencies = {
  now: () => Date.now(),
  code: () => String(Number.parseInt(randomBytes(4).toString('hex'), 16) % 1_000_000).padStart(6, '0'),
  token: () => randomBytes(32).toString('base64url'),
};

async function writeProtectedJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export class PairingManager {
  private pending: PairingCode | undefined;

  private constructor(
    private readonly authFile: string,
    private readonly dependencies: PairingDependencies,
    private currentToken?: string,
  ) {}

  static async open(
    authFile: string,
    overrides: Partial<PairingDependencies> = {},
  ): Promise<PairingManager> {
    let token: string | undefined;
    try {
      const stored = JSON.parse(await readFile(authFile, 'utf8')) as { token?: unknown };
      if (typeof stored.token === 'string' && stored.token.length >= 32) token = stored.token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return new PairingManager(authFile, { ...DEFAULT_DEPENDENCIES, ...overrides }, token);
  }

  createPairingCode(): { code: string; expiresAt: string } {
    const code = this.dependencies.code();
    if (!/^\d{6}$/.test(code)) throw new Error('配对码生成器必须返回 6 位数字');
    const expiresAt = this.dependencies.now() + 10 * 60 * 1000;
    this.pending = { code, expiresAt };
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  async exchange(code: string): Promise<string> {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || pending.code !== code || this.dependencies.now() > pending.expiresAt) {
      throw new Error('配对码无效或已过期');
    }
    const token = this.dependencies.token();
    if (token.length < 32) throw new Error('访问令牌长度不足');
    await writeProtectedJson(this.authFile, { version: 1, token });
    this.currentToken = token;
    return token;
  }

  verify(candidate: string): boolean {
    if (!this.currentToken || candidate.length < 1) return false;
    return timingSafeEqual(digest(this.currentToken), digest(candidate));
  }

  token(): string | undefined {
    return this.currentToken;
  }
}
