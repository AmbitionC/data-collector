import type { OutreachAction, OutreachResult } from '@data-collector/shared';

/**
 * 在插件自己打开的发布页里执行（chrome.scripting 序列化，辅助函数必须写在函数体内）。
 *
 * 目前只实现「登录状态核对」。发布页面操作要在真实已登录后台核对过结构后才写进来，
 * 在那之前一律返回 CHANNEL_NOT_READY（明确没点任何按钮）。
 */
export async function runInvestOutreachPage(action: OutreachAction): Promise<OutreachResult> {
  const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const visibleText = () => (document.body?.innerText ?? '').slice(0, 5000);
  const verification = () => /安全验证|人机验证|滑动验证|请完成验证|访问验证/u.test(document.title)
    || [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="geetest"],.geetest_panel,.captcha,.verify-wrap')].length > 0;

  const wechatLoggedIn = (): boolean | undefined => {
    if (/[?&]token=\d+/u.test(location.search) && location.pathname.startsWith('/cgi-bin/')) return true;
    const text = visibleText();
    if (/使用账号登录|微信扫一扫，选择公众平台账号登录/u.test(text)) return false;
    return undefined;
  };
  const xueqiuLoggedIn = (): boolean | undefined => {
    const cookie = document.cookie.match(/(?:^|;\s*)xq_is_login=([^;]*)/u)?.[1];
    if (cookie === '1') return true;
    if (cookie === '0') return false;
    const text = visibleText();
    if (/登录\s*\/\s*注册|手机号登录|扫码登录/u.test(text) && !/我的首页|退出/u.test(text)) return false;
    return undefined;
  };

  // 后台首页登录后会跳转到带 token 的地址，给它几秒。
  let loggedIn: boolean | undefined;
  for (let i = 0; i < 16; i += 1) {
    if (verification()) return { kind: 'attention', code: 'VERIFICATION_REQUIRED', message: '平台要求验证，请在保留的页面完成', submission: 'not_attempted' };
    loggedIn = action.channel === 'wechat' ? wechatLoggedIn() : xueqiuLoggedIn();
    if (loggedIn !== undefined) break;
    await pause(500);
  }
  if (action.kind === 'outreach-account') {
    if (loggedIn === undefined) return { kind: 'attention', code: 'ACCOUNT_UNKNOWN', message: '无法判断登录状态', submission: 'not_attempted' };
    return { kind: 'outreach-account', channel: action.channel, loggedIn };
  }
  if (loggedIn !== true) {
    return { kind: 'attention', code: 'LOGIN_REQUIRED',
      message: action.channel === 'wechat' ? '公众号后台未登录，请在保留的页面扫码登录' : '雪球未登录，请在保留的页面登录',
      submission: 'not_attempted' };
  }
  return { kind: 'attention', code: 'CHANNEL_NOT_READY', message: '该渠道的自动发布页面操作尚未上线', submission: 'not_attempted' };
}
