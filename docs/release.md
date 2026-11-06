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

`git revert <commit>` 后 push。版本号和缓存名也一并回退，旧 SW 才会重新接管。