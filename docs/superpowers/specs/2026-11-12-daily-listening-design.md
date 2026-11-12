# 每日听力（个人版）设计文档

日期：2026-11-12
状态：待确认

## 1. 目标

做一个个人使用的英语听力网页应用：每天打开就有新的、难度在中高级的英语音频可听，
内容来自公开播客，自动更新，不需要自己准备材料。

成功标准：

- 打开 `/listen/`，不做任何操作就能看到最近几天的新单集，点一下开始播放。
- 内容不是入门材料：内置节目都是面向母语者或中高级学习者的正常语速节目。
- 关掉再打开，能从上次的位置继续听。
- 手机和电脑都能用，可添加到手机主屏幕，锁屏和耳机按键可控制播放。

## 2. 范围

### 第一版包含

- 今日：汇总已订阅节目近几天的新单集。
- 节目库：内置节目列表，可开关订阅；可粘贴 RSS 地址添加自定义节目。
- 播放器：变速、前后跳、A-B 复读、断点续播、自动播下一集、系统媒体控制。
- 文稿与简介：显示节目简介；节目源提供文稿链接时在播放页显示文稿（纯文本，不与音频同步）。
- 我的：收藏、最近在听、每日听力时长、连续打卡天数。

### 第一版不包含

- 逐句同步字幕、单句循环、听写。
- 查词、生词本。
- 离线下载、Service Worker。
- 账号、跨设备同步。

### 不改动

- NovaSearch（`index.html`、`api/search.js`）保持原样。

## 3. 总体结构

静态前端加两个 Vercel 函数，无构建步骤，与仓库现有部署方式一致。

```
listen/
  index.html              页面骨架与样式
  manifest.webmanifest    添加到主屏幕用
  icon.svg, icon-180.png, icon-512.png
  package.json            仅 {"type":"module"}，让 Node 测试能加载前端模块
  js/
    app.js                启动、标签页切换、视图挂载
    catalog.js            内置节目列表
    store.js              本地数据读写
    feeds.js              调用 /api/feed、前端缓存、生成「今日」列表
    player.js             播放控制器（不含界面）
    stats.js              听力时长与连续天数计算
    html.js               简介 HTML 的安全渲染
    views/today.js  views/shows.js  views/show.js  views/player.js  views/me.js
api/
  feed.js                 GET /api/feed?url=…        返回解析后的节目与单集 JSON
  transcript.js           GET /api/transcript?url=…  返回文稿纯文本
  _lib/
    safe-fetch.js         地址校验、超时、大小限制
    rss.js                RSS → JSON（纯函数）
    transcript.js         VTT / SRT / HTML / 纯文本 → 段落（纯函数）
scripts/
  dev-server.js           本地开发与测试用：静态文件 + /api 路由
tests/
  fixtures/               样例 RSS、文稿、短音频
  unit/                   node --test
  e2e/smoke.mjs           Playwright 冒烟测试
package.json              依赖 fast-xml-parser；脚本 test、dev
```

音频不经过我们的服务器：`<audio>` 直接从播客方的地址播放。

每个单元的职责：

| 单元 | 做什么 | 依赖 |
|---|---|---|
| `api/_lib/safe-fetch.js` | 校验地址、带超时和大小上限地抓取文本 | Node fetch、dns |
| `api/_lib/rss.js` | 把 RSS 文本解析成统一的节目与单集结构 | fast-xml-parser |
| `api/_lib/transcript.js` | 把各种格式的文稿转成段落数组 | 无 |
| `api/feed.js` / `api/transcript.js` | HTTP 入口：参数校验、调用上面的模块、设置缓存头、错误映射 | `_lib` |
| `store.js` | 本地数据的唯一读写入口，带版本号和容量修剪 | localStorage |
| `feeds.js` | 取节目数据（带缓存与并发控制），按日期汇总 | `store.js`、fetch |
| `player.js` | 封装一个 `<audio>`：播放队列、变速、跳转、A-B、进度保存、媒体会话；通过事件通知界面 | `store.js`、`stats.js` |
| `stats.js` | 由每日秒数计算近 7 天、总时长、连续天数 | 无 |
| `views/*` | 只负责渲染和把用户操作转给 `player.js` / `store.js` | 上述模块 |

## 4. 接口

### `GET /api/feed?url=<RSS 地址>`

成功（200）：

```json
{
  "title": "Up First",
  "image": "https://…/cover.jpg",
  "link": "https://…",
  "description": "…",
  "episodes": [
    {
      "guid": "…",
      "title": "…",
      "pubDate": "2026-11-12T10:00:00.000Z",
      "audioUrl": "https://…/episode.mp3",
      "duration": 812,
      "descriptionHtml": "<p>…</p>",
      "link": "https://…",
      "transcriptUrl": "https://…/transcript.vtt"
    }
  ]
}
```

- 只返回最新 30 集；没有音频附件的条目丢弃。
- `duration` 为秒，缺失时为 `null`；`transcriptUrl` 取自 `podcast:transcript` 标签，缺失时为 `null`。
- 响应头 `Cache-Control: s-maxage=900, stale-while-revalidate=3600`。

### `GET /api/transcript?url=<文稿地址>`

成功（200）：`{ "paragraphs": ["…", "…"] }`。VTT/SRT 去掉时间码后按说话段落合并；
HTML 去标签；纯文本按空行分段。

### 错误

| 情况 | 状态码 |
|---|---|
| 缺少 `url`、不是 http(s)、指向内网或本机地址 | 400 |
| 上游返回非 2xx、内容不是 RSS、解析失败 | 502 |
| 上游超时（10 秒） | 504 |

错误体统一为 `{ "error": "中文说明" }`。

### 抓取安全（`safe-fetch.js`）

这两个函数接受任意地址，必须防止被用作开放代理或访问内网：

- 只允许 `http:` / `https:`，端口只允许 80、443 或缺省。
- 解析 DNS 后拒绝回环、私有、链路本地、保留地址（IPv4 与 IPv6）。
- 手动跟随重定向，最多 5 次，每一跳都重新校验。
- 超时 10 秒；响应体上限：RSS 5 MB，文稿 1 MB，超出即中止。
- 只返回解析后的 JSON，从不原样转发上游内容。

## 5. 前端数据

全部存在 localStorage。

`listen.v1`（用户数据）：

```
{
  subs:      { [节目id]: true },                      // 已订阅的内置节目
  custom:    [ { id, title, feedUrl } ],              // 自定义节目
  progress:  { [单集id]: { pos, dur, done, at } },    // 断点与已听；只保留最近 500 条
  favorites: { [单集id]: 单集快照 },
  recent:    [ 单集快照 ],                            // 最近在听，最多 30 条
  stats:     { "2026-11-12": 1260 },                  // 每日实际播放秒数
  settings:  { speed: 1, autoNext: true, todayDays: 3 }
}
```

`listen.cache.v1`（节目数据缓存）：`{ [feedUrl]: { at, data } }`，30 分钟内不重新请求。

- 单集 id = 对 `feedUrl + "|" + (guid 或 audioUrl)` 做短哈希。
- 首次打开时默认订阅内置列表中标记为默认的节目。
- localStorage 读写失败（隐私模式、容量满）时应用照常运行，只是不保存。

## 6. 功能细节

### 今日

- 并发（最多 4 个）拉取所有已订阅节目，取发布时间在最近 N 天内的单集（默认 3 天，可切换到 7 天）。
- 按本地日期分组：今天、昨天、具体日期；组内按发布时间倒序。
- 每行显示节目名、标题、时长、已听或进度标记、收藏按钮。
- 先显示缓存，再后台刷新；有节目加载失败时在顶部提示「N 个节目加载失败」并可重试，不影响其他节目显示。
- 播放队列为当前列表，自动播下一集按列表顺序。

### 节目库

- 内置节目按类别分组，显示名称、来源、简述、单集常见时长；每个带订阅开关。
- 点进节目可看最新 30 集并直接播放。
- 「添加节目」：粘贴 RSS 地址，校验能解析出单集后加入自定义列表；可删除。

内置节目（地址在实现时逐个验证，不可用的移除或替换）：

| 类别 | 节目 |
|---|---|
| 新闻 | BBC Global News Podcast*、NPR Up First*、The Daily*、NPR News Now、Today in Focus、Today, Explained |
| 财经科技 | The Intelligence (The Economist)*、Planet Money*、The Indicator、FT News Briefing、WSJ What's News |
| 科学 | Short Wave*、Nature Podcast、BBC Science in Action |
| 故事文化 | Hidden Brain、99% Invisible、Radiolab、This American Life、Fresh Air、BBC In Our Time、BBC The Documentary |
| 演讲 | TED Talks Daily*、TED Radio Hour |
| 进阶学习 | BBC 6 Minute English |

带 * 的默认订阅。

### 播放器

- 底部常驻迷你播放条；点开为全屏播放页。
- 控制：播放/暂停、后退 10 秒、前进 15 秒、进度条拖动、上一集/下一集。
- 变速：0.5、0.75、1、1.25、1.5、2，记住上次选择。
- A-B 复读：第一次点设 A，第二次点设 B 并开始循环，第三次点清除；B 必须晚于 A 至少 1 秒。
- 断点续播：播放中每 5 秒及暂停、切换、页面隐藏时保存位置；播到 95% 或自然结束记为已听。
- 自动播下一集可开关。
- 系统媒体控制（Media Session）：标题、节目名、封面；播放、暂停、前后跳、上下一集。
- 播放页下方两个分区：「简介」（安全渲染后的节目说明）和「文稿」（仅当有 `transcriptUrl` 时出现，点开时才请求）。
- 音频加载失败时提示并保留在当前单集，不自动跳走。

### 我的

- 最近在听：未听完的单集，点击续播。
- 收藏列表。
- 听力记录：今日时长、近 7 天柱状图、累计时长、连续天数（某天播放满 60 秒算一天；今天未达标时不打断昨天为止的连续）。
- 时长按实际播放的墙上时间计，不乘倍速；拖动进度不计入。

### 简介的安全渲染（`html.js`）

节目简介是第三方 HTML。用 `DOMParser` 解析后只保留白名单标签
（`p br a ul ol li strong b em i`），链接只保留 http(s) 地址并加
`target="_blank" rel="noopener noreferrer"`，其余标签只取文本。不使用 `innerHTML` 直接插入。

## 7. 测试

- 单元测试（`node --test`）：
  - `rss.js`：标准 RSS、CDATA、缺时长、`HH:MM:SS` 与纯秒数时长、无音频条目、`podcast:transcript`、非 RSS 输入。
  - `safe-fetch.js`：协议、端口、各类内网地址、重定向到内网、超大响应、超时。
  - `transcript.js`：VTT、SRT、HTML、纯文本。
  - `feeds.js` 的按日期汇总、`stats.js` 的连续天数、`store.js` 的修剪与损坏数据恢复。
- 冒烟测试（Playwright + `scripts/dev-server.js` 使用样例数据）：
  今日列表出现 → 点击播放 → 变速 → 设置 A-B → 刷新后从断点继续 → 收藏出现在「我的」→ 添加自定义节目。
- 真实节目源：当前开发沙箱的网络策略拦截播客域名。实现时会申请放行这些域名来逐个验证内置节目地址；
  若未放行，则在部署到 Vercel 后验证，并在交付说明中明确列出未验证的部分。

## 8. 部署

- 新增根目录 `package.json`（依赖 `fast-xml-parser`），Vercel 会自动安装；不需要新的环境变量。
- 访问地址为现有站点的 `/listen/`。
- `vercel.json` 不需要改动。
