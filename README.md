# White-label Platform

全新的普通服务平台：客户前台、老板后台、独立账号密码、Logo 设置、公告、服务申请、账号审批、操作记录、通用签名事件接收接口、Deposit 申请登记和后台只读记录。默认没有照片、客户资料、公告、申请、连接配置或事件。首次部署仅由部署负责人创建总部账号；租户和其他职责均从空白开始，由总部随后分配。

## 安装与验证

需要 Node.js 24.19.0 或更高版本。

```sh
npm ci --include=dev
npm run build
npm test
npm run test:postgres
```

源码不依赖 ChatGPT 登录或 Sites 运行环境。数据库迁移只创建表，不导入任何旧数据。测试使用临时数据库，结束后删除测试数据。

## Render 与云端数据库

仓库根目录的 `render.yaml` 已改为新加坡免费 Node Web Service `ahbi-service-portal`，无付费持久磁盘。数据使用外部 PostgreSQL；配置不是部署证明，也不保证账号一定有可用免费配额。

已创建独立 Supabase 项目 `ahbi-service-portal`（新加坡，项目 ID `aarihmvlnlssxulktbmb`），创建时工具报价 US$0/月。仅建立 `portal_private` 下的 13 张空表；未创建生产账号、导入旧数据或连接实际外部服务。

正式启动必须安全配置 `PORTAL_POSTGRES_URL`。它是服务器秘密，不能发到聊天、提交 GitHub 或放入前端。服务端强制 TLS 证书校验；需要专用 CA 时另设置 `PORTAL_POSTGRES_CA_FILE`。Render 缺少数据库 URL 时直接拒绝启动，防止误用临时 SQLite。完整步骤、权限和验证限制见 [PostgreSQL 云端说明](docs/POSTGRES.md)。

首次老板开户仍在受信任环境中使用安全输入；创建账号和启动必须使用同一数据库环境配置。示例为 Bash，不能把占位邮箱当成真实账号：

```sh
read -rs -p '老板密码：' portal_password
printf '%s' "$portal_password" | node standalone/admin.mjs create-owner boss owner@example.com
unset portal_password
```

此命令从标准输入读取密码，只显示一次恢复码；已有老板时拒绝覆盖。创建的生产账号和密码不包含在本仓库。

## 入口

| 路径 | 用途 |
|---|---|
| `/` | 客户前台，需登录 |
| `/admin` | 老板后台，需老板权限 |
| `/accounts` | 老板审批或暂停客户账号 |
| `/connections` | 老板配置通用回调接收通道 |
| `/account` | 修改密码、撤销全部旧登录并轮换恢复码 |
| `/signin`、`/register`、`/reset` | 登录、申请注册、恢复码重设密码 |
| `/health` | 进程健康检查 |

客户注册后需老板核实并批准。邮箱没有自动验证，不应仅根据填写的邮箱批准账号。总部账号在 `/accounts` 创建空白租户，为已注册账号分配租户老板、员工或客户职责；账号批准与职责分配分开进行。租户老板只管理本租户公告、Logo、申请和客户审批；员工只读取本租户已发布公告及处理服务申请，不能管理账号、Logo、公告、连接或日志。总部负责分配成员和职责；职责变更立即撤销旧登录。已明确归属其他租户的账号不能直接转移。自定义外观只提供 Logo 入口。

## 接手人员

阅读 [通用接口说明](docs/INTEGRATION.md) 和 [Deposit 申请说明](docs/DEPOSIT.md)。事件接收采用独立密钥、签名、时间窗口、重复事件校验，并存储到配置所属工作空间；默认未配置任何外部服务。`202 accepted` 只表示接收，`processed:false` 明确表示尚未处理，不会产生任何资金、余额或业务状态变化。

## 备份

```sh
node standalone/admin.mjs backup /PRIVATE_BACKUP_PATH/portal-backup.sqlite
```

以上命令仅用于本地 SQLite；PostgreSQL 使用受信任环境中的 pg_dump，详见云端说明。目标必须不存在。备份含敏感账号信息，需私密保存并下载至受控备份位置；同一磁盘内的副本不能替代异地备份。恢复前停止服务、备份当前文件，经审核后恢复快照，并撤销旧会话。

## 交付状态与范围

本仓库提供可运行源码、SQLite/PostgreSQL 两种存储适配与部署配置；GitHub 上传不代表已在 Render 上线。正式服务部署、生产老板开户、正式域名、手机与多用户运行、备份恢复仍需实机验收。没有旧站数据迁移、照片、外部供应商适配、实际收付款、余额、支付订单或短信/邮件 OTP。通用回调不会冒充任何供应商协议。真实接入由接手人员另行实现并测试。

账号安全入口要求当前密码及新密码确认；成功后退出所有会话、使旧恢复码失效，并仅显示一次新恢复码。没有邮件或短信发送，不能将人工批准或恢复码当成 OTP。

SQLite 与嵌入式 PostgreSQL/PGlite 本地 HTTP 回归测试通过，包含事务回滚与数据重新打开检查。Supabase 已验证空表、RLS 与浏览器角色无直接读取权限；真实服务到 Supabase 的网络/TLS/账号连接尚未验证，不等于已经上线。
