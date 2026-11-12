# 每日听力（个人版）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本仓库 `/listen/` 下做一个个人用的英语听力网页应用，每天自动汇总中高级公开播客的新单集并提供适合练听力的播放器。

**Architecture:** 静态前端（原生 ES 模块，无构建）加两个 Vercel 函数。函数抓取并解析 RSS / 文稿后只返回 JSON；音频由 `<audio>` 直连播客方。用户数据全部在 localStorage。

**Tech Stack:** Node 18+（Vercel 函数，CommonJS）、fast-xml-parser、浏览器原生 ES 模块、`node --test`、Playwright（已预装）。

**Spec:** `docs/superpowers/specs/2026-11-12-daily-listening-design.md`

## Global Constraints

- 不改动 `index.html`、`api/search.js`、`vercel.json`。
- `api/` 下用 CommonJS（与 `api/search.js` 一致）；`listen/js/` 下用 ES 模块，`listen/package.json` 为 `{"type":"module"}`。
- 唯一的运行时依赖是 `fast-xml-parser`；前端零依赖、零构建。
- 界面文案为简体中文；API 错误体统一 `{ "error": "中文说明" }`。
- 抓取：只允许 http/https、端口 80/443；拒绝回环、私有、链路本地、保留地址；重定向最多 5 次且每跳校验；超时 10 秒；RSS 上限 5 MB，文稿上限 1 MB。
- `/api/feed` 只返回最新 30 集；响应头 `Cache-Control: s-maxage=900, stale-while-revalidate=3600`。
- 前端节目缓存有效期 30 分钟；`progress` 只保留最近 500 条；`recent` 最多 30 条。
- 变速档位 0.5、0.75、1、1.25、1.5、2；后退 10 秒、前进 15 秒；每 5 秒保存进度；播到 95% 记为已听；A-B 间隔至少 1 秒；某天播放满 60 秒算打卡。
- 第三方 HTML 不得经 `innerHTML` 进入页面。

## Review Focus

规格没有明说、但真实节目源里一定会遇到的情况。每条的测试都已加到负责该代码的任务里。

1. 音频地址是 `http://`：站点是 HTTPS，浏览器会拦截混合内容。期望：`/api/feed` 把附件地址升级为 `https://`。（Task 1）
2. 单集没有 `guid`，或不同节目的 `guid` 相同：期望单集 id 仍然唯一且稳定。（Task 5）
3. `pubDate` 缺失或无法解析：期望该单集仍出现在节目详情里，不出现在「今日」，不导致排序或分组崩溃。（Task 1、Task 5）
4. localStorage 里是损坏的 JSON 或旧结构：期望应用以默认状态启动，而不是白屏。（Task 5）
5. 音频时长未知（`duration` 为 `NaN` 或 `Infinity`）：期望进度显示为 `--:--`，不误记为已听，A-B 与跳转不产生 `NaN`。（Task 6）

## File Structure

见规格第 3 节。补充的决定：

- 两个函数都导出 `handler`，并挂 `handler.create(fetchText)`，测试和本地服务器用它注入假的抓取函数。
- `scripts/dev-server.js --fixtures`：任何 `/api/feed` 请求都返回按当前时间生成的样例节目；音频走 `/__fixtures/tone.wav`（内存生成，支持 Range）；`https://bad.test/feed` 固定返回 502。
- 应用外观由 Task 7 实现时用 frontend-design 的指引确定，独立于 NovaSearch 的样式。

---

### Task 1: RSS 解析 `api/_lib/rss.js`

**Files:**
- Create: `package.json`、`listen/package.json`、`.gitignore`、`api/_lib/rss.js`
- Test: `tests/unit/rss.test.js`、`tests/fixtures/feeds/basic.xml`

**Interfaces:**
- Produces:
  - `parseFeed(xml: string, opts?: { limit?: number }) → Feed`，`limit` 默认 30。非 RSS 输入抛出 `Error`，`err.code === 'NOT_A_FEED'`。
  - `parseDuration(value: string | number | undefined) → number | null`
  - `Feed = { title, image: string|null, link: string|null, description: string, episodes: Episode[] }`
  - `Episode = { guid: string|null, title, pubDate: string|null (ISO), audioUrl, duration: number|null, descriptionHtml: string, link: string|null, transcriptUrl: string|null }`

- [ ] **Step 1: 建立脚手架**

根 `package.json`：`"private": true`，`"scripts": { "test": "node --test tests/unit/", "dev": "node scripts/dev-server.js", "e2e": "node tests/e2e/smoke.mjs" }`，依赖 `fast-xml-parser`。`listen/package.json` 为 `{"type":"module"}`。`.gitignore` 忽略 `node_modules/`。运行 `npm install`。

- [ ] **Step 2: 写失败的测试**

`basic.xml` 含 5 个条目：标准条目（CDATA 标题、`itunes:duration` 为 `00:13:32`、`content:encoded`、`podcast:transcript type="text/vtt"`）；纯秒数时长 `812`；`http://` 音频地址且无 `guid`；无 `enclosure` 的条目；`pubDate` 为 `not a date`。

```js
test('解析频道信息', () => { assert.equal(feed.title, 'Sample Show'); assert.equal(feed.image, 'https://img.test/cover.jpg'); });
test('丢弃没有音频的条目', () => assert.equal(feed.episodes.length, 4));
test('时长：HH:MM:SS 与纯秒数', () => { assert.equal(eps[0].duration, 812); assert.equal(eps[1].duration, 812); });
test('parseDuration', () => { assert.equal(parseDuration('13:32'), 812); assert.equal(parseDuration(''), null); assert.equal(parseDuration('abc'), null); });
test('http 音频地址升级为 https', () => assert.ok(eps[2].audioUrl.startsWith('https://')));
test('缺 guid 为 null', () => assert.equal(eps[2].guid, null));
test('无法解析的 pubDate 为 null', () => assert.equal(eps[3].pubDate, null));
test('pubDate 输出 ISO', () => assert.equal(eps[0].pubDate, '2026-11-12T10:00:00.000Z'));
test('取 podcast:transcript', () => assert.equal(eps[0].transcriptUrl, 'https://t.test/1.vtt'));
test('优先 content:encoded 作为简介', () => assert.match(eps[0].descriptionHtml, /<p>Full notes/));
test('简介截断到 5000 字符', ...);
test('limit', () => assert.equal(parseFeed(xml, { limit: 2 }).episodes.length, 2));
test('非 RSS 输入', () => assert.throws(() => parseFeed('<html></html>'), { code: 'NOT_A_FEED' }));
test('单条目（非数组）也能解析', ...);
```

- [ ] **Step 3: 运行，确认失败**：`npm test` → 找不到模块。

- [ ] **Step 4: 实现**

用 `XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', cdataPropName: false, processEntities: true })`。`item` 可能是对象或数组；`podcast:transcript` 多个时优先级 `text/vtt` > `application/srt`/`application/x-subrip` > `text/plain` > `text/html`，其余类型忽略。简介取值顺序 `content:encoded` → `description` → `itunes:summary`。条目按 `pubDate` 倒序，`null` 排最后。

- [ ] **Step 5: 运行通过并提交**：`npm test` 全绿；`git commit -m "Add RSS parser for listening app"`。

---

### Task 2: 安全抓取 `api/_lib/safe-fetch.js`

**Files:**
- Create: `api/_lib/safe-fetch.js`
- Test: `tests/unit/safe-fetch.test.js`

**Interfaces:**
- Produces:
  - `class FetchError extends Error { code: 'BAD_URL' | 'UPSTREAM' | 'TIMEOUT' | 'TOO_LARGE' }`
  - `isPrivateAddress(ip: string) → boolean`
  - `assertSafeUrl(input: string, opts?: { ports?: number[], isBlocked?: (ip) => boolean }) → URL`
  - `safeFetchText(url: string, opts: { maxBytes: number, timeoutMs?: number, lookup?, isBlocked?, ports? }) → Promise<{ text: string, contentType: string, finalUrl: string }>`
  - `statusFor(err) → 400 | 502 | 504`（`BAD_URL`→400，`TIMEOUT`→504，其余 502）

- [ ] **Step 1: 写失败的测试**

```js
// isPrivateAddress：以下为 true
['127.0.0.1','10.1.2.3','172.16.0.1','172.31.255.255','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','::']
// 以下为 false
['8.8.8.8','172.32.0.1','1.1.1.1','2606:4700::1111']
// assertSafeUrl 抛 BAD_URL
['', 'ftp://a.test/x', 'file:///etc/passwd', 'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'https://a.test:8080/', 'javascript:alert(1)', 'http://2130706433/']
```

集成测试起一个 `127.0.0.1` 随机端口的本地服务器，注入 `lookup`（把 `feed.test` 指到 127.0.0.1）、`ports: [port]`、`isBlocked: ip => ip === '10.0.0.1'`：

- 正常返回文本与 `contentType`。
- gzip 响应被解压。
- 302 跟随到最终地址；第 6 次重定向 → `UPSTREAM`。
- 重定向到 `http://10.0.0.1/` → `BAD_URL`。
- `lookup` 解析到被拦截的地址 → `BAD_URL`。
- 响应体超过 `maxBytes` → `TOO_LARGE`。
- 服务器不响应、`timeoutMs: 200` → `TIMEOUT`。
- 上游 404 → `UPSTREAM`。

- [ ] **Step 2: 运行，确认失败。**

- [ ] **Step 3: 实现**

用 `node:http` / `node:https` 而不是 `fetch`，把地址校验放进请求的 `lookup` 回调里，这样校验的地址就是实际连接的地址，不存在「先解析、后连接」之间被换地址的空档。字面量 IP 不会走 `lookup`，所以在 `assertSafeUrl` 里单独检查。请求头 `User-Agent: Mozilla/5.0 (compatible; listen-feed-reader)`、`Accept-Encoding: gzip, deflate, br`，按 `content-encoding` 用 `zlib` 解压；大小上限按解压后的字节数计。整次调用（含重定向）共用一个截止时间。

- [ ] **Step 4: 运行通过并提交**：`git commit -m "Add SSRF-guarded fetch helper"`。

---

### Task 3: 文稿解析 `api/_lib/transcript.js`

**Files:**
- Create: `api/_lib/transcript.js`
- Test: `tests/unit/transcript.test.js`

**Interfaces:**
- Produces: `parseTranscript(text: string, contentType: string, url: string) → string[]`（非空段落；最多 2000 段）

- [ ] **Step 1: 写失败的测试**

```js
test('VTT：去掉头、时间码、标签，连续字幕合并成段', () => {
  // 输入含 WEBVTT 头、NOTE 块、<v Alice>…</v> 标签、两段之间隔 3 秒以上
  assert.deepEqual(out, ['Hello and welcome. Today we talk about tides.', 'First, the moon.']);
});
test('SRT：去掉序号与时间码', ...);
test('HTML：去标签、解实体、script/style 内容丢弃', () => assert.deepEqual(out, ['Tom & Jerry', 'Second para']));
test('纯文本：按空行分段', ...);
test('类型未知时按扩展名与内容判断', () => parseTranscript('WEBVTT\n\n…', 'application/octet-stream', 'https://t.test/a.vtt'));
test('空输入返回空数组', ...);
```

- [ ] **Step 2: 运行，确认失败。**

- [ ] **Step 3: 实现**。格式判定顺序：内容以 `WEBVTT` 开头 → VTT；`contentType` 或扩展名为 srt → SRT；`contentType` 含 `html` 或内容以 `<` 开头 → HTML；否则纯文本。VTT/SRT 分段规则：相邻字幕起止间隔 ≥ 2 秒，或当前段已超过 400 字符且上一句以 `.?!` 结尾，则另起一段。

- [ ] **Step 4: 运行通过并提交**：`git commit -m "Add transcript parser"`。

---

### Task 4: 函数入口与本地服务器

**Files:**
- Create: `api/feed.js`、`api/transcript.js`、`scripts/dev-server.js`
- Test: `tests/unit/handlers.test.js`

**Interfaces:**
- Consumes: `parseFeed`、`safeFetchText`、`statusFor`、`FetchError`、`parseTranscript`。
- Produces:
  - `api/feed.js`：`module.exports = handler`；`handler.create(fetchText: (url, { maxBytes }) => Promise<{ text, contentType, finalUrl }>) → (req, res) => Promise<void>`。`api/transcript.js` 同形。
  - `scripts/dev-server.js`：`createDevServer({ root: string, fixtures?: boolean }) → http.Server`；命令行 `node scripts/dev-server.js [--port 3000] [--fixtures]`。给处理函数提供与 Vercel 相同的 `req.query`、`res.status(n).json(obj)`、`res.setHeader`。

- [ ] **Step 1: 写失败的测试**（用假的 `req` / `res` 对象直接调用处理函数）

```js
test('feed：成功', …);          // 200；body.episodes.length === 4；Cache-Control === 's-maxage=900, stale-while-revalidate=3600'
test('feed：缺 url', …);         // 400；body.error 为字符串
test('feed：BAD_URL → 400', …);
test('feed：TIMEOUT → 504', …);
test('feed：上游不是 RSS → 502', …);
test('feed：非 GET → 405', …);
test('feed：以 maxBytes 5 MB 调用抓取', …);
test('transcript：成功返回 paragraphs；以 maxBytes 1 MB 调用', …);
test('transcript：解析结果为空 → 502', …);
test('dev-server：fixtures 模式下 /api/feed 返回今天的单集', …);   // episodes[0].pubDate 在最近 2 小时内
test('dev-server：/__fixtures/tone.wav 支持 Range', …);            // 206 与 Content-Range
test('dev-server：拒绝越出 root 的路径', …);                       // /../package.json → 403 或 404
test('dev-server：bad.test → 502', …);
```

- [ ] **Step 2: 运行，确认失败。**

- [ ] **Step 3: 实现**。错误文案：缺参数「缺少 url 参数」；地址不合法「地址不合法或不被允许」；超时「节目源响应超时」；其余「无法获取节目源」/「无法获取文稿」。样例节目每个地址 3 集：1 小时前、26 小时前、5 天前；第 1 集带 `podcast:transcript`，简介里包含 `<script>` 和 `<img onerror>` 供 Task 7 验证安全渲染；标题带上地址的主机名以便区分。

- [ ] **Step 4: 运行通过并提交**：`git commit -m "Add feed and transcript endpoints with dev server"`。

---

### Task 5: 前端数据层

**Files:**
- Create: `listen/js/catalog.js`、`listen/js/store.js`、`listen/js/feeds.js`、`listen/js/stats.js`
- Test: `tests/unit/store.test.js`、`tests/unit/feeds.test.js`、`tests/unit/stats.test.js`、`tests/unit/catalog.test.js`

**Interfaces:**
- Produces:
  - `catalog.js`：`CATEGORIES: string[]`；`CATALOG: Show[]`，`Show = { id, title, source, category, blurb, length, feedUrl, default: boolean }`，内容按规格第 6 节的表。
  - `store.js`：`createStore(storage?) → Store`。
    `Store = { state, save(), on(fn) → off, shows() → Show[]（已订阅的内置节目 + 自定义）, setSubscribed(id, on), addCustom({ title, feedUrl }) → Show, removeCustom(id), setProgress(id, { pos, dur, done }), toggleFavorite(ep) → boolean, pushRecent(ep), addListened(dateKey, sec), setSetting(key, value), getFeedCache(feedUrl) → { at, data } | null, setFeedCache(feedUrl, data, now) }`。
    `state` 的结构见规格第 5 节。键名 `listen.v1` 与 `listen.cache.v1`。
  - `feeds.js`：
    `episodeId(feedUrl, ep) → string`；
    `dateKey(d: Date) → 'YYYY-MM-DD'`（本地时区）；
    `loadShow(show, { store, fetchImpl?, now?, force? }) → Promise<{ episodes: ClientEpisode[], stale: boolean }>`，失败且无缓存时抛错；
    `loadShows(shows, opts) → Promise<{ episodes: ClientEpisode[], failed: Show[] }>`，并发 4；
    `buildToday(episodes, { now: Date, days: number }) → { key, label, episodes }[]`；
    `ClientEpisode = Episode & { id, showId, showTitle, image }`。
  - `stats.js`：`summarize(stats: Record<string, number>, now: Date) → { todaySec, totalSec, streak, last7: { key, sec }[] }`。

- [ ] **Step 1: 写失败的测试**

```js
// store
test('首次启动订阅默认节目', …);                    // Object.keys(state.subs) 与 CATALOG 中 default 的 id 一致
test('损坏的 JSON 回到默认状态', …);                // storage 里放 '{oops'
test('旧结构或类型不对的字段被默认值替换', …);      // 放 '{"subs":[],"progress":"x"}'
test('storage 抛异常时不崩溃', …);                  // getItem / setItem 都抛错，各方法照常返回
test('progress 超过 500 条时按 at 淘汰最旧的', …);
test('recent 去重、最新在前、最多 30 条', …);
test('toggleFavorite 往返', …);
test('缓存写入超出容量时清掉最旧的缓存后重试', …);
test('addCustom 去掉首尾空白、把 feed:// 换成 https://、缺协议时补 https://；重复地址不重复添加', …);

// feeds
test('episodeId：同一输入稳定；不同节目相同 guid 不同；无 guid 时用 audioUrl', …);
test('dateKey 用本地日期', …);
test('buildToday：分组标签为 今天 / 昨天 / M月D日，组内倒序', …);
test('buildToday：超出 days 的与 pubDate 为 null 的不出现', …);
test('buildToday：未来时间的单集归到今天', …);
test('loadShow：30 分钟内用缓存不请求；过期后请求并更新；force 强制请求', …);
test('loadShow：请求失败但有缓存 → 返回缓存且 stale 为 true', …);
test('loadShows：一个失败不影响其他，失败的进 failed', …);
test('loadShows：同时进行的请求不超过 4 个', …);

// stats
test('连续天数：今天不足 60 秒时不打断到昨天为止的连续', …);   // 昨天、前天各 120，今天 10 → streak 2
test('连续天数：中断后归零', …);
test('last7 为 7 项、从旧到新、缺的天补 0', …);

// catalog
test('id 唯一、feedUrl 都是 https、类别都在 CATEGORIES 内、至少一个默认订阅', …);
```

- [ ] **Step 2: 运行，确认失败。**

- [ ] **Step 3: 实现**。`episodeId` 用 FNV-1a 32 位对 `feedUrl + '|' + (guid || audioUrl)` 取哈希，输出 base36。`loadShow` 请求 `/api/feed?url=` + `encodeURIComponent(feedUrl)`。

- [ ] **Step 4: 运行通过并提交**：`git commit -m "Add client data layer for listening app"`。

---

### Task 6: 播放控制器 `listen/js/player.js`

**Files:**
- Create: `listen/js/player.js`
- Test: `tests/unit/player.test.js`（用假的 audio 对象：`EventTarget` 加 `currentTime`、`duration`、`playbackRate`、`src`、`paused`、`play()`、`pause()`）

**Interfaces:**
- Consumes: `Store`（`setProgress`、`pushRecent`、`addListened`、`setSetting`、`state`）、`dateKey`。
- Produces:
  - `SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]`
  - `createPlayer({ audio, store, now?: () => number, mediaSession? }) → Player`
  - `Player = { state, on(fn) → off, load(queue: ClientEpisode[], index: number, opts?: { autoplay?: boolean }), play(), pause(), toggle(), seek(sec), skip(deltaSec), next() → boolean, prev() → boolean, setSpeed(rate), cycleSpeed() → number, toggleAB() → 'a' | 'ab' | 'off', flush() }`
  - `state = { episode, queue, index, playing, pos, dur: number | null, speed, ab: { a: number, b: number | null } | null, error: string | null }`
  - `formatTime(sec: number | null) → string`（`null`、`NaN`、`Infinity` → `'--:--'`；超过 1 小时为 `H:MM:SS`）

- [ ] **Step 1: 写失败的测试**

```js
test('load 设置 src、应用已保存的倍速、从保存的位置继续', …);
test('已听完的单集从头开始而不是从末尾继续', …);
test('skip：-10 不小于 0；+15 不超过时长', …);
test('cycleSpeed 按档位循环并写入设置', …);
test('toggleAB：a → ab → off；B 距 A 不足 1 秒时不设置 B，状态保持 a', …);
test('AB 生效时播放到 B 跳回 A', …);
test('切换单集时清除 AB', …);
test('播放中每 5 秒保存一次进度；暂停时立即保存', …);
test('到 95% 记为已听', …);
test('ended 且 autoNext 开启 → 播下一集；队列末尾则停止', …);
test('autoNext 关闭时 ended 后停止', …);
test('error 事件 → state.error 有值、停留在当前单集', …);
test('听力时长按墙上时间累计；seek 造成的跳变不计；单次 timeupdate 最多计 2 秒', …);
test('时长为 NaN / Infinity：dur 为 null、不记已听、skip 与 toggleAB 不产生 NaN', …);
test('formatTime', …);   // 65 → '1:05'；3725 → '1:02:05'；NaN → '--:--'
test('mediaSession 收到 metadata 与 6 个动作处理函数', …);
```

- [ ] **Step 2: 运行，确认失败。**

- [ ] **Step 3: 实现**。`load` 在 `loadedmetadata` 后再设置续播位置。累计时长用注入的 `now()` 计算相邻 `timeupdate` 的间隔。`flush()` 供页面隐藏时调用。

- [ ] **Step 4: 运行通过并提交**：`git commit -m "Add player controller"`。

---

### Task 7: 界面

**Files:**
- Create: `listen/index.html`、`listen/manifest.webmanifest`、`listen/icon.svg`、`listen/icon-180.png`、`listen/icon-512.png`、`listen/js/app.js`、`listen/js/html.js`、`listen/js/views/{today,shows,show,player,me}.js`
- Test: `tests/e2e/smoke.mjs`

**Interfaces:**
- Consumes: Task 5、Task 6 的全部导出；`/api/feed`、`/api/transcript`。
- Produces:
  - `html.js`：`renderSafeHtml(html: string, doc?: Document) → DocumentFragment`。
  - 每个视图：`mount(root: HTMLElement, ctx) → unmount()`，`ctx = { store, player, navigate(route), play(queue, index) }`。
  - 路由用 hash：`#/today`、`#/shows`、`#/show/<id>`、`#/me`。
  - 冒烟测试依赖的选择器：`[data-tab="today|shows|me"]`、`[data-episode]`、`[data-action="play|back|forward|speed|ab|fav|next|prev|expand|collapse|add-show|retry|days"]`、`#mini-player`、`#player-sheet`、`[data-pane="notes|transcript"]`、`#notice`。

- [ ] **Step 1: 写失败的冒烟测试**

`tests/e2e/smoke.mjs` 启动 `createDevServer({ root, fixtures: true })`，用 Playwright 以手机视口（390×844）打开 `/listen/`，依次断言：

1. 「今日」出现「今天」「昨天」两个分组，5 天前的单集不在其中。
2. 点第一集：迷你播放条出现标题，2 秒内 `audio.currentTime > 0`。
3. 展开播放页；点倍速按钮，文字变为 `1.25x`，`audio.playbackRate === 1.25`。
4. 点 A-B 两次（中间等 1.5 秒），按钮显示已生效。
5. 「简介」里没有 `script` 元素、没有带 `onerror` 的元素，`window.__xss` 为 `undefined`；链接带 `rel="noopener noreferrer"`。
6. 打开「文稿」，出现至少一段文字。
7. 前进后刷新页面：迷你播放条恢复同一集，位置与刷新前相差不超过 6 秒，且不自动播放。
8. 收藏该集，切到「我的」，收藏列表里有它；「最近在听」里有它。
9. 「节目」页：关掉一个默认节目，回到「今日」该节目的单集消失。
10. 添加节目 `https://custom.test/feed`：出现在自定义列表；添加 `https://bad.test/feed`：显示错误且不加入。
11. 切到 7 天，5 天前的单集出现。
12. 全程无 `pageerror`、无 `console.error`。

- [ ] **Step 2: 运行，确认失败**：`npm run e2e` → 页面 404。

- [ ] **Step 3: 实现界面**。先调用 frontend-design 技能确定视觉方向，再写页面。必须满足：手机单列布局、电脑端居中限宽；底部标签栏之上是常驻迷你播放条；触控目标不小于 44px；支持深浅色；键盘可操作（空格播放/暂停、左右方向键后退/前进）；`visibilitychange` 与 `pagehide` 时调用 `player.flush()`；刷新后恢复 `recent[0]` 到迷你播放条但不自动播放。图标 PNG 用 Playwright 对 `icon.svg` 截图生成。

- [ ] **Step 4: 运行通过**：`npm test` 与 `npm run e2e` 全绿。截取今日页、播放页、节目页、我的页在手机与桌面视口下的截图并逐张查看，修掉布局问题。

- [ ] **Step 5: 提交**：`git commit -m "Add listening app UI"`。

---

### Task 8: 节目地址验证与交付

**Files:**
- Create: `scripts/check-feeds.js`
- Modify: `listen/js/catalog.js`、`README.md`

**Interfaces:**
- Consumes: `CATALOG`、`safeFetchText`、`parseFeed`。
- Produces: `node scripts/check-feeds.js` 逐个抓取内置节目，打印每个节目的状态、单集数、最新一集日期；有失败时退出码为 1。

- [ ] **Step 1:** 写 `scripts/check-feeds.js` 并运行。当前沙箱拦截播客域名；若仍被拦截，记录「未验证」，不要凭猜测修改地址。
- [ ] **Step 2:** 若能访问：移除或替换不可用的节目，更新 `catalog.js`，重跑测试。
- [ ] **Step 3:** 在 `README.md` 追加「每日听力」一节：访问路径、本地运行（`npm install && npm run dev`）、测试命令、如何用 `check-feeds.js` 验证节目源。README 现为 UTF-16 编码，改为 UTF-8。
- [ ] **Step 4:** 全量验证：`npm test`、`npm run e2e`；确认 `git status` 干净后提交并推送。
