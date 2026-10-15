import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { NOWCODER_COMPANIES, type CompanyId } from './nowcoderPlan.js';
import { validateCompanyInventory, validateCompanyOrder, type CompanyInventory } from './nowcoderInventory.js';

export interface NowcoderScheduleConfig {
  enabled: boolean;
  companies: CompanyId[];
  reviewOnly: true;
}

interface StoredSchedule { version: 1; config: NowcoderScheduleConfig; rotation: CompanyId[] }
const writeQueues = new Map<string, Promise<void>>();

function defaultSchedule(): StoredSchedule {
  return { version: 1, config: { enabled: false, companies: [...NOWCODER_COMPANIES], reviewOnly: true }, rotation: [...NOWCODER_COMPANIES] };
}

function configuration(input: unknown): NowcoderScheduleConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('牛客调度配置无效');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || Object.keys(value).some(key => !['enabled', 'companies', 'reviewOnly'].includes(key))
    || typeof value.enabled !== 'boolean' || value.reviewOnly !== true) throw new Error('牛客调度配置必须严格使用仅待审核模式');
  return { enabled: value.enabled, companies: validateCompanyOrder(value.companies), reviewOnly: true };
}

async function readSchedule(path: string): Promise<StoredSchedule> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSchedule();
    if (error instanceof SyntaxError) throw new Error('牛客调度状态文件格式无效', { cause: error });
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('牛客调度状态文件格式无效');
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1 || Object.keys(value).length !== 3
    || Object.keys(value).some(key => !['version', 'config', 'rotation'].includes(key))) throw new Error('牛客调度状态文件格式无效');
  const rotation = validateCompanyOrder(value.rotation);
  if (rotation.length !== NOWCODER_COMPANIES.length) throw new Error('牛客调度轮转状态无效');
  return { version: 1, config: configuration(value.config), rotation };
}

async function writeSchedule(path: string, value: StoredSchedule): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  writeQueues.set(path, tail);
  try { return await result; }
  finally { if (writeQueues.get(path) === tail) writeQueues.delete(path); }
}

export class NowcoderScheduleStore {
  private constructor(public readonly path: string, private value: StoredSchedule) {}

  static async open(path: string): Promise<NowcoderScheduleStore> {
    const canonicalPath = resolve(path);
    return new NowcoderScheduleStore(canonicalPath, await serialized(canonicalPath, () => readSchedule(canonicalPath)));
  }

  settings(): NowcoderScheduleConfig { return structuredClone(this.value.config); }

  async configure(input: unknown): Promise<NowcoderScheduleConfig> {
    const config = configuration(input);
    return await serialized(this.path, async () => {
      const previous = await readSchedule(this.path);
      const next = { ...previous, config };
      await writeSchedule(this.path, next);
      this.value = next;
      return this.settings();
    });
  }

  async prioritize(inventory: CompanyInventory, companies?: readonly CompanyId[]): Promise<CompanyId[]> {
    const requested = companies === undefined ? undefined : validateCompanyOrder(companies);
    return await serialized(this.path, async () => {
      const previous = await readSchedule(this.path);
      const configured = requested ?? previous.config.companies;
      validateCompanyInventory(inventory, configured);
      const order = [...configured].sort((left, right) =>
        (inventory[left].published + inventory[left].qualifiedPending)
        - (inventory[right].published + inventory[right].qualifiedPending)
        || previous.rotation.indexOf(left) - previous.rotation.indexOf(right));
      const first = order[0]!;
      const next: StoredSchedule = { ...previous, rotation: [...previous.rotation.filter(company => company !== first), first] };
      await writeSchedule(this.path, next);
      this.value = next;
      return order;
    });
  }
}
