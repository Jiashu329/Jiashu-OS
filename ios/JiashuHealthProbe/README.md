# Jiashu OS · iPhone 原生健康客户端

使用 SwiftUI，连接现有阿里云服务 **https://www.treefund.asia**。工程名和 Bundle Identifier 沿用 JiashuHealthProbe，便于升级此前安装的测试 App；显示名为 Jiashu OS。

## 当前功能

- App 内邮箱密码登录、设备会话续期与退出，不再依赖 Safari 交接健康数据。
- 原生首页：最新健康指标、记录日期、缺失与陈旧状态、同步结果、快速记录和周复盘入口。
- Apple Health 只读授权：步数、活动能量、睡眠、体重、去脂体重。
- 开启自动同步后，前台刷新最近30天，HealthKit变化通知触发时刷新最近7天；也可在“我的”补同步7／30／90天。
- 7／30／90／180／360天健康趋势、睡眠分期明细、健康目标及同步历史。
- 五项健康指标的人工补录、基础饮食记录、当前／上周回顾、本周行动及反馈。

本阶段专注健康日常使用。家庭财务、书影音及复杂食品维护继续从网页版使用。

## 安装与服务版本

**先部署包含本分支原生认证接口的后端，再安装客户端登录。** 只有旧网站时，新 App 登录会返回接口未提供；不要通过关闭网页的认证、Origin或CSRF校验解决。

1. Mac 安装支持手机系统版本的 Xcode，下载当前分支完整工程。
2. 打开 `JiashuHealthProbe.xcodeproj`。
3. Xcode → Settings → Apple Accounts，登录自己的 Apple 账号。
4. TARGETS → JiashuHealthProbe → Signing & Capabilities，选择自己的 Team，保留自动签名。若要覆盖旧测试App，保持原来使用的Bundle Identifier；新安装可使用自己的唯一标识。
5. 连接并信任iPhone，在手机开启开发者模式，选择真实iPhone，点击Run。
6. 在App使用网站现有账号登录，点击“授权并开启自动同步”，在系统面板选择可读取的类型。
7. 对比苹果健康与App的同一北京时间日期，特别核对昨天的步数、能量、睡眠及一次体重，再检查服务器同步回执。

工程目标为 iOS17及以上。免费开发签名通常7天到期，届时需用Xcode重新签名；长期家庭分发可使用付费开发者账号和TestFlight。HealthKit后台通知需要相应签名能力，实际支持以Xcode生成的profile和真机为准。

## 自动同步与授权

苹果健康权限面板必须由本人操作，App不代替用户批准。权限请求结束也不表示所有类型均被授权；HealthKit不会可靠区分“没有记录”和“未允许读取”，这些情况均不补成零。

自动同步开关按网站用户分别保存。健康内容和密码不写入UserDefaults；可撤销会话和已提交待确认的人工操作保存在本机Keychain，使用AfterFirstUnlockThisDeviceOnly。

HealthKit Observer通知后等待有上限的同步结束才确认处理；并发通知合并后补跑。后台同步预算25秒，前台120秒，并响应系统后台执行到期取消。iOS决定实际唤醒时机，App被强制结束、权限撤销或设备锁定时无法承诺后台上传。前台打开会补查近期记录，页面显示实际服务器确认结果并可手动重试。

步数和活动能量由HealthKit系统统计合并，不相加手机与手表的原始样本。日期沿用网站Asia/Shanghai口径。睡眠按前一天中午至所选日中午的窗口，选择一个稳定来源并对区间去重；清醒和卧床不计入睡眠。体重类保留单次测量与稳定UUID。首次替换网站旧来源时显示预览，只有明确确认才提交来源变化；人工更正／屏蔽继续保留。

现有导入为upsert，苹果健康删除的历史样本不会自动删除服务端记录。一次最多1000条／512KB，超限会明确失败，应缩小补同步范围，不会截断后显示成功。更多历史可分段迁入，当前自动同步不声称镜像用户终身完整健康库。

## 原生接口与数据归属

- `POST /api/native/auth/login`：`{email,password}`。
- `POST /api/native/auth/refresh`、`POST /api/native/auth/logout`：Bearer会话。
- 健康API从`/api/native/`进入服务端精确白名单，复用已有业务规则、用户隔离、目标历史、导入预览和操作回执。
- 会话使用独立签名域，每次检查账户启用状态、凭据版本和撤销状态。退出不影响同账号其他浏览器的独立会话。
- 原生请求不接受浏览器Origin或Cookie；客户端禁用Cookie、缓存及重定向。供应商AI密钥继续留在服务器。

## 验证

GitHub的iOS HealthKit checks在macOS执行工程结构检查、模拟器编译和XCTest，包括日期／睡眠区间、五指标导出、API交互、真实Keychain与账号切换竞态。模拟器CI使用独立的临时ad-hoc身份启用Keychain，既不使用个人Apple账号，也不改变真机签名配置。测试后保留匿名登录截图。

Self-hosted checks启动实际构建的服务器，覆盖原生登录→middleware→首页→五指标预览／导入／查询→人工补录与饮食→退出及重启后撤销。普通单测、生产构建及原网页浏览器验收继续执行。

模拟器不会包含你的真实健康数据。授权弹窗、数据一致性、个人签名和iPhone后台唤醒仍需真机核对；CI通过不等同于这些项目通过。

本地结构检查：`python3 scripts/verify-project.py`。完整模拟器验证以仓库`.github/workflows/ios-healthkit.yml`为准。
