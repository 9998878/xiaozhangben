# iOS App 自签侧载指南（Windows · 无 Mac · 免费 Apple ID）

> 目标：把小账本 PWA 变成真正装进 iPhone 的 App。**不上 App Store、不买 99 美元开发者账号、只用免费 Apple ID 签名，接受 7 天过期后覆盖续签。**
>
> 路线一句话：**GitHub Actions 的免费 macOS 云机构建未签名 IPA → 拿回 Windows 用 Sideloadly 免费签名 → USB 装进 iPhone。** 你的 Windows 全程不运行 Xcode；所有必须 macOS 的步骤都发生在云端，本地只做签名和安装。

## 0. 可行性与硬边界（先读这段）

**这条路线可行**，不是假方案：

- 本仓库是 public，GitHub Actions 的 macOS runner **不消耗付费分钟数**；
- Capacitor 7 生成标准 Xcode 工程（SPM 管理依赖，无 CocoaPods），`xcodebuild CODE_SIGNING_ALLOWED=NO` 在云端产出未签名 `.app`，打成 `Payload/` 结构的 IPA；
- Sideloadly 在 Windows 上用你的免费 Apple ID 向苹果注册设备、生成 7 天有效的免费开发证书，对 IPA 重签名后 USB 安装——这正是免费账号的官方允许用途（自测设备）。

免费 Apple ID 的硬边界（无法绕过，接受才能用这条路线）：

1. **证书 7 天过期**：到期后 App 点开闪退/提示「无法验证 App」，需要覆盖续签（§5）。数据不会因此丢失。
2. 每台设备最多同时装 **3 个**自签 App。
3. 每 7 天最多注册 **10 个 App ID**——所以**永远不要改 Bundle ID**（§8 坑 2）。
4. 没有推送、CloudKit 等付费能力——本 App 一个都不用，零影响。

数据安全模型（详见 §8）：主存储仍是 App 沙盒内的 IndexedDB；原生桥接额外把**每次落库后的标准 JSON 备份镜像到沙盒 Documents**（「文件」App 可见可取）；**覆盖安装/续签不清数据，卸载 App 才清**。

## 1. 云构建：拿到未签名 IPA

workflow 文件：`.github/workflows/ios-build.yml`。触发方式二选一：

- push 到 `main`（改动涉及入口/js/native/壳配置等路径时自动触发）；
- 网页手动：GitHub 仓库 → **Actions** → 左侧 **ios-unsigned-ipa** → 右侧 **Run workflow** → 选 `main` → 运行。

云端依次执行（全部在 macOS runner 上，你不需要 Mac）：

1. `npm ci` 安装壳依赖 → `node scripts/test.js` 全量测试闸门；
2. `node scripts/build-www.js`：复制 Web 运行时文件到 `www/`，在 `</body>` 前注入原生桥接 `native/bridge.js`（Web 源码零改动，sw.js 不进包——原生壳里所有资源本就在包内）；
3. `npx cap add ios --packagemanager SPM` + `npx cap sync ios`：生成并同步 Xcode 工程（SPM 管理依赖，无 CocoaPods；CLI 7.6 的 add 收尾步有个大小写 bug 会误跑 pod install，workflow 已容错，sync 会正确完成插件接线）；
4. 应用图标（优先 `icons/icon-1024.png`，没有就用 macOS 自带 `sips` 把 512 图标放大到 1024）；PlistBuddy 写 Info.plist（Documents 对「文件」App 可见、相册/相机用途说明）；
5. `xcodebuild -configuration Release -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""` 构建未签名 `.app`；
6. `mkdir Payload && cp -R App.app Payload/ && zip -r xiaozhangben-unsigned.ipa Payload`；
7. `upload-artifact` 上传产物。

**下载产物**：仓库 → Actions → 点最新一次绿色运行 → 页面底部 **Artifacts** 区 → **xiaozhangben-unsigned-ipa**（zip）→ 解压得到 `xiaozhangben-unsigned.ipa`。产物保留 30 天，过期或要新版本就重跑一次 workflow。

构建失败怎么办：点进失败步骤看日志。偶发的 runner 镜像/SPM 解析问题直接 **Re-run jobs** 通常就好；持续失败把日志发出来排查，不要拿旧 IPA 凑合。

## 2. Windows 准备：官网 iTunes + Sideloadly

1. **必须装苹果官网 .exe 版 iTunes，Microsoft Store 版不行**：
   - 打开 <https://www.apple.com/itunes/>，找 Windows 版下载入口（页面若引导「Apple 设备」App，仍找 **iTunes Windows 安装程序**链接；历史直链 <https://www.apple.com/itunes/download/win64>）；
   - 原因：Sideloadly 依赖官网安装包附带的 **Apple Mobile Device Support** 驱动与设备通信；Store 版是沙箱应用，不提供这套驱动，识别不到 iPhone；
   - 装过 Store 版 iTunes 的：先卸载 Store 版，再装官网版。
2. 下载 **Sideloadly**：<https://sideloadly.io> → Windows 64-bit → 安装（免费）。
3. iPhone 用**数据线**连电脑（原装或 MFi 线；纯充电线不行）。解锁 iPhone，弹窗点「**信任此电脑**」，输锁屏密码。
4. 打开 Sideloadly，设备下拉框应出现你的 iPhone。识别不到时：换 USB 口 / 换线 / 重装官网 iTunes / 设备管理器确认「Apple Mobile Device USB Driver」存在。

## 3. 首次安装到 iPhone

1. 把 `xiaozhangben-unsigned.ipa` 拖进 Sideloadly 的 IPA 区域。
2. **Apple ID** 栏填你的苹果账号（免费账号即可；建议用主账号，以后续签不折腾）。首次会要密码和两步验证码。
3. **Bundle ID 保持 `io.github.u9998878.xiaozhangben` 不动**——改了会装成另一个 App，数据不互通，还浪费免费账号的 App ID 配额。
4. 点 **Start**，等进度走完（首次要注册设备 + 生成证书，稍慢）。
5. **开启开发者模式（iOS 16 及以上）**：iPhone 设置 → 隐私与安全性 → **开发者模式** → 打开 → 按提示重启 → 重启后弹窗点「打开」。
   - 看不到「开发者模式」选项：先用 Sideloadly 装一次（会失败并提示需要开发者模式），选项就会出现。
6. 安装完成后桌面出现「小账本」图标，但首次打开前还要**信任证书**：设置 → 通用 → **VPN 与设备管理** → 「开发者 App」下你的 Apple ID → **信任**。
7. 打开小账本：直接进首页。**开飞行模式再冷启动一次**——所有资源都在包里，断网照常记账，这是真 App 相对 PWA 的底气。

## 4. 数据迁移：PWA → App（一步都不能省）

> App 完整复用 Web 版既有的「导出/导入 JSON」，备份格式一字不差，不需要任何转换。

1. **先在 PWA 里导出**：iPhone 打开 PWA → 我的 → 导出备份 → **导出 JSON**（默认含照片；若提示体积过大，选「不含图片导出」先把账目迁过去，照片留在 PWA 里后续再补）。
2. 把导出的 JSON 存进「文件」App（iCloud Drive 或「我的 iPhone」），**并务必再发一份到电脑**（微信文件传输助手 / 邮件 / 网盘都行）——手机外副本是最后防线。
3. 按 §3 装好并打开 App（此时是空账本，正常）。
4. App → 我的 → **导入备份** → 在「文件」里选中那份 JSON → 模式选「**替换**」→ 确认。导入自带校验、pre-import 快照和回滚，失败不会弄脏空库。
5. **核对**：流水笔数、本月汇总、分类、账户、照片，与 PWA 一致才算迁移成功。
6. **核对通过之前，不要删 PWA 的主屏幕图标**——删图标即清 PWA 数据（WebKit 隔离机制），它是你的回退底牌。
7. 验证自动镜像：「文件」App → 我的 iPhone → **小账本** → 应看到 `小账本-自动备份.json`；回 App 记一笔，等几秒，该文件的修改时间应更新。
8. （强烈推荐）App 内开启**云备份**：我的 → 云备份，填你自己的 GitHub 密钥，每记一笔约 3 秒自动备份到你的私有 Gist。配合 7 天续签节奏，手机外自动副本最安心。

另一条兜底路：就算不手动导入，App 冷启动时若发现本机是空账本而 Documents 里有自动备份，会**主动询问是否一键还原**（走同一套 import 校验/回滚）。

## 5. 7 天续签（覆盖安装，数据不动）

**症状**：某天 App 打不开，提示「无法验证 App」/「需要互联网连接」——是证书到期，**不是数据丢了**。

**步骤**（约 2 分钟）：

1. iPhone 连电脑，打开 Sideloadly；
2. 拖入**同一个 Bundle ID** 的 IPA（上次那个旧包就行；云构建了新包也可以用新包，顺便升级）；
3. 同一个 Apple ID → **Start** → 覆盖安装完成；
4. 打开 App，数据原样都在。建议手机设个**每 6 天**的重复提醒，别等过期。

**为什么不能卸载重装**：iOS 卸载 App 会删除整个沙盒容器——IndexedDB 账本、Documents 镜像、localStorage 配置**一起灰飞烟灭**；而覆盖安装（同 Bundle ID）保留容器，数据完好。所以过期时**永远不要删 App**，直接覆盖。

**如果真的误卸载了**：数据只能从手机外副本找回——发到电脑的 JSON /「文件」里的 iCloud Drive 副本 / Gist 云备份。重装 App 后 我的 → 导入备份。这就是 §4 第 2 步「务必发一份到电脑」的意义。

**想更省心**：可改用 AltStore（电脑常驻 AltServer + 同 WiFi 自动续签），同样必须官网 iTunes + 官网 iCloud；Sideloadly 路线手动但最简单可靠，本文以它为准。

## 6. 以后更新 App 版本

1. Web 代码改动 push `main` → Actions 自动重构建（或手动 Run workflow）；
2. 下载新 IPA → Sideloadly **覆盖安装**（同 Bundle ID、同 Apple ID）；
3. 数据不用重新迁移：IndexedDB 和 Documents 都在容器里，覆盖安装原样保留；App 版本号随 Web 版本走（构建时自动写入）。

## 7. 验收清单

- [ ] Actions 运行全绿，Artifacts 里有 `xiaozhangben-unsigned-ipa`，解压得到 .ipa
- [ ] Sideloadly 安装成功，开发者模式已开、证书已信任
- [ ] **飞行模式**冷启动 App，能进首页并记一笔
- [ ] 记一笔 → 强杀 App → 重开，这笔还在
- [ ] 「文件」App → 我的 iPhone → 小账本 → `小账本-自动备份.json` 存在，记账后修改时间更新
- [ ] PWA 导出 JSON → App 导入（替换）→ 笔数/金额/分类/照片与 PWA 一致
- [ ] App 内 我的 → 导出备份 → 导出 JSON → 弹出系统分享面板 → 能「存储到文件」
- [ ] 删除/清空类操作后，Documents 里出现 `小账本-自动备份-上一份.json`（收缩保护）
- [ ] 7 天后（或换包模拟）Sideloadly 覆盖续签 → App 能开、数据完好
- [ ] （可选）开启 Gist 云备份后记一笔，私有 Gist 里出现新备份

## 8. 最容易丢数据的坑（逐条背下来）

1. **卸载 App = 全清**。过期、打不开、想重装——一律「覆盖安装」，永远不删图标。
2. **改 Bundle ID = 另一个 App**。Sideloadly 的自定义 Bundle ID 会装出第二个空壳，旧数据不跟过去，还浪费 10 个/7 天的 App ID 配额。
3. **换 Apple ID 续签**：证书团队变化可能导致安装异常，始终用同一个 Apple ID。
4. **删 PWA 主屏幕图标**：PWA 数据立即被清（WebKit 隔离）。App 迁移核对通过前，PWA 留着。
5. **App 内「清空本机数据」**：清 IndexedDB + 快照 + localStorage。桥接会在镜像收缩时把旧镜像轮转为「上一份」，给你一次反悔机会，但别依赖它。
6. **忘记应用锁 PIN**：只能手输「清空」清掉全部数据（Web 版既有行为，App 继承）。PIN 记在别处。
7. **iOS「卸载未使用的 App」自动 offload**：被 offload 的自签 App 无法从 App Store 重新下载，图标变废。建议 设置 → App Store → 关闭「卸载未使用的 App」。
8. **只靠自动镜像**：镜像仍在手机沙盒里，丢手机/抹掉/卸载一起没。手机外副本（电脑 JSON / iCloud Drive / Gist）才是真备份。
9. **记完立刻强杀**：镜像有 5 秒防抖，最后一笔可能没来得及镜像（IndexedDB 已落库，重开 App 会自动补镜像）；做危险操作前先手动导出。
10. **照片体积超限**：照片总量触发导出守卫时，自动镜像降级为纯账目（不含照片）；定期手动「导出 JSON（含照片）」存手机外。
11. **PWA 与 App 是两份独立数据**：迁移后互不同步。选定一个为主力，另一个只当回退，别两边交替记账。

## 9. 技术细节（接手开发用）

- 壳：Capacitor 7（SPM，无 CocoaPods），`capacitor.config.json`：appId `io.github.u9998878.xiaozhangben`（Capacitor 要求每段字母开头，故 GitHub 用户名段加 u 前缀）、webDir `www`、`CapacitorHttp.enabled=true`（AI 解读/Gist 云备份的 fetch 走原生层，绕开 `capacitor://` 源的 CORS 限制）。
- `www/` 由 `scripts/build-www.js` 生成：复制 Web 运行时 + 在唯一 `</body>` 前注入 `js/native-bridge.js?v=版本`；**Web 源码零改动**，sw.js 不进 www（源码 `registerServiceWorker` 的协议守卫只认 http/https，`capacitor://` 下自动跳过）。
- 桥接 `native/bridge.js`（挂 `XZB.NativeBridge`，非 Capacitor 环境一律 no-op）：
  1. 接管 `Core.backup.download` → 写 `Documents/导出/<原文件名>` + 系统分享面板（WKWebView 不支持 `a[download]` 的 Blob 通道；序列化仍走 `backup.exportText`，JSON/CSV 与 Web 同格式）；
  2. `Core.store.subscribe` → 5s 防抖 + 单飞，把 `backup.exportJson()` 产物镜像到 `Documents/小账本-自动备份.json`；照片守卫失败自动降级纯账目；退后台/pagehide 尽力 flush；`savedAt` 去重不重复写；
  3. 冷启动本机 0 笔 + 镜像有账 → confirm 询问还原（`backup.import(text,{mode:'replace'})`，自带快照/校验/回滚/照片回填）；拒绝按镜像 `exportedAt` 记忆（localStorage `xzb.native.v1`，仅原生容器存在）；
  4. 镜像笔数收缩（删除/清空）→ 先轮转旧镜像为 `小账本-自动备份-上一份.json`。
- Info.plist（workflow 内 PlistBuddy 注入）：`UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace`（Documents 对「文件」App 可见）、相册/相机用途说明、`ITSAppUsesNonExemptEncryption=false`。
- 回归：`tests/native-bridge.test.js`（假插件 vm 沙箱驱动真实实现）、`tests/build-www.test.js`（产物契约 + 源码零改动 + 输出目录守卫）。
- 已知边界见 `docs/known-issues.md` 的「iOS 自签侧载边界」；发版步骤见 `docs/release.md` 的「iOS 壳发布」。