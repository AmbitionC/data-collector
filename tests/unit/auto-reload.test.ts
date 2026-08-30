import { describe, expect, it } from 'vitest';
import {
  hasNewBuild,
  isCollecting,
  shouldAutoReload,
  STUCK_NOTE,
  updateBanner,
} from '../../packages/extension/src/background/autoReload.js';

const OLD = 'v0.4.5 · 815a450';
const NEW = 'v0.4.6 · 9f3c210';

/** 常态：磁盘上有新产物，没在采集，侧栏也没开。 */
const READY = { builtBuildId: NEW, runningBuildId: OLD };

describe('判断磁盘上是不是有新产物', () => {
  it('两边构建标记不一样才算有新版', () => {
    expect(hasNewBuild(READY)).toBe(true);
    expect(hasNewBuild({ builtBuildId: OLD, runningBuildId: OLD })).toBe(false);
  });

  it('任一边读不到就什么都不做——不知道就说不知道，绝不猜', () => {
    // 本机服务没在跑 / 还没打包过 / 扩展是直接跑源码的，都会缺一边。
    expect(hasNewBuild({ runningBuildId: OLD })).toBe(false);
    expect(hasNewBuild({ builtBuildId: NEW })).toBe(false);
    expect(shouldAutoReload({ runningBuildId: OLD })).toBe(false);
  });
});

describe('什么时候可以自己重新加载', () => {
  it('有新产物、手头没事，就自己重载——用户不必再去 edge://extensions', () => {
    expect(shouldAutoReload(READY)).toBe(true);
  });

  it('采集途中绝不重载', () => {
    // service worker 一重启，跑到一半的批次就断在那儿，而页面上的已处理标记还在，
    // 重来一遍会整批跳过——用户看到的是「采了个寂寞」。
    expect(shouldAutoReload({ ...READY, busy: true })).toBe(false);
  });

  it('定向运行活跃时绝不重载，即使普通采集状态为空闲', () => {
    expect(shouldAutoReload({ ...READY, directedRunActive: true })).toBe(false);
  });

  it('侧栏固定常开也会重载，任务明细从持久化状态恢复', () => {
    expect(shouldAutoReload({ ...READY, panelOpen: true })).toBe(true);
    expect(updateBanner({ ...READY, panelOpen: true }).available).toBe(true);
  });

  it('同一个构建只自动重载一次，重载没生效就不再试', () => {
    /*
     * 用户要是从别的目录加载的扩展，重载完版本还是没变，
     * 没有这条记录就会每分钟重载一次，无限循环。
     */
    expect(shouldAutoReload({ ...READY, triedBuildId: NEW })).toBe(false);
    // 但更新的构建仍然该试。
    expect(shouldAutoReload({ ...READY, triedBuildId: OLD })).toBe(true);
  });
});

describe('横幅上说什么', () => {
  it('平时就说有新版可以点', () => {
    const banner = updateBanner(READY);
    expect(banner.available).toBe(true);
    expect(banner.note).toContain(NEW);
  });

  it('自动重载没生效时改口，指向真正的原因', () => {
    // 不说清楚，用户只会一直点那个没用的按钮。
    expect(updateBanner({ ...READY, triedBuildId: NEW }).note).toBe(STUCK_NOTE);
    expect(STUCK_NOTE).toContain('artifacts/data-collector-extension');
  });

  it('构建失败也要说：那时点多少次「立即加载」都还是旧版', () => {
    const banner = updateBanner({
      builtBuildId: OLD,
      runningBuildId: OLD,
      buildFailed: true,
      updateMessage: '代码已更新到 9f3c210，但构建失败：tsc 报错',
    });
    expect(banner.available).toBe(true);
    expect(banner.note).toContain('构建失败');
    expect(banner.note).toContain('tsc 报错');
  });

  it('没事的时候不打扰', () => {
    expect(updateBanner({ builtBuildId: OLD, runningBuildId: OLD }).available).toBe(false);
  });
});

describe('「正在采集」怎么判', () => {
  const now = 1_000_000;

  it('批量在跑就是在跑', () => {
    expect(isCollecting({ batch: { phase: 'running', updatedAt: now - 1_000 }, now })).toBe(true);
  });

  it('固定计划仍在发现和创建子任务时也算在跑', () => {
    expect(isCollecting({ activePlanCollections: 1, now })).toBe(true);
    expect(isCollecting({ activePlanCollections: 0, now })).toBe(false);
  });

  it('单页任务跑到一半也算', () => {
    expect(isCollecting({ lastJobStatus: 'collecting', lastJobUpdatedAt: now - 1_000, now })).toBe(true);
    expect(isCollecting({ lastJobStatus: 'saved', now })).toBe(false);
  });

  it('单页任务停更太久或旧版本没有时间戳时，不再永久阻塞自动更新', () => {
    expect(isCollecting({
      lastJobStatus: 'collecting',
      lastJobUpdatedAt: now - 120_000,
      now,
    })).toBe(false);
    expect(isCollecting({ lastJobStatus: 'collecting', now })).toBe(false);
  });

  it('停更太久的批次不算——service worker 早被回收了，再等也等不到', () => {
    expect(isCollecting({ batch: { phase: 'running', updatedAt: now - 120_000 }, now })).toBe(false);
  });

  it('批量已经结束就不算', () => {
    expect(isCollecting({ batch: { phase: 'done', updatedAt: now }, now })).toBe(false);
  });
});
