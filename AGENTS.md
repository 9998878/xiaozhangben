# AGENTS.md · 小账本（agent 30 秒开工规矩）

> **L0 入口**：先读本文件，再读 [HANDOFF.md](HANDOFF.md)（完整接手说明）。
> 冲突时以本文件 + `HANDOFF.md` 为准；本机工作区另有 `D:\小账本\做前必读\00-做前必读.md`。

## 唯一真源

本仓库（`D:\小账本\xiaozhangben`）就是全部。**不要**新建副本 / 工作区 / draft / rewrite；归档 `D:\小账本\归档\` 只读，禁止拷回。

## 开工 5 步

1. 读 `HANDOFF.md` §1–§3、§6–§7
2. 读 `agent.md` 顶部 10 行
3. `git pull --ff-only origin main`；`git status` 干净再动手
4. `node tests/ai-config.test.js` + `node tests/nl-date.test.js` + `node tests/category-expansion.test.js`（105 全绿）
5. 开分支再改：`git switch -c fix/xxx`

## 绝对禁止

- 新建项目目录 / 副本 / 工作区；把项目文件放进 `.zcode`、`.workbuddy`、桌面、文档、下载
- 在仓库根新增过程稿（方案 / 报告 / 笔记 → `D:\小账本\文档\` 并登记）
- 跳测试、只改不记、push 未验证代码、回滚别人未提交工作
- 修改或拷回 `D:\小账本\归档\`

## 根目录（`D:\小账本`）

允许：`xiaozhangben\`、`文档\`、`归档\`、`做前必读\` + `说明.md`、`进度.md`。工具生成的隐藏目录（`.zcode` 等）不保留，跑完即清；工具里的记录不算留痕。

## 改完必做（同一次提交）

1. `agent.md` 顶部追加一行（时间 / 谁 / 一句话），只追加
2. 同步 `HANDOFF.md` 受影响的每一句
3. 刷新 `D:\小账本\进度.md`
4. 提交信息 `release:` / `fix:` / `docs:` + 一句话
5. 发版三处：`index.html` `XZB.version`；`sw.js` `CACHE_LABEL` + `CACHE_NAME`；`tests/category-expansion.test.js` 7.1/7.2 转义正则

## 交付自检

- 105 全绿；工作区 clean；`origin/main` 已更新；`agent.md` / `HANDOFF.md` / `进度.md` 已同步
- 回复列出：改动文件、测试数、commit 哈希