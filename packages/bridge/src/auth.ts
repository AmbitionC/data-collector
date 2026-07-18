import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

interface AccessTokenDependencies {
  token: () => string;
}

const DEFAULT_DEPENDENCIES: AccessTokenDependencies = {
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

export class AccessTokenManager {
  private constructor(
    private readonly authFile: string,
    private readonly dependencies: AccessTokenDependencies,
    private currentToken?: string,
  ) {}

  static async open(
    authFile: string,
    overrides: Partial<AccessTokenDependencies> = {},
  ): Promise<AccessTokenManager> {
    let token: string | undefined;
    try {
      const stored = JSON.parse(await readFile(authFile, 'utf8')) as { token?: unknown };
      if (typeof stored.token === 'string' && stored.token.length >= 32) token = stored.token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return new AccessTokenManager(authFile, { ...DEFAULT_DEPENDENCIES, ...overrides }, token);
  }

  async ensureToken(): Promise<string> {
    if (this.currentToken) return this.currentToken;
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
