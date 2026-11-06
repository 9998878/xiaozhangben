# HANDOFF — 给任何接手者的说明

> 一分钟读完就能开工。当前 **2.27.0**，`main` 分支即线上。
> 历史与「谁改了什么」看 [agent.md](agent.md)；更细的进度快照在本机 `D:\小账本\进度.md`（仅在当前机器有效）。

## 1. 这是什么

纯本地记账 PWA（iPhone「添加到主屏幕」使用）：没有账号、没有服务器、没有构建步骤，数据存在浏览器 IndexedDB 里，断网可用。线上由 GitHub Pages 托管，`main` 一 push 就发布。

- 线上：https://9998878.github.io/xiaozhangben/
- 仓库：https://github.com/9998878/xiaozhangben

## 2. 开工三件事

```bash
git pull --ff-only origin main
node tests/ai-config.test.js            # 31 项
node tests/category-expansion.test.js   # 52 项
```

83 项必须全绿再动手。然后读 [agent.md](agent.md)「改动记录」最上面 10 行，知道最近谁改了什么。

## 3. 目录地图

| 路径 | 内容 |
| --- | --- |
| `index.html` | 唯一入口；内嵌核心层、chunk 加载器（搜 `js/chunk-manifest.js`）与全部启动逻辑，约 3.1 万行 |
| `js/screens/` | 10 个页面：home / add / ledger / stats / insights / accounts / books / plan / settings / assistant |
| `js/modules/` | 6 个共用模块：core-assistant / ai-insights / nl / charts / keypad / icon-picker |
| `sw.js` | Service Worker：预缓存 16 个 chunk，导航网络优先 3 秒、静态资源缓存优先；换缓存名才会清旧缓存 |
| `tests/` | 两套契约测试（版本串、分类、AI 配置、schema 迁移） |
| `icons/` `splash/` | PWA 图标与启动图 |
| `DELIVERY-2.26.9-category-expansion.md` | 分类扩充那一版的交付说明与已知边界 |

## 4. 发版流程（版本三处必须同步）

1. `index.html` 搜 `XZB.version` 改版本号（当前 `'2.27.0'`）
2. `sw.js` 的 `CACHE_LABEL` 与 `CACHE_NAME` 一起改（缓存键换代，旧缓存才会清）
3. `tests/category-expansion.test.js` 用例 7.1 / 7.2 —— 注意是**转义过的正则**（`2\.27\.0`），字符串替换会漏

漏改任何一处，测试直接红。然后：

```bash
git commit -am "release: X.Y.Z 一句话说明"
git push origin main        # 约 100 秒后线上生效
```

**每轮改完往 [agent.md](agent.md) 顶部加一行**（只追加不改历史）：时间 / 谁 / 一句话。

## 5. 硬规矩

- 只改本仓库；其他副本都已归档，不要从归档里往回拷。
- 不引入依赖、不引入构建步骤；一个静态目录就是全部。
- 不在代码里硬编码任何 API key；AI 配置只存在 `localStorage['xzb.ai.v1']`，由用户在设置页输入。
- 发给 LLM 的只能是月度聚合数据，**不得发逐笔明细、备注、照片**。
- 数据 schema 改动必须带向前兼容迁移；旧备份 JSON 要能照常导入。
- `归档\zxb-rewrite-zcode-2026-11-06` 是另起炉灶的重写版（74 测试全绿），仅存档，**不要合并**。

## 6. 当前状态（2026-11-06 22:45）

- 线上版本 **2.27.0**（图标线条风格 v2：53 个分类图标改纯线条 + 22 个细分类图标键）
- 测试 83/83 全绿；工作区干净；`main` = `origin/main`
- 待办：真机抽查 2.27.0 图标（设置页候选 / 分类管理 / 外墙面）；以下遗留边界不阻塞使用：
  - LLM 分类词表上限 60，现 52 类只剩 8 个空位
  - `ca_aifee` 别名已打满 8 条上限
  - `home.js:435` 情境入口开关只有读取、没有 UI
  - `iconOk` 白名单守卫未启用

## 7. 卡住时看哪里

1. [agent.md](agent.md) —— 每一轮改动的来龙去脉
2. `DELIVERY-2.26.9-category-expansion.md` —— 最近一次大改的完整交付与边界
3. 本机 `D:\小账本\文档\` —— AI 月度解读的任务书与两轮设计笔记（只读）
4. 本机 `D:\小账本\进度.md` —— 当前进度快照与待办
5. 归档 `D:\小账本\归档\` —— 历史副本，只读，别改