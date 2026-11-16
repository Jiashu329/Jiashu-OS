# 健康步数核对 · Jiashu Health Probe

这是只供自己安装测试的 iPhone App：读取苹果健康系统合并后的每日步数，按日期核对，再由你选择导出 JSON 或交给阿里云 Jiashu OS 预览导入。无需上架，也不需要 TestFlight。

同步服务是 **https://www.treefund.asia**，对应后端仓库是 [Jiashu329/Jiashu-OS](https://github.com/Jiashu329/Jiashu-OS)。本工程放在该仓库的 `ios/JiashuHealthProbe/` 目录，使用现有阿里云站点的登录和健康记录导入流程。代码是否已经合并、部署，以仓库和部署回执为准；App 不会直接向 GitHub 写入健康记录。

App 使用 HealthKit 的 `.cumulativeSum` 统计查询，交给系统合并来源；不把手机、手表和其他 App 的原始步数自行相加，也不固定只选一台设备。只申请读取“步数”，不会向苹果健康写入数据。

## 用 Mac 安装到自己的 iPhone

1. 使用支持你当前 iPhone 系统版本的 **Xcode 15 或更新版本**，下载并解压完整工程文件夹。不要只复制单个 Swift 文件。
2. 双击 `JiashuHealthProbe.xcodeproj`。
3. 在 **Xcode → Settings → Apple Accounts** 登录自己的 Apple Account。旧版 Xcode 的入口可能叫 **Accounts**。
4. 点击左侧蓝色工程图标，选择 **TARGETS → JiashuHealthProbe → Signing & Capabilities**。
5. 保留 **Automatically manage signing**，将 **Team** 选择为自己的 **Personal Team** 或已有开发团队。如果 Bundle Identifier 已被占用，把 `com.jiashu.healthprobe` 改成自己的唯一标识，例如 `com.yourname.healthprobe`。工程已经配置 HealthKit 能力和读取用途说明。
6. 用数据线连接 iPhone，解锁并按提示信任、配对；在 Xcode 顶部运行设备中选择这台真实 iPhone。
7. 按系统提示开启 iPhone 的 **设置 → 隐私与安全性 → 开发者模式**，重启并再次确认。这个开关可能在第一次与 Xcode 配对后才出现。
8. 确认 Scheme 是 **JiashuHealthProbe**，点击 Xcode 的 **▶ Run**。若 iPhone 提示开发者尚未受信任，按系统提示在设备管理中信任自己的开发签名。

Apple 当前允许免费 Personal Team 使用 HealthKit。免费开发签名通常 **7 天到期**，到期后连接 Mac，再点一次 Xcode Run 即可重新签名安装；不需要购买付费账号完成这次个人测试。

Apple 官方说明：[支持的 iOS 能力](https://developer.apple.com/help/account/reference/supported-capabilities-ios/) · [个人开发账户与 7 天签名](https://developer.apple.com/help/account/basics/about-your-developer-account) · [开发者模式](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)

## 第一次核对

1. 在 App 中选择截止日期和要读取的天数，点击读取按钮；第一次运行时，允许读取苹果健康中的 **步数**。
2. 日期按 **Asia/Shanghai（北京时间）**划分。与健康 App 对比时，确认查看同一天、同一时区；今天的数字以本次读取时刻为准。
3. 先在 iPhone 上让手表和健康 App 同步完成，再读取。首次可选择一个已经结束的日期和连续 **1 天**，与健康 App 的同日总步数核对；App 不会预填或假装读到某个值。
4. 同时核对另一个已经结束的日期。当天有后续步数、设备尚未同步、时区不同时，重新读取后再比较。

如果某一天显示“未取得数据”，它可能没有数据，也可能没有授予读取权限。HealthKit 不允许 App 可靠地区分这两种情况；本 App 不会把缺失结果补成 0。实际读到的 0 则会保留。

系统统计在时间边界可能返回小数。本 App 会四舍五入为整步，以符合现有网站的整数步数格式；显示和导出使用同一个值，仍需以真机核对结果为准。

## 导入阿里云网站

先点击 App 中的 **“打开阿里云网站并登录”**，在 iPhone Safari 使用阿里云站点自己的邮箱和密码登录，再回到 App。这个登录入口不携带健康数据，App 中已经读取的结果不会因打开网站而清除。

登录后支持两条由你主动触发的路径：

- **在阿里云网站预览导入**：把这次读取的数据交给已登录 Safari 中的 `https://www.treefund.asia/sync`。网站会打开待导入对话框；先点击预览，核对来源变化及数值，再确认导入。App 打开网站并不代表已经同步成功，应以网站回执为准。
- **导出 JSON**：使用系统文件导出保存 JSON，在 iPhone Safari 打开阿里云 Jiashu OS → 数据同步 → 导入 JSON，选择文件、预览并确认。范围较大、URL 太长或不方便打开网站时使用这条路径。

当前阿里云网站的首次登录跳转不会保证保留 App 交接的数据。如果登录后没有出现本次数据，请完成登录，回到 App 再点一次预览；无需清空已读结果。App 将健康数据放在 URL fragment 中，不会把它塞入登录页面的 `return_to` 查询参数。

首次从旧的 iPhone 单来源值切换到系统合并总量时，网站可能要求额外勾选“确认来源变化”。已有手工更正/屏蔽仍由网站保留，需要到健康记录管理中核对。登录身份决定写入哪个阿里云网站账号，请在预览确认时核对当前账号。

App 不索取网站密码、Cookie、设备密钥或 Apple Account 密码；不在后台自动上传。现有阿里云导入接口要求网站登录及同源请求，不能只凭设备密钥从原生 App 直接调用；当前 App 使用 Safari 的登录和人工预览，不新增后台上传认证入口。

## 开发与验证

工程不依赖第三方包或 XcodeGen，目标为 iPhone、iOS 17 或更新系统，使用 Swift 5 语言模式。共享 Scheme 已包含 App 和 `StepCoreTests` 单元测试。

在 Mac 上可以选择一个已安装的 iPhone 模拟器，再使用 **Product → Test** 测试日期窗口和导出逻辑。测试不需要访问真实健康记录。若选择真机运行单元测试，也需将 `JiashuHealthProbeTests` target 的 Team 设为同一账户。读取你自己的真实步数必须在 iPhone 上完成；模拟器不会包含你的手机和手表健康数据。

也可先在项目目录执行模拟器构建，检查 iOS SDK 编译：

```sh
xcodebuild -project JiashuHealthProbe.xcodeproj \
  -scheme JiashuHealthProbe \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build
```

跨平台的工程结构检查：

```sh
python3 scripts/verify-project.py
```

交付环境为 Linux，没有 Xcode/iOS SDK；结构检查和其他可执行检查不代表已在 Mac 编译或在 iPhone 读取成功。首次签名、SDK 编译、健康权限弹窗及实际数值仍需在你的 Mac 和 iPhone 上完成验证。

## 文件结构

- `JiashuHealthProbe.xcodeproj`：可直接打开的 Xcode 工程与共享 Scheme。
- `Sources/HealthKitStepReader.swift`：只读授权与系统合并统计查询。
- `Sources/StepModels.swift`：北京时间日期窗口和读取快照。
- `Sources/StepExport.swift`：网站 JSON 和 Safari 预览地址。
- `Sources/ProbeViewModel.swift`、`ContentView.swift`：读取、核对和导出界面。
- `Tests/StepCoreTests.swift`：日期边界、缺失值及导出协议测试。
- `Config/`：HealthKit entitlement 与隐私用途说明。

实现依据：[HealthKit 统计对象默认合并来源](https://developer.apple.com/documentation/healthkit/hkstatistics) · [Apple 工程师对去重步数的说明](https://developer.apple.com/forums/thread/759709)
