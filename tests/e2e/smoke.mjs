// 冒烟测试：用样例数据把主要流程在真实浏览器里走一遍。
//   npm run e2e
// 需要本机有 Playwright 与 Chromium（不在 package.json 的依赖里）。
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { createDevServer } = require('../../scripts/dev-server.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOUR = 3600 * 1000;

// 与应用相同的分组标签规则，用真实时间算出期望值，避免午夜前后不稳定。
function labelFor(time, now = new Date()) {
  const key = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const date = new Date(time);
  if (key(date) === key(now)) return '今天';
  if (key(date) === key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

const toSeconds = (text) => text.split(':').reduce((total, part) => total * 60 + Number(part), 0);

const server = createDevServer({ root: ROOT, fixtures: true });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

const problems = [];
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
page.on('console', (msg) => {
  // 测试里故意制造的 502 会被浏览器记成 console error
  if (msg.type() === 'error' && !/status of 502/.test(msg.text())) problems.push(`console: ${msg.text()}`);
});

let current = '';
async function step(name, fn) {
  current = name;
  await fn();
  console.log(`  ok  ${name}`);
}

const audioState = () =>
  page.evaluate(() => {
    const a = document.querySelector('audio');
    return { t: a.currentTime, paused: a.paused, rate: a.playbackRate, src: a.currentSrc || a.src };
  });

try {
  const now = Date.now();
  const recent = labelFor(now - 1 * HOUR);
  const older = labelFor(now - 26 * HOUR);
  const oldest = labelFor(now - 120 * HOUR);
  const failingShow = 'theintelligencepodcast';

  await step('一个节目加载失败时提示并可重试', async () => {
    await page.route(`**/api/feed?url=*${failingShow}*`, (route) =>
      route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"无法获取节目源"}' })
    );
    await page.goto(`${base}/listen/`);
    await page.waitForSelector('[data-episode]');
    await page.waitForSelector('#notice:not([hidden])');
    assert.match(await page.textContent('#notice'), /1 个节目加载失败/);
    assert.equal(await page.locator('[data-episode][data-show="economist-intelligence"]').count(), 0);
    await page.unroute(`**/api/feed?url=*${failingShow}*`);
    await page.click('#notice [data-action="retry"]');
    await page.waitForSelector('[data-episode][data-show="economist-intelligence"]');
    await page.waitForSelector('#notice', { state: 'hidden' });
  });

  await step('今日按日期分组，超出 3 天的不显示', async () => {
    const labels = await page.locator('[data-group] h2').allTextContents();
    assert.ok(labels.some((l) => l.includes(recent)), `labels: ${labels}`);
    assert.ok(labels.some((l) => l.includes(older)), `labels: ${labels}`);
    assert.ok(!labels.some((l) => l.includes(oldest)), `labels: ${labels}`);
    assert.equal(await page.locator('[data-episode]').count(), 14);
    assert.equal(await page.locator('#mini-player').isVisible(), false);
  });

  let playingTitle = '';
  await step('点击单集开始播放', async () => {
    const first = page.locator('[data-episode]').first();
    playingTitle = (await first.locator('.ep-title').textContent()).trim();
    await first.locator('[data-action="play-episode"]').click();
    await page.waitForSelector('#mini-player:not([hidden])');
    assert.equal((await page.textContent('#mini-player .mini-title')).trim(), playingTitle);
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.3, null, { timeout: 5000 });
    assert.equal((await audioState()).paused, false);
  });

  await step('空格键暂停与继续', async () => {
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('audio').paused);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('audio').paused);
  });

  await step('展开播放页并变速', async () => {
    await page.click('#mini-player [data-action="expand"]');
    await page.waitForSelector('#player-sheet:not([hidden])');
    assert.equal((await page.textContent('#player-sheet .sheet-title')).trim(), playingTitle);
    const speed = page.locator('#player-sheet [data-action="speed"]');
    assert.match(await speed.textContent(), /1x/);
    await speed.click();
    assert.match(await speed.textContent(), /1\.25x/);
    assert.equal((await audioState()).rate, 1.25);
  });

  await step('A-B 复读', async () => {
    const ab = page.locator('#player-sheet [data-action="ab"]');
    assert.equal(await ab.getAttribute('data-state'), 'off');
    await ab.click();
    assert.equal(await ab.getAttribute('data-state'), 'a');
    await page.waitForTimeout(1500);
    await ab.click();
    assert.equal(await ab.getAttribute('data-state'), 'ab');
    const a = (await audioState()).t;
    await page.waitForTimeout(2500); // 区间约 1.9 秒，足够循环一次
    const t = (await audioState()).t;
    assert.ok(t < a + 2.5, `still inside loop: ${t} vs ${a}`);
    await ab.click();
    assert.equal(await ab.getAttribute('data-state'), 'off');
  });

  await step('简介经过安全渲染', async () => {
    const notes = page.locator('#player-sheet [data-pane="notes"]');
    await notes.waitFor();
    assert.match(await notes.textContent(), /Notes for/);
    assert.equal(await notes.locator('script').count(), 0);
    assert.equal(await notes.locator('img').count(), 0);
    assert.equal(await notes.locator('[onerror]').count(), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    const good = notes.locator('a[href="https://example.com/more"]');
    assert.equal(await good.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await good.getAttribute('target'), '_blank');
    assert.equal(await notes.locator('a[href^="javascript"]').count(), 0);
    assert.match(await notes.textContent(), /bad link/);
  });

  await step('文稿按需加载并显示', async () => {
    await page.click('#player-sheet [data-pane-tab="transcript"]');
    const para = page.locator('#player-sheet [data-pane="transcript"] p:not(.pane-status)').first();
    await para.waitFor();
    assert.match(await para.textContent(), /Welcome to the sample episode/);
  });

  let beforeReload = 0;
  await step('前进后刷新：恢复同一集与位置，且不自动播放', async () => {
    await page.click('#player-sheet [data-action="forward"]');
    await page.click('#player-sheet [data-action="forward"]');
    await page.waitForTimeout(600);
    beforeReload = (await audioState()).t;
    assert.ok(beforeReload > 30, `position ${beforeReload}`);
    await page.reload();
    await page.waitForSelector('#mini-player:not([hidden])');
    assert.equal((await page.textContent('#mini-player .mini-title')).trim(), playingTitle);
    await page.waitForTimeout(500);
    assert.equal((await audioState()).paused, true);
    await page.click('#mini-player [data-action="expand"]');
    const shown = toSeconds((await page.textContent('#player-sheet #time-pos')).trim());
    assert.ok(Math.abs(shown - beforeReload) <= 6, `shown ${shown} vs ${beforeReload}`);
    assert.match(await page.textContent('#player-sheet [data-action="speed"]'), /1\.25x/);
  });

  await step('恢复后点播放从断点继续', async () => {
    await page.click('#player-sheet [data-action="play"]');
    await page.waitForFunction(() => !document.querySelector('audio').paused);
    await page.waitForFunction((min) => document.querySelector('audio').currentTime > min, beforeReload - 6);
    assert.ok((await audioState()).t < beforeReload + 10);
    await page.click('#player-sheet [data-action="play"]');
    await page.waitForFunction(() => document.querySelector('audio').paused);
  });

  await step('收藏后出现在「我的」，最近在听也有记录', async () => {
    const fav = page.locator('#player-sheet [data-action="fav"]');
    await fav.click();
    assert.equal(await fav.getAttribute('aria-pressed'), 'true');
    await page.click('#player-sheet [data-action="collapse"]');
    await page.waitForSelector('#player-sheet', { state: 'hidden' });
    await page.click('[data-tab="me"]');
    const favorites = page.locator('[data-section="favorites"] [data-episode]');
    await favorites.first().waitFor();
    assert.equal(await favorites.count(), 1);
    assert.match(await favorites.first().textContent(), new RegExp(playingTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok((await page.locator('[data-section="recent"] [data-episode]').count()) >= 1);
    assert.match(await page.textContent('[data-section="stats"]'), /连续/);
  });

  await step('取消订阅后该节目从今日消失', async () => {
    await page.click('[data-tab="shows"]');
    const toggle = page.locator('[data-show-id="npr-up-first"] [data-action="subscribe"]');
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), true);
    await toggle.uncheck();
    await page.click('[data-tab="today"]');
    await page.waitForSelector('[data-episode]');
    assert.equal(await page.locator('[data-episode][data-show="npr-up-first"]').count(), 0);
    assert.equal(await page.locator('[data-episode]').count(), 12);
  });

  await step('节目详情页列出该节目的全部单集', async () => {
    await page.click('[data-tab="shows"]');
    await page.click('[data-show-id="bbc-global-news"] [data-action="open-show"]');
    await page.waitForSelector('[data-view="show"] [data-episode]');
    assert.equal(await page.locator('[data-view="show"] [data-episode]').count(), 3);
    assert.match(await page.textContent('[data-view="show"] h1'), /Global News Podcast/);
  });

  await step('添加自定义节目；无效的节目源报错且不加入', async () => {
    await page.click('[data-tab="shows"]');
    await page.fill('#add-url', 'custom.test/feed');
    await page.click('[data-action="add-show"]');
    const custom = page.locator('[data-custom-list] [data-show-id]');
    await custom.first().waitFor();
    assert.equal(await custom.count(), 1);
    assert.match(await custom.first().textContent(), /Fixture: custom\.test\/feed/);
    assert.equal(await page.inputValue('#add-url'), '');

    await page.fill('#add-url', 'https://bad.test/feed');
    await page.click('[data-action="add-show"]');
    await page.waitForSelector('#add-error:not([hidden])');
    assert.match(await page.textContent('#add-error'), /无法获取节目源/);
    assert.equal(await custom.count(), 1);

    await page.click('[data-tab="today"]');
    await page.waitForSelector('[data-episode]');
    assert.equal(await page.locator('[data-episode]').count(), 14);
  });

  await step('切到 7 天后更早的单集出现，刷新后保持', async () => {
    await page.click('[data-action="days"][data-days="7"]');
    await page.waitForFunction((label) =>
      [...document.querySelectorAll('[data-group] h2')].some((h) => h.textContent.includes(label)), oldest);
    assert.equal(await page.locator('[data-episode]').count(), 21);
    await page.reload();
    await page.waitForSelector('[data-episode]');
    assert.equal(await page.locator('[data-episode]').count(), 21);
  });

  await step('已听进度显示在列表里', async () => {
    const row = page.locator('[data-episode]', { hasText: playingTitle }).first();
    assert.ok((await row.locator('.ep-progress:not([hidden])').count()) >= 1);
  });

  await step('桌面宽度下页面没有横向滚动', async () => {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      assert.ok(overflow <= 0, `${width}px overflow ${overflow}`);
    }
  });

  await step('点过进度条之后，方向键和空格仍然有效', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-episode]').nth(1).locator('[data-action="play-episode"]').click();
    await page.waitForFunction(() => !document.querySelector('audio').paused);
    await page.click('#mini-player [data-action="expand"]');
    const box = await page.locator('#player-sheet .dial').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 55);
    await page.waitForTimeout(1200);
    const before = (await audioState()).t;
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    const after = (await audioState()).t;
    assert.ok(after > before + 10, `ArrowRight: ${before} → ${after}`);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);
    assert.ok((await audioState()).t < after, 'ArrowLeft goes back');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('audio').paused);
    await page.click('#player-sheet [data-action="collapse"]');
  });

  await step('另一个标签页的改动不会被本页覆盖', async () => {
    const count = () => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('listen.v1')).favorites).length);
    const start = await count();
    const other = await context.newPage();
    await other.goto(`${base}/listen/`);
    await other.locator('[data-episode] [data-action="fav"][aria-pressed="false"]').first().click();
    assert.equal(await count(), start + 1);
    await other.close();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    assert.equal(await count(), start + 1);
    await page.click('[data-tab="me"]');
    await page.waitForSelector('[data-section="favorites"] [data-episode]');
    assert.equal(await page.locator('[data-section="favorites"] [data-episode]').count(), start + 1);
    await page.click('[data-tab="today"]');
  });

  await step('地址不带结尾斜杠也能打开', async () => {
    const other = await context.newPage();
    const errors = [];
    other.on('pageerror', (err) => errors.push(err.message));
    await other.goto(`${base}/listen`);
    await other.waitForSelector('[data-episode]');
    assert.ok(new URL(other.url()).pathname.endsWith('/listen/'), other.url());
    assert.deepEqual(errors, []);
    await other.close();
  });

  await step('音频加载失败时迷你播放条给出提示，重试后能播放', async () => {
    const other = await context.newPage();
    await other.route('**/__fixtures/tone.wav*', (route) => route.fulfill({ status: 404, body: 'gone' }));
    await other.goto(`${base}/listen/`);
    await other.locator('[data-episode]').nth(3).locator('[data-action="play-episode"]').click();
    await other.waitForSelector('#mini-player[data-error]');
    assert.match(await other.textContent('#mini-player'), /加载失败/);
    await other.unroute('**/__fixtures/tone.wav*');
    await other.click('#mini-player [data-action="play"]');
    await other.waitForFunction(() => document.querySelector('audio').currentTime > 0.3, null, { timeout: 5000 });
    assert.equal(await other.locator('#mini-player[data-error]').count(), 0);
    await other.close();
  });

  await step('页面一直开着，隔天回来时今日会更新', async () => {
    const later = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const other = await later.newPage();
    await other.clock.install({ time: new Date() });
    let requests = 0;
    other.on('request', (request) => {
      if (request.url().includes('/api/feed')) requests += 1;
    });
    await other.goto(`${base}/listen/`);
    await other.waitForSelector('[data-episode]');
    const dateBefore = await other.textContent('.masthead-date');
    const requestsBefore = requests;
    await other.clock.fastForward('26:00:00');
    await other.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await other.waitForFunction((text) => document.querySelector('.masthead-date').textContent !== text, dateBefore);
    await other.waitForTimeout(500);
    assert.ok(requests > requestsBefore, `feed requests ${requestsBefore} → ${requests}`);
    await later.close();
  });

  await step('全程没有页面错误', async () => {
    assert.deepEqual(problems, []);
  });

  console.log('\n冒烟测试通过');
} catch (err) {
  console.error(`\n失败于：${current}\n`);
  console.error(err);
  if (problems.length) console.error('\n页面问题：\n' + problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
