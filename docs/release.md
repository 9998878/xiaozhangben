# 发版

只改文档不必发版；任何用户可见的行为变化都走一遍本清单。

## 1. 三处版本号

- `index.html` 搜 `XZB.version =`，改最后一条赋值为 `x.y.z`
- `sw.js` 改 `CACHE_LABEL` 与 `CACHE_NAME`，版本必须进名字（如 `xzb2-vx.y.z`），否则旧缓存清不掉
- `tests/category-expansion.test.js` 用例 7.1/7.2 是**转义正则**（`2\.x\.y`），纯字符串替换会漏

## 2. 写 CHANGELOG

在 `CHANGELOG.md` 顶部加 `## [x.y.z] YYYY-MM-DD`，列 3–6 条用户能感知的变化；内部重构不写。

## 3. 本地自检

```bash
node scripts/test.js
node scripts/check.js
```

必须全绿、无 `✗`。`check.js` 会查版本三处、AGENTS 长度、文档指针、旧文档残留。

## 4. 提交与发布

```bash
git add -A
git commit -m "release: x.y.z 一句话说清改了什么"
git push origin main
```

Pages 约 1 分钟后更新。

## 5. 线上验证

- 打开 https://9998878.github.io/xiaozhangben/ ，强制刷新
- DevTools → Application → Service Workers，确认缓存名是新版本
- 或 `curl -s https://9998878.github.io/xiaozhangben/sw.js | findstr CACHE_NAME`

## 6. 真机抽查（iPhone Safari）

- 冷启动一次、飞行模式打开一次
- 记一笔 → 改 → 删
- 小助手说一句；设置里「测试连接」一次
- 设置 → 清空本机数据后，AI 配置区应为空
- 图标风格切换正常（2.27.0 起为线条版）

## 回滚

原则：**回滚 = 反向发版**。SW 对 JS 是 cacheFirst，只把代码退回去没用——线上用户会一直命中旧缓存，必须走一遍"版本变化"才能让新 SW 接管。

标准步骤（每个功能一个独立 commit，所以能精确退）：

```bash
# 1) 找到要退的 commit（发版时打了 tag：git tag v2.28.9）
git log --oneline -5          # 或 git tag -l

# 2) revert（可能多个 commit，按从新到旧依次 revert）
git revert <sha>              # 冲突时逐个解决；不要 reset --hard push 过的提交

# 3) 版本三处改成新的回滚版本号（建议直接 +0.0.1，如 2.28.9 → 2.28.10；
#    复用旧版本号会导致 CACHE_NAME 撞名，用户卡在旧缓存）
#    - index.html 的 XZB.version
#    - sw.js 的 CACHE_LABEL / CACHE_NAME（+ 头部注释里的版本串）
#    - tests/category-expansion.test.js 用例 7.1/7.2 转义正则

# 4) CHANGELOG 顶部加一条「回滚」词条说明原因

# 5) node scripts/test.js && node scripts/check.js 全绿后 push
git push origin main
curl -s "https://9998878.github.io/xiaozhangben/sw.js?t=$(date +%s)" | grep CACHE_NAME
```

数据安全：schema 新字段一律带默认值向后兼容（老代码读新数据仅丢未知字段不报错）；回滚丢字段前提醒用户先导出 JSON 备份；本机自动快照（IndexedDB `STORE_SNAPSHOTS`）是最后兜底。

约定（2026-11-08 起）：push 前两道闸门——test+check 全绿、用户看过截图；不满足不 push，没 push 就不存在线上回滚。