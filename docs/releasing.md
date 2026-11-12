# 发布与回退

开发期间运行 `npm run check`。检查顺序是类型检查、全部普通测试、生产构建、生产产物 DOM 冒烟；任一失败都会停止。测试文件自动发现，依赖 `dist` 的 `*-production-client.test.ts` 只在构建完成后运行。

GitHub 的 `main` 推送和拉取请求会执行相同的 `release:check`，另有独立的 **Browser acceptance / synthetic-browser-acceptance** 任务运行 `npm run test:browser`，保存实际 Chromium 截图、失败 trace 与报告。两类检查都需核对；CI 使用合成数据，不读取线上记录、不持有网站密钥，也不自动部署。

最终发布流程：

1. 完成并提交源码，确保 `git status --short` 为空。
2. 运行 `npm run release:check`。这会重新执行整套检查，并在 `dist/release-provenance.json` 写入源码提交、源码指纹、产物指纹、站点 ID 和检查结果。
3. 核对对应提交的浏览器 CI 结果与截图；iPhone Safari、健康权限和快捷指令安装／运行按[浏览器与 iPhone 验收](browser-acceptance.md)另行完成，未实测时如实记录。通过 Sites 获取当前站点的短期源码写入凭据。保持现有访问范围。
4. 使用关闭终端回显的 PTY 启动 `stty -echo && node scripts/publish-source.mjs`，在提示后通过标准输入传入工作流 JSON：`credential`、`project_id`、绝对 `archive_path`；设置 `sync_github: true` 可同时同步已配置的 GitHub `origin`。凭据只留在会话内存和子进程环境中。
5. 将脚本返回的 `project_id`、`commit_sha`、`archive` 原样传给适用的原生 Sites 保存／部署操作，确认部署成功。

发布脚本只接受已提交且通过全部检查的源码，不自动提交、不强制推送。如果源码、HEAD 或构建文件在验证后变化，必须重新检查和构建。独立运行 `npm run build` 适用于本地构建；它不替代完整发布检查。`mode: "verify"` 可只验证现有产物，不进行网络操作。

生产产物检查覆盖健康、同步、首页、财务、饮食、数据备份、快捷指令核对、AI 设置及助手初始化。390px 的 DOM 场景检查导航和对话控件的语义；它不验证浏览器绘制、触摸命中区域或 iPhone 快捷指令。真实绘制与交互由独立 Chromium 合成套件补充；390px 移动视口不等于 iOS Safari，iPhone 快捷指令仍须真机验收。

需要回退时，在 Sites 的已保存版本中选择此前成功的稳定版本并重新部署；不要强推 Git 历史或使用旧 `dist` 冒充当前提交。数据库迁移采用追加方式，回退前检查新迁移与旧 Worker 的兼容性；回退 Worker 不会撤销已经应用的数据迁移。

本轮开始使用独立的余额更正历史。早于本轮的 Worker 不理解这些记录，回退后可能显示原始余额。因此，已经产生更正／作废记录后，应优先前向修复，或选择同样支持有效余额计算的稳定版本；不能把代码回退当作数据回退。

本轮增加每日营养目标、饮食审计与历史恢复回执，完整备份仍为 v2，覆盖 22 类业务表并兼容旧备份；另为账户资料和财务目标增加独立编辑版本。应用迁移后旧 Worker 不提供这些界面与冲突保护，回退前须检查数据与写入接口兼容性，优先前向修复。
