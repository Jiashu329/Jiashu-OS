# 阿里云测试站与 GitHub 自动更新

当前目标是独立空库测试站：Alibaba Cloud Linux 4、`root@8.159.158.122:22`、域名 `https://www.treefund.asia`。正式数据继续保存在原 Sites 站点。后续自动更新仅管理 `/opt/jiashu-test` 以及 `127.0.0.1:3100` 的应用容器，不修改 Nginx、证书或既有数据。首次域名接入与已授权的旧服务清理，通过单独的服务器设置工作流完成；清理后 `treefund.asia` 重定向到 www 测试站。

## 一次性配置

1. 在 GitHub 仓库 **Settings → Secrets and variables → Actions → Secrets** 分别新增四项，名称和值分别填写，不把私钥放到聊天、源码或 Actions 日志：

   | Secret 名称 | 内容 |
   | --- | --- |
   | `ALIYUN_HOST` | `8.159.158.122` |
   | `ALIYUN_USER` | `root` |
   | `ALIYUN_SSH_KEY` | 服务器已授权的专用部署 Ed25519 私钥全文 |
   | `ALIYUN_KNOWN_HOSTS` | `8.159.158.122 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHMg0hn9zHh53eQKAsqJrTwnSVFBE0UD2aG56w3C7SCH`（已通过服务器控制台核对） |

   固定入口：`https://github.com/Jiashu329/Jiashu-OS/settings/secrets/actions`。

2. Variables 使用以下默认值，无需把普通配置作为密码：

   | Variable | 默认值 |
   | --- | --- |
   | `ALIYUN_DEPLOY_ENABLED` | 不填时使用仓库激活配置；显式 `false` 暂停自动更新 |
   | `ALIYUN_SSH_PORT` | `22` |
   | `ALIYUN_DEPLOY_PATH` | `/opt/jiashu-test` |
   | `ALIYUN_PUBLIC_ORIGIN` | `https://www.treefund.asia` |
   | `ALIYUN_BIND_PORT` | `3100` |

3. 打开 **Actions → Aliyun deployment → Run workflow**，在 `main` 选择 `inspect`。此操作不要求开启自动部署，只返回 OS、架构、Docker/Compose、指定监听端口与 Nginx 检测状态，不输出环境文件或证书配置。

4. 确认服务器已有可用 Docker Engine、Compose v2、Python 3、`flock`、`curl`、`ss`、`sha256sum`。缺少 Docker 时，可在 **Aliyun server setup** 选择 `install-docker`：按[阿里云官方方案](https://help.aliyun.com/zh/ecs/user-guide/install-and-use-docker)，仅从原生 ALinux4 仓库安装 `moby` 和 `docker-compose-plugin`。已有运行时或容器数据冲突时停止，不替换或卸载它们。

5. 同一提交的四项检查全部成功后，在同一工作流选择 `bootstrap`，确认栏输入 `BOOTSTRAP-JIASHU-TEST`。Bootstrap 会检查现有服务和目录，只创建本应用标记目录、空库持久卷、0600 环境与初始登录文件，并启动 loopback 测试服务。既有 `app.env` 不会被新随机密钥覆盖；非空且无标记的目录、已占用的首次应用端口都会拒绝。

已准备镜像包时，等价的一次性服务器命令为：

```sh
sudo bash /path/to/verified-bundle/bootstrap.sh \
  --app-dir /opt/jiashu-test \
  --bundle /path/to/verified-bundle \
  --public-origin https://www.treefund.asia \
  --port 3100 --confirm-empty-test-site
```

初始用户名默认 `admin`；随机口令只保存在服务器 `/opt/jiashu-test/initial-login.txt`（0600）。仅在阿里云私密控制台读取该文件，不在 Actions 运行 `cat`，也不把内容发到聊天。会话密钥与 AI 配置主密钥存在独立的 `app.env`，后续部署不会重建。迁移真实数据和现有密钥不属于这次空库测试站初始化。

## 验证与域名切换

构建使用 Node.js 24：`npm ci` 后执行 `npm run build:selfhost`。`npm run test:selfhost:smoke` 会启动独立 HTTP 服务，只在 GitHub CI 或允许启动独立服务的测试环境运行；托管 Sites 环境不运行此 HTTP 测试。

在仓库根目录构建当前提交的镜像：

```sh
commit_sha=$(git rev-parse HEAD)
docker build -f selfhost/Dockerfile \
  --build-arg APP_COMMIT_SHA="$commit_sha" \
  --build-arg SELFHOST_PUBLIC_ORIGIN=https://www.treefund.asia \
  -t "jiashu-test:$commit_sha" .
```

先检查 `http://127.0.0.1:3100/_selfhost/healthz` 返回 `ok:true` 且 `commitSha` 与部署提交一致。登录检查须通过 HTTPS 域名进行；生产会话 Cookie 保持 Secure，不为外网 HTTP 关闭保护。

首次接入时，在 **Aliyun server setup** 选择 `inspect`，审阅脱敏后的虚拟主机和 include 结构，并记录 `expectedHash`。应用就绪、同提交检查全部通过后，选择 `configure-web` 并填写该哈希。工具只接受已审阅的配置结构；配置变化时停止，先备份再检查和重载 Nginx。它保留 apex 主页及证书，仅为 www 复制原 HTTPS 虚拟主机并替换根路径，同时保留业务接口 include。后续自动更新不执行该切换步骤。[location 示例](../deploy/aliyun/nginx-location.example.conf)仅供参考，不能当作完整配置覆盖现站。

## 自动更新顺序

本仓库在测试站验证后通过 `deploy/aliyun/activation.json` 激活自动更新，配置仅匹配 `Jiashu329/Jiashu-OS`，无需手动填写 GitHub 变量。复制仓库时不会自动激活其他仓库。若要暂停，可在 **Settings → Secrets and variables → Actions → Variables** 设置 `ALIYUN_DEPLOY_ENABLED=false`；删除该覆盖项或设为 `true` 可恢复。

`main` 更新后，现有 Application checks、Browser acceptance、Douban extension acceptance 和新增 Self-hosted checks 各自执行。部署工作流核对**同一个提交**的四项最新执行全部成功，并核对它仍是 `main` 当前头。PR、fork 或尚未完成／失败的提交不触发部署。

激活后，工作流构建 `selfhost/Dockerfile`，保存压缩镜像及 SHA-256 清单。小型控制脚本通过严格 host-key 验证的 SSH/SCP 传送；镜像上传至保留一天的私有 GitHub Artifact，服务器凭短时签名 URL 通过 HTTPS 下载。签名仅通过 SSH stdin 下发，GitHub token 留在 CI。服务器校验外层 ZIP 摘要、唯一文件白名单及内层镜像归档摘要，再 `docker load`，无需配置 GHCR 凭据。

服务器核对镜像内容、提交标签、平台与全部 RootFS 层，再固定使用目标 Docker 存储的本地不可变 ID，兼容 classic 与 Docker 29 containerd 存储差异。使用全局部署锁防止并发；同一镜像版本已健康上线时直接结束。整个 `/data` 目录持久保存 SQLite、WAL 和 SHM。部署停止旧 app 后创建一致的单文件备份，再只运行未应用的迁移和新容器。备份源连接保持只读，容器以应用 UID 维护必要的 WAL/SHM 辅助文件；快照完成后转为 root 所有、0600 权限。CI 包含真实第二版本升级及只读恢复验收。迁移账本不可删除或盲跑，历史 `0026` 含一次性维护逻辑。

传输异常时，可先运行 **Aliyun server setup → transport-test**。它只传送少量随机测试数据，对比 SSH QoS 与 HTTPS 吞吐，不执行测试载荷，也不修改应用或 Nginx。

新版本必须通过带本次 SHA 的 readiness 检查才成为 current release。没有本次 schema 变化时，失败可恢复上一镜像；本次发生或无法确认迁移时不自动降级数据库或恢复旧备份，停止新 app 并要求前向修复，避免覆盖新数据。回滚不会触碰现有主页或 Nginx。备份和旧镜像不自动清理，可在确认容量与保留策略后单独安排归档。

`/opt/jiashu-test/backups` 保存迁移前一致备份，`releases/<SHA>` 保存非秘密发布记录，`current.env` 只包含不可变镜像 ID、提交和 loopback 端口。服务器私密 `app.env`、登录口令及 SQLite 数据均不进入镜像或 GitHub 工件。

## 一次性清理已退役服务

本次已明确授权清理旧个人主页和 Pharmcube CRM 转发服务，固定范围为 `/var/www/my-homepage`、`/opt/pharmcube-customer-relay`、`pharmcube-sharecrm-relay.service` 及其精确启动链接。SSH、Nginx、证书、Docker 和新站数据保留。

新站 HTTPS 和登录验证成功后，在 **Aliyun server setup** 执行 `inspect-retired`，审阅 version 2 的稳定计划并记录 `expectedHash`。随后选择 `retire-old`，填写该哈希。此步骤要求同提交全部检查成功及新站版本就绪，停止旧 CRM 后完整备份两个目录、单元与 Nginx 配置，核验备份，再移除旧路由、启动项和文件。旧 8788 端口须关闭，HTTP 和 apex HTTPS 须重定向到 www，新站须继续健康；失败自动恢复之前的文件、配置和服务状态。

完整备份及校验回执只保存在服务器 `/opt/jiashu-test/retired-backups/`，目录 0700、归档与回执 0600，包含旧服务私密配置，不上传到 GitHub 或聊天。清理工具不会移除这份恢复副本。
