# iPhone 原生功能对照与验收

本清单以仓库中的网页、业务 API 与 SwiftUI 实现逐项对照，范围包括已有移动端功能和本次新增工作区。原生页面位于 `ios/JiashuHealthProbe/Sources`，复用原有业务规则与数据库，经自托管的 `/api/native/` Bearer 网关访问。表中的路由省略此前缀；例如 `health/records` 对应 `/api/native/health/records`，转发到既有 `/api/health/records`。

**验证记录：本清单记录源码与请求契约对照；macOS 编译、XCTest 与模拟器构建结果以对应提交的 iOS CI 为准。** 本清单不是“所有页面已在 iPhone 真机操作通过”的证明。表中列出的测试是仓库内可执行的验证入口，不能仅因存在测试文件就宣称测试已经通过。

## 账户、首页与健康

底部「应用」打开可搜索的目录，首项直达「我的菜谱」。右上角「我的」进入登录账号与退出页面。「同步中心」「账号与服务」等位于目录的「设置与数据」分组。

| 网页功能 | 原生入口与实现 | 主要请求 | 核对内容与边界 |
| --- | --- | --- | --- |
| 登录、恢复登录、退出与切换账号 | `ContentView`、`NativeAppModel`、`NativeSessionStore` | `auth/login`、`auth/refresh`、`auth/logout`、`session` | 邮箱密码登录；密码不持久保存；会话存入设备 Keychain。认证失效清空当前身份及已显示业务数据，旧账号的迟到响应不能覆盖新账号。 |
| 今天首页、健康概览、快捷记录 | `NativeTodayView`、`NativeHomeHealthCards`、`NativeHealthView` | `overview`、`health`、`health/weight-plan`、`health/nutrition`、`…/reuse`、`…/copy` | 首页「体重／体脂」卡显示最近的体重、估算体脂及体重计划。日常体重通过 Apple 健康自动同步，人工补录从「健康 → 记录管理」进入。「记一餐」可把常吃或前一天同餐带入可编辑草稿，确认保存后刷新。 |
| 从首页继续记录和周行动 | 今天 → `NativeHomeFollowThrough` | `overview`、`health/actions`、`finance/books` | 恢复饮食原日期、餐次和原保存请求。余额恢复核对原账本、币种和当前编辑权限。周复盘与执行周分别按北京时间计算。 |
| Apple 健康授权与日常同步设备 | 应用 → 同步中心（`NativeSyncCenter`、`NativeAppModel`、`HealthKitReader`） | `sync/channel`、`health/import/preview`、`health/import` | 用户先完成系统健康授权，再明确选择日常同步设备。后续选定设备上传无需逐批确认来源。设备被替换时暂停，人工更正保留。 |
| 健康指标趋势、自选日期、真实来源 | 健康工作区 → 自选日期、来源与睡眠分析；`NativeHealthRangeWorkspace` | `health?from=…&to=…` | 体重、去脂体重、步数、活动能量、睡眠；北京时间，包含首尾日期，最多360天；无记录日期不补零。 |
| 睡眠分期、真实入睡与起床、分周规律 | 同上，选择睡眠；`NativeWorkspaceSleepSummary` | 同一健康范围响应 | 分期按实际时长汇总；跨午夜使用圆周平均；截断窗口与只有总时长的旧记录不参与作息规律推断。 |
| 估算体脂及配对依据 | 同上，选择估算体脂率 | 健康响应 `bodyComposition` | 仅同来源、相同测量时刻的体重与去脂体重配对；展示未配对和无效配对数。不是健康 App 的直接体脂测量。 |
| 健康记录查询、补录、人工更正、隐藏和恢复 | 健康工作区 → 健康记录与修改历史；`NativeHealthRecordsWorkspace`、`HealthQuickEntryView` | `health/records`、`health/records/{key}`、`…/history` | 过滤与分页；读取详情再修改；保留原因、记录修改版本与底层导入版本；冲突后保留填写并重新核对。 |
| 每日目标、生效历史、达成日历 | 健康工作区 → 目标、生效历史与达成日历；`NativeHealthGoalsWorkspace` | `health/goals`、`health/goals/progress` | 清除目标发送显式空值；指定生效日期；保留历史目标；缺失记录不作为未达成。 |
| 体重计划、开始和归档周期、历史周期 | 健康工作区 → 体重计划与历史周期；`NativeWeightPlanWorkspace` | `health/weight-plan`、`…/cycles` | 当前计划修改与新周期分别操作；版本冲突不覆盖；历史分页；最新实测只主动填入草稿，不自动修改计划。 |
| 每周健康复盘、重点、下一周行动与反馈 | 首页与健康 → 每周复盘；`HealthWeeklyReviewView` | `health/review`、`health/actions` | 选择当前／前周／历史周、与上周比较、行动及完成反馈；未提交填写与待确认请求分别按账号加密恢复，跨周仍保留原周、原版本和原内容。 |
| 健康助手、分享范围与连续问答 | 健康工作区 → 健康助手；`NativeHealthAssistantWorkspace` | `health/assistant` GET/POST | 先看所选日期和指标摘要，确认后才发送给 MiniMax；最多4轮近期问答；改变范围清空对话；有来源及额度、限流提示，不自动重发。 |
| 健康范围 JSON 导出 | 自选日期页面 → 导出相同日期 | `health/export` | 使用已读取的范围；文件导出由系统文件界面完成；导出的业务格式可作为手动导入来源。 |
| 同步诊断、逐指标覆盖、回执与尝试记录 | 应用 → 同步中心 → 健康历史与诊断（`NativeHealthSyncWorkspace`） | `sync/status`、`health/import`、`sync/channel` | 新鲜度按各指标真实记录日期。空批次或其他指标更新不会刷新本指标的日期。 |
| 健康文件预览、来源替换确认、导入及整批回退 | 同上 | `health/import/preview`、`health/import`、`health/import/{id}/revert` | 文件上限512KiB／1000条；先服务器预览；手动来源变化须明确确认；选定日常设备通道期间暂停手动文件导入。回退需原因并展示批次影响。 |

健康相关验证入口：`NativeAPITests`、`NativeAppModelTests`、`NativeHealthWorkspaceTests`、`HealthSyncTests` 与现有健康动作测试。重点包括真实零值与空数据、时间边界、未知权限、人工更正、版本冲突、账号切换和自动同步失败不弹窗。

## 饮食与食物库

| 网页功能 | 原生入口与实现 | 主要请求 | 核对内容与边界 |
| --- | --- | --- | --- |
| 按日期与餐次记饮食、当天小计 | 饮食；`NativeNutritionRoot`、`NativeNutritionBatchEditor` | `health/nutrition`、`…/batch` | 一项或多项结构化填写；热量、碳水、蛋白质、脂肪分别保留未知值与真实零值；确认后才保存。 |
| 记录详情、编辑、删除和恢复删除 | 饮食 → 记录；`NativeNutritionEntryDetail` | `health/nutrition/{id}` | 修改附带当前版本；删除保留历史；可显示删除记录并恢复。 |
| 修改历史与恢复历史版本 | 记录 → 修改历史与恢复；`NativeNutritionHistoryView` | `…/{id}/history`、`…/{id}/restore` | 展示历史，再明确选择恢复；带当前版本，避免覆盖并发修改。 |
| 一句话识别与照片识别 | 饮食 → 一句话或照片识别；`NativeNutritionRecognitionView` | `health/nutrition/parse`、`…/photo` | 主动点击才调用AI；相册图片本机转为压缩且无元数据的JPEG；结果为可编辑草稿；逐项核对后另行保存。照片不写入草稿或业务备份。 |
| 营养来源、候选食物与重新核对 | 明细编辑；`NativeNutritionDraftFields` | 食物库查询，随后保存明细 | 展示并保留AI／标签／人工／食物库依据；修改食物身份会作废相关AI或目录估值；未知项目不补零。 |
| 食物搜索、分类、品牌与范围筛选、分页 | 饮食 → 食物库与份量换算；`NativeNutritionFoodsView` | `health/foods` | 显示来源、版本与数据限制；支持目录、维护食品、本人模板，实际权限由服务端返回。 |
| 每100克、每份换算及饮品配置 | 食物详情；`NativeFoodSelectionDraft` | 食物库读取；模板另用 `…/templates/{id}/preview` | 核对份量和日期餐次后带入草稿；规格不符的饮品不继续套用官方营养值；管理来源不虚构目录发布版本。 |
| 常吃、最近记录、收藏与取消收藏 | 饮食 → 常吃、最近与复制餐次；`NativeNutritionReuseView` | `health/nutrition/reuse`、`…/favorites` | 复用先生成可编辑明细；保留原目录版本、来源及未知值，不自动新增记录。 |
| 复制某天的一餐 | 常吃 → 复制某天的一餐；`NativeNutritionMealCopyView` | `health/nutrition/copy` | 核对源日期、餐次及目标位置，选择后带入草稿；不直接保存第二份记录。 |
| 自建食物、食谱与整餐模板 | 饮食 → 自建食物、食谱与整餐模板；`NativeNutritionTemplatesView`、`NativeNutritionTemplateEditor` | `health/nutrition/templates`、`…/{id}` | 新建、编辑、归档、复制为新模板；成分与来源为结构化表单；从已记录餐次整理模板。 |
| 我的菜谱、制作笔记与成品照 | 应用首项或饮食 → 我的菜谱（`NativeRecipesRoot`） | `health/nutrition/recipes`、`…/preview`、`…/{id}/cookings` | 小红书链接可在 App 内浏览器读取可见正文，将明确标注的食材和做法带入可编辑草稿。分享文案仍可带入摘录，支持仅收藏链接。下厨房支持可用的公开预览。成品照可加到独立自制菜谱或已收藏菜谱。记录按账号存储，照片单独鉴权读取。记餐仍由饮食表单确认。 |
| 模板按份数或成品重量换算 | 模板详情；`NativeNutritionTemplateDetail` | `health/nutrition/templates/{id}/preview` | 预览请求带模板版本、日期餐次和换算量；输入变化清除预览；已归档模板不可用于新记录。 |
| 每日营养目标、体重计划提示 | 饮食 → 每日营养目标与需求测算；`NativeNutritionGoalsView` | `health/nutrition/goals` | 读取并更新版本；空值仍为空；测算结果只填入目标草稿，保存是另一项明确操作。 |
| 营养需求公式与AI解读 | 营养目标 → AI测算；`NativeNutritionNeedsView` | `health/nutrition/needs` | 主动填写公式所需身体参数；点击才发送；公式参考、方法与来源可核对；参数不存为个人档案。 |
| 餐次完整度、未进食与当天记完 | 饮食 → 餐次状态与当天记完；`NativeNutritionStatusView` | `health/nutrition/status` | 区分未记录和明确未进食；按当前版本更新；“记完”由本人确认，不由小计推断。 |
| 7天／30天饮食回顾 | 饮食 → 饮食回顾；`NativeNutritionReviewView` | `health/nutrition/review` | 按已知项目计算小计与覆盖，展示未知数量及完整度，不能把不完整记录解读为摄入为零。 |
| 公共食物库维护、保存草稿、审核发布、下架与恢复 | 食物库 → 管理公共食物库；`NativeNutritionManagedFoodsView`、`NativeNutritionManagedFoodEditor` | `health/foods/manage` | 仅服务端授予维护权限者可操作；原目录可建立维护副本；草稿与发布分开；显示并保留版本和待确认操作。 |

饮食验证入口：`NativeNutritionTests` 及既有 nutrition／foods／templates API 与存储测试。照片处理、目录版本、未知营养、响应丢失后的原批次重试和CAS核对均有专门测试入口；仍需模拟器与真机操作确认。

## 财务与家庭协作

| 网页功能 | 原生入口与实现 | 主要请求 | 核对内容与边界 |
| --- | --- | --- | --- |
| 个人／家庭账本选择、多币种资产负债 | 财务；`NativeFinanceRoot`、`NativeFinanceDashboard` | `finance`、`finance/books` | 按币种分别查看；金额保留十进制字符串或整数字符串，不经过浮点金额换算；不把不同币种相加。 |
| 账户新建、资料编辑、归档和恢复 | 财务 → 账户；`NativeFinanceAccountForm`、`NativeFinanceAccountDetail` | `finance/accounts`、`…/{id}` | 账户类型、币种、备注及流动性；元数据按版本修改；归档保留历史。币种创建后固定。 |
| 新余额、余额历史与本月核对 | 账户 → 记录新余额；本月余额核对；`NativeFinanceBalanceForm`、`NativeFinanceBalanceCheck` | `finance`、`finance/accounts/{id}`、`…/{id}/balances` | 保留余额日期与记录来源；各币种精度校验，日元不得填小数；标出待核对账户。 |
| 历史余额更正、作废、恢复及影响预览 | 账户 → 历史余额；`NativeFinanceBalanceForm` | `…/balances/{entry}/preview`、`…/balances/{entry}` | 冻结预览内容；附记录与账户余额双版本、原因、预览凭证；原始记录和审计保留。 |
| 资金目标、进度、账户关联、归档与恢复 | 财务 → 资金目标；`NativeFinanceGoals`、`NativeFinanceGoalForm` | `finance/goals`、`…/{id}` | 同币种资产账户；显示账户共享关系与缺口；多个目标引用同一余额，不当作多份已预留资金相加。 |
| 可动用流动资金与应急月数 | 财务 → 流动资金与应急月数；`NativeFinanceRunway` | `finance/runway` | 按币种选择账户、必要开支及月数；保留不可用关联账户以供核对移除；修改使用版本。 |
| 月度回顾、当前草稿、月结及重结版本 | 财务 → 月度回顾与月结；`NativeFinanceReview`、`NativeFinanceClosedReport` | `finance/review`、`…/close` | 月结冻结预览哈希与最新版本；重新月结需原因，旧版保留；不是收益率计算。 |
| 站内邀请、接受／婉拒、成员角色、移除与撤销 | 财务 → 账本选择／管理我的家庭账本协作者；`NativeFinanceMembers` | `finance/books/{book}/invitations`、`…/members/{id}`、`finance/books/invitations/{id}/respond` | 邀请需站点准入与本人接受；owner／editor／viewer权限由服务端核对；更改附成员版本；不发送邮件。 |
| 家庭协作动态与分页 | 财务 → 家庭协作动态；`NativeFinanceActivity` | `finance/books/{book}/activity` | 只读取当前仍可访问账本的动态；授权发生变化时阻止继续沿用旧范围。 |
| 财务 JSON 导出 | 财务 → 导出当前账本 | `finance/export` | 导出请求沿用当前账本范围；只向owner显示入口，服务端仍执行导出权限校验。 |

财务验证入口：`NativeFinanceTests` 和既有 finance API／存储测试，包括精确金额、共享账本授权版本、双版本余额更正以及响应未知时保留原请求。后端目前没有账本创建／改名／删除接口；每人一本自己的家庭账本，首次邀请才物化存储，原生沿用此规则。

## 书影音

| 网页功能 | 原生入口与实现 | 主要请求 | 核对内容与边界 |
| --- | --- | --- | --- |
| 收藏库、分类数量、搜索、筛选与分页 | 书影音；`NativeLifeRoot`、`NativeLifeFilters` | `life/douban` | 电影、电视剧、书籍、音乐；含隐藏筛选与来源条件；详情按完整来源键区分，不能只按作品ID混合。 |
| 作品详情、豆瓣／IMDb评分、完整资料和本人记录 | 作品 → 作品资料／我的记录；`NativeLifeDetail` | 收藏列表／详情响应，封面另走 `…/cover` | 外部作品评分与本人评分分开；本人评分、标记日期和短评为导入／同步的原始记录，现有网页也不提供直接编辑它们的接口。更新需重新预览导入。 |
| 独立备注、标签、隐藏与恢复可见 | 作品 → 我的整理；`NativeLifeDetail` | `life/douban/library` PUT | 不改写豆瓣原始记录；附数据epoch与本地修改版本；保留本机未完成整理。 |
| 影视分类、批量分类 | 作品 → 资料管理；收藏多选 | `life/douban/classification`、`…/library` POST | 当前影视条目分类；批量最多24项；以最新记录快照核对。 |
| 单条／当前页资料补全、TMDB海报、IMDb评分刷新 | 作品 → 资料管理；更新当前页 | `life/douban/metadata`、`…/tmdb`、`…/imdb-ratings` | 主动点击才联网；当前页补全可暂停；验证、拒绝或限流时停止并保留资料。 |
| 备用封面预览、保存、恢复豆瓣原封面 | 作品 → 资料管理 → 备用封面 | `life/douban/cover-selection` | HTTPS图片先在手机预览，确认才保存选择；预览不带本站登录凭据；本站原封面读取使用受保护的记录键。 |
| 豆瓣主页绑定与断开 | 书影音 → 同步与导入 → 连接与数据 | `life/douban/connection` | 保存只变更绑定，不自动同步或删除旧记录；主页声明不代表已经验证豆瓣账号所有权。 |
| 公开同步、继续、暂停与逐来源状态 | 同步与导入 → 同步；`NativeLifeStore` | `life/douban/sync` | 每次最多推进20步，每步附连接／同步运行版本；手动继续；未读到条目不作为删除；公开完成不代表私密历史全量。 |
| JSON／CSV／Obsidian Markdown／已保存HTML导入 | 同步与导入 → 导入；`NativeLifeImportForm`、`NativeLifeImportParser` | `life/douban/import` preview/commit | 文件或系统粘贴；本机解析与规范化；先看服务器新增／更新／未变预览，再确认；缺少状态需主动核对，明确未完成条目仍跳过。单批1–500条，文件合计8MiB。 |
| 手动整理一部已完成作品再导入 | 导入 → 手动整理导入条目 | 同上 | 结构化填写名称、豆瓣链接、类型、本人评分日期短评；加入同一预览流程，不直接修改豆瓣。 |
| 导入预览恢复、结果不明的原操作核对 | 导入恢复提示／待确认的原操作 | 同上及原写入路由 | 账号隔离保存规范化条目、预览和原提交；恢复后再次确认；不存豆瓣密码、Cookie或原始网页内容。 |
| 清空全部书影音的范围预览和确认 | 连接与数据 → 清空全部书影音 | `life/douban/reset` preview/commit | 明确展示全部来源范围；重置附epoch、预览哈希与原请求标识；只影响本站当前账号，不改豆瓣原站。 |

书影音验证入口：`NativeLifeTests` 及既有 Douban API／存储测试，覆盖本人评分语义、已完成状态、坏日期／评分整批拒绝、凭据拒绝、重复冲突、CSV／Markdown／HTML解析、CAS与安全封面地址。

**真实外部限制：** iPhone 不能运行仓库的桌面 Chrome／Edge 豆瓣同步扩展。需要该扩展读取的本人浏览器资料，仍须在本人桌面浏览器完成，再把导出文件通过“文件”或粘贴导入 App。需要查看豆瓣原作品时，原生链接交给 Safari／系统浏览器；这不是嵌入式登录或原生读取私密豆瓣资料。公开数据接口、验证和访问限制也不会因改成原生而消失。

## 设置、管理、消息与备份

| 网页功能 | 原生入口与实现 | 主要请求 | 核对内容与边界 |
| --- | --- | --- | --- |
| 设置与当前身份 | 应用 → 账号与服务（`NativeSettingsWorkspaceRoot`） | `session` | 显示当前邮箱与站点权限。管理入口以服务端身份为准。 |
| AI配置、测试、删除 | 账号与服务 → AI 服务（`NativeProviderSettingsView`） | `ai/settings`、`…/test` | 站点级管理员配置。密钥只输入不回显，留空保留原值。修改附版本。测试需确认固定测试内容与调用费用。 |
| TMDB服务配置、测试和删除 | 账号与服务 → 影视资料服务（同上） | `media/tmdb/settings`、`…/test` | 站点管理员权限。已存密钥不会在界面回显。测试由管理员主动启动。 |
| 使用名单管理 | 账号与服务 → 站点访问名单（`NativeAccessManagementView`） | `access`、`access/{id}` | 添加邮箱、停用和恢复。状态变更附版本并确认。是否可用取决于部署的认证方式。邀请邮件由管理员自行处理。 |
| 自托管用户创建、邮箱／密码修改与停用 | 账号与服务 → 登录用户（`NativeUsersManagementView`） | `admin/users`、`…/{id}` | 管理员操作。管理员账号不能停用。修改登录资料会使旧会话失效，修改自身后需重新登录。初始密码由管理员自行传达。 |
| 消息筛选、已读、全部已读及类别设置 | 应用 → 消息与提醒，或首页铃铛（`NativeNotificationsView`） | `notifications`及其更新操作 | 站内消息通过原生导航打开对应页面。 |
| 同步连接、设备、快捷指令模板与核对 | 应用 → 同步中心 → 其他接入方式（`NativeSyncConnectionsView`） | `sync/config`、`sync/devices`、`sync/template`、`sync/status` | 原生 Apple 健康通道与旧快捷指令连接有各自授权状态。用户在系统或 Safari 中安装 iCloud 模板及配置 iOS 自动化。 |
| 单文件完整业务备份 | 应用 → 备份与恢复（`NativeBackupView`） | `data/backup` GET | 健康、饮食、财务和书影音业务数据通过系统分享保存。生成与本人确认保存是两步。密钥、登录凭据和同步连接不包含。 |
| 分卷备份、全部文件保存确认 | 同上 | `data/backup?format=volumes` | 保存清单及全部分卷，记录生成及本人确认保存回执；App生成临时文件不等于文件已经安全保存。 |
| 单文件／分卷恢复、冲突字段对照、原恢复继续确认 | 同上 | `data/backup` POST preview/restore | 保留原始备份字节，先服务器预览，显示新增／已存在／冲突；预览哈希再核对后事务恢复，不自动覆盖或合并冲突。单文件8MiB／20,000行，分卷组16MiB／40,000行。 |

管理验证入口：`NativeAdministrationTests`、`NativeWorkspaceCoreTests`、`selfhost/native-auth.test.ts`、用户管理及备份API测试。网关拒绝未列入的路由／方法、身份头覆盖、跨站或浏览器Cookie身份混用；业务API继续独立验证当前身份、角色和CAS版本。

## 未完成填写与恢复规则

这些是页面退出或网络结果未知后可继续的业务能力，不是一个供用户修改原始JSON的通用编辑器。

| 内容 | 本机保护与恢复方式 | 必须继续核对的内容 |
| --- | --- | --- |
| 健康记录、目标、体重计划和健康文件导入表单 | `NativeWorkspacePersistence`按账号与功能加密；健康写入原请求存于设备Keychain | 恢复的表单读取最新版本；文件重新预览；原操作重试保留原标识、版本及内容。 |
| 饮食批量明细、识别描述／结果、目标、食谱模板及公共食品维护填写 | 按账号及表单作用域加密；敏感图片不进入持久草稿 | 恢复只填入表单，不调用AI或自动保存；目录和模板版本变化需核对。 |
| 财务账户、余额、目标、应急储备和邀请填写 | 显式保存草稿并关闭；按账本、授权版本、币种与表单隔离；恢复需核对 | 不能把旧账本或旧授权草稿悄悄移到新账本；原待确认写入优先核对。 |
| 书影音本人整理和导入预览 | 按账号及作品／导入作用域加密；原写入内容独立保留 | 仍须明确保存整理或确认导入，旧预览被服务端数据变化拒绝时重新预览。 |
| 服务密钥／用户密码等管理原操作 | 仅设备Keychain保存待确认的冻结请求 | 结果未知保留原操作；冲突不能自动换用新版本覆盖；可在核对服务器后移除本机待确认内容。 |
| 待恢复备份与备份保存回执 | 加密本机保存原字节、预览与阶段；临时导出文件受系统文件保护 | 原恢复未确认时不自动开始新恢复；可以明确继续或重新核对服务器。 |

`NativeWorkspacePersistence`使用设备Keychain中的专用密钥进行AES-GCM加密，文件按账号和功能命名并排除系统备份；不存访问令牌。退出不会把一个账号的草稿交给另一个账号。

## 自动验证与安装后验收

1. 对最终提交运行 `.github/workflows/ios-healthkit.yml`：项目结构、真实Swift导出契约、`xcodebuild test`、XCTest工件与模拟器截图。Linux静态检查不能替代此项。
2. 在有合成账号的模拟器检查：所有主要入口可到达、表单键盘可用、取消／返回／切换页面保留正确草稿、文件选择与系统分享可完成；同时检查owner／editor／viewer和普通成员界面。
3. 在本人iPhone核对Apple健康授权、真实步数／活动能量／睡眠／体重、设备切换和后台交付。HealthKit后台触发由iOS决定，不能保证固定分钟间隔；真机无权限或无样本也不能显示成零值。
4. 真机安装需要Xcode签名运行、TestFlight或其他实际iOS分发方式。合并部署后端不会自动替换手机上已安装的二进制；需安装本次对应构建，再验证API兼容。
5. 在实际部署核对用户管理、服务配置、备份及外部来源的可用性；测试替身不能证明生产密钥有效、豆瓣可访问或真实AI识别质量已通过。

现有浏览器测试继续维护网页兼容，但浏览器移动视口通过不等于SwiftUI原生页面或iOS真机通过。发布记录保留自动CI结果；安装后的真机检查由实际测试结果记录，不能用合并或构建成功代替。
