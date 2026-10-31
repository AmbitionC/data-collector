// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.unstubAllGlobals(); });
async function setup(onSave: (role: string) => Promise<unknown> = async role => ({ ok: true, value: { role, bridgeStatus: 'connecting', browserFamily: 'chrome' } })) {
  vi.resetModules();
  document.open();
  document.write(await readFile(join(import.meta.dirname, '../../packages/extension/src/sidepanel/index.html'), 'utf8'));
  document.close();
  const requests: Array<{ type: string; role?: string }> = [];
  let statusReads = 0;
  vi.stubGlobal('chrome', { runtime: { sendMessage: async (message: { type: string; role?: string }) => {
    requests.push(message);
    if (message.type === 'connection.role.get') return { ok: true, value: { role: 'collector', browserFamily: 'chrome', bridgeStatus: 'connected' } };
    if (message.type === 'connection.role.set') return onSave(message.role!);
    if (message.type === 'status.get') { statusReads++; return { ok: true, value: { bridgeStatus: 'connected', page: { supported: true, list: false, title: '原帖', url: 'https://www.nowcoder.com/discuss/123' } } }; }
    return { ok: true, value: { entries: [] } };
  } } });
  await import('../../packages/extension/src/sidepanel/index.js');
  await vi.waitFor(() => expect(statusReads).toBeGreaterThan(0));
  return { requests };
}

describe('explicit connection role panel settings', () => {
  it('keeps role selection local until Save and displays the observed browser', async () => {
    const { requests } = await setup();
    const select = document.querySelector<HTMLSelectElement>('#connection-role');
    expect(select).not.toBeNull();
    expect(document.querySelector<HTMLElement>('#connection-settings')!.hidden).toBe(false);
    await vi.waitFor(() => expect(select!.value).toBe('collector'));
    select!.value = 'articles'; select!.dispatchEvent(new Event('change'));
    expect(requests.filter(item => item.type === 'connection.role.set')).toEqual([]);
    document.querySelector<HTMLButtonElement>('#connection-role-save')!.click();
    await vi.waitFor(() => expect(requests).toContainEqual({ type: 'connection.role.set', role: 'articles' }));
    expect(document.querySelector('#connection-role-status')!.textContent).toContain('Chrome');
  });

  it('retains an unsuccessful selection and settings error through normal status polling', async () => {
    await setup(async () => ({ ok: false, error: '浏览器操作进行中，请完成后再保存连接角色' }));
    const select = document.querySelector<HTMLSelectElement>('#connection-role');
    expect(select).not.toBeNull();
    select!.value = 'articles'; select!.dispatchEvent(new Event('change'));
    document.querySelector<HTMLButtonElement>('#connection-role-save')!.click();
    await vi.waitFor(() => expect(document.querySelector('#connection-role-error')?.textContent).toContain('进行中'));
    await new Promise(resolve => setTimeout(resolve, 1050));
    expect(select!.value).toBe('articles');
    expect(document.querySelector<HTMLElement>('#connection-role-error')!.hidden).toBe(false);
    expect(document.querySelector('#connection-role-error')!.textContent).toContain('进行中');
  });

  it('leaves existing operations editor text in place when settings save fails', async () => {
    await setup(async () => ({ ok: false, error: '请完成操作后再保存连接角色' }));
    const editor = document.querySelector<HTMLTextAreaElement>('#ops-primary')!;
    editor.value = '尚未保存的回复'; editor.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelector('#connection-role-save')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('#connection-role-save')!.click();
    await vi.waitFor(() => expect(document.querySelector('#connection-role-error')?.textContent).toContain('请完成'));
    expect(editor.value).toBe('尚未保存的回复');
  });
});
