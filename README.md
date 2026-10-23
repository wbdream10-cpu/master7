# White-label Platform

全新的普通服务平台：客户前台、老板后台、独立账号密码、品牌设置（名称、欢迎语、主题色、Logo、默认语言与客服入口）、公告、服务申请、账号审批、操作记录、通用签名事件接收接口、Deposit 申请登记和后台只读记录。随代码附带用户确认的 MASTER7 / SEVEN 官方 Logo；默认没有客户照片、客户资料、公告、申请、连接配置或事件。首次部署仅由部署负责人创建总部账号；租户和其他职责均从空白开始，由总部随后分配。

## 安装与验证

需要 Node.js 24.19.0 或更高版本。

```sh
npm ci --include=dev
npm run build
npm test
npm run test:postgres
npm run test:migrations
npm run test:storage
npm run test:payments
npm run test:wallet
npm run test:wallet:http
npm run test:checkout
npm run test:withdrawals
npm run test:owner-bootstrap
```

源码不依赖 ChatGPT 登录或 Sites 运行环境。数据库迁移创建表结构并补充字段，不导入任何旧数据。测试使用临时数据库，结束后删除测试数据。

## Render 与云端数据库

仓库根目录的 `render.yaml` 已改为新加坡免费 Node Web Service `ahbi-service-portal`，无付费持久磁盘。数据使用外部 PostgreSQL；配置不是部署证明，也不保证账号一定有可用免费配额。

已创建独立 Supabase 项目 `ahbi-service-portal`（新加坡，项目 ID `aarihmvlnlssxulktbmb`），创建时工具报价 US$0/月。仅建立 `portal_private` 下的 13 张空表；未创建生产账号、导入旧数据或连接实际外部服务。

正式启动必须安全配置 `PORTAL_POSTGRES_URL`。它是服务器秘密，不能发到聊天、提交 GitHub 或放入前端。服务端强制 TLS 证书校验；需要专用 CA 时另设置 `PORTAL_POSTGRES_CA_FILE`。Render 缺少数据库 URL 时直接拒绝启动，防止误用临时 SQLite。完整步骤、权限和验证限制见 [PostgreSQL 云端说明](docs/POSTGRES.md)。

如同一部署要接受多个 HTTPS 自定义域名，可在域名 DNS、托管绑定和 TLS 证书都已准备并验收后，在服务环境中配置 `PORTAL_ALLOWED_ORIGINS`，值为逗号分隔的纯 origin，例如 `https://master7.vip,https://master7.best`。服务会将这些精确来源加入 POST 请求的来源校验；不接受路径、凭据或非 HTTPS 外部来源。`PUBLIC_ORIGIN` 仍是主来源，且允许列表必须使用相同协议。此设置只放行来源校验，不会绑定域名、配置证书、改 DNS 或解除 Cloudflare 冻结；未准备好前不要设置正式域名。

首次老板开户仍在受信任环境中使用安全输入；创建账号和启动必须使用同一数据库环境配置。示例为 Bash，不能把占位邮箱当成真实账号：

```sh
read -rs -p '老板密码：' portal_password
printf '%s' "$portal_password" | node standalone/admin.mjs create-owner boss owner@example.com
unset portal_password
```

此命令从标准输入读取密码，只显示一次恢复码；已有老板时拒绝覆盖。创建的生产账号和密码不包含在本仓库。

没有 Render Shell 时，可由部署负责人临时启用 `/owner-setup` 一次性 HTTPS 开户页。服务器只接收 `PORTAL_OWNER_BOOTSTRAP_TOKEN_SHA256` 的 SHA-256 摘要、固定账号与邮箱、到期时间；原始开户码和自选密码不得进入聊天、URL、源码或日志。页面只在数据库没有 owner、`PORTAL_OWNER_BOOTSTRAP_ENABLED=true` 且配置未过期时可用；成功后数据库唯一索引保证无法建立第二个 owner，恢复码只显示一次。变量名：`PORTAL_OWNER_BOOTSTRAP_USERNAME`、`PORTAL_OWNER_BOOTSTRAP_EMAIL`、`PORTAL_OWNER_BOOTSTRAP_TOKEN_SHA256`、`PORTAL_OWNER_BOOTSTRAP_EXPIRES_AT`。开户完成后应关闭 `PORTAL_OWNER_BOOTSTRAP_ENABLED`。

## 入口

| 路径 | 用途 |
|---|---|
| `/` | 客户前台，需登录 |
| `/admin` | 老板后台，需老板权限 |
| `/accounts` | 老板审批或暂停客户账号 |
| `/connections` | 老板配置通用回调接收通道 |
| `/account` | 修改密码、撤销全部旧登录并轮换恢复码 |
| `/owner-setup` | 仅首次部署时使用的一次性总部管理员安全开户 |
| `/signin`、`/register`、`/reset` | 登录、申请注册、恢复码重设密码 |
| `/health` | 数据库就绪检查与部署提交标识 |

客户注册后需老板核实并批准。邮箱没有自动验证，不应仅根据填写的邮箱批准账号。总部账号在 `/accounts` 创建空白租户，为已注册账号分配租户老板、员工或客户职责；账号批准与职责分配分开进行。租户老板只管理本租户公告、品牌设置、申请和客户审批；员工只读取本租户已发布公告及处理服务申请，不能管理账号、品牌设置、公告、连接或日志。总部负责分配成员和职责；职责变更立即撤销旧登录。已明确归属其他租户的账号不能直接转移。

后台“品牌设置”支持修改名称、欢迎语、六位主题色、HTTPS Logo 地址、品牌默认语言与 HTTPS 客服地址，保存前可查看预览。总部可切换品牌管理，租户老板仅可修改自己的品牌；保存写入同一份品牌资料和审计记录，会员刷新后读取已保存设置。客服地址留空时不展示入口；主品牌 Logo 留空时使用用户确认的 MASTER7 / SEVEN 官方原图，其他租户留空时使用文字标识。登录页使用同一张官方 Logo。仅允许不含账号密码的 HTTPS 地址。

默认语言可选简体中文、English、Bahasa Melayu；当前功能只保存品牌语言偏好，现有页面文案仍为中文，尚未实现整站翻译。数据库新增迁移为旧品牌补上默认语言 `zh-CN` 与空客服地址，保留已有名称、欢迎语、主题色和 Logo；发布前仍需备份并在隔离环境验证真实数据库迁移。`test:migrations` 验证本地 SQLite/PGlite 旧结构升级及重启，不替代云端 PostgreSQL 验收。

免费游戏大厅只读显示 MegaH5、JILI 与 918KISS 三个赞助商目录。`GET /api/v1/sponsored-games?provider=<megah5|jili|918kiss>` 需要平台登录，并继续执行租户隔离；接口只投影游戏编号、名称、分类、HTTPS 图片和维护状态，固定返回 `launchEnabled:false` 与 `walletUsed:false`，不提供游戏启动、供应商玩家、下注或钱包调用。`freeOnly` 与 `freeEligibilitySource:user_confirmed_sponsorship` 来自用户确认的三方赞助安排；它不代表厂家账号、免费启动或 GameLogin 已通过验收。部署方只能将 `PORTAL_GAMES_GATEWAY_URL` 设置为固定来源 `https://master7-integration-gateway.onrender.com`；若该网关要求机器认证，可另设 `PORTAL_GAMES_GATEWAY_TOKEN`。目录环境默认保守标为 `uat`，只有明确设置 `PORTAL_GAMES_GATEWAY_MODE=production` 才会显示生产目录。秘密不能写入前端、日志或仓库。网关未配置、来源不匹配、供应商账号未开通或目录读取失败时，页面显示等待同步或暂时不可用，不用历史快照或样位游戏冒充实时目录。

银行转账充值默认关闭且不预置真实银行资料。总部或租户老板可保存银行名称、户口名字和户口号码并决定是否开放；会员提交金额、付款人、银行交易编号、转账时间及最大 2 MiB 的 JPEG、PNG 或 WebP 单据。单据保存在私有数据库表，没有公开文件地址，仅本人、同租户老板、总部及明确获授权的财务员工可读。财务批准前必须在银行后台核实实际到账，并提交所查看单据的 SHA-256；批准事务只写入一次订单和钱包账本。系统不收集银行登录 ID、密码、OTP 或 Authenticator 动态码。今日财务概览按 Asia/Kuching 分列 VPay、GSPAY+ MYR、银行转账、待审核、已入账、已付款提现和新注册；未接通的 GSPAY+ MYR 固定显示未开放。

人工提现同样默认关闭。启用后，会员提交 MYR 金额与本人收款银行资料，平台在原子余额检查后冻结可用额；财务可以开始处理、拒绝、登记人工付款或标记失败。只有登记为已付款的申请才写入一次负数钱包账本并进入今日提现总额，拒绝或失败会释放冻结。模块不会登录银行、调用 GSPAY Payout 或自动转账；关闭新申请开关也不会阻止财务处理已有冻结。接口、状态机、权限、CSV 与验证范围见 [人工提现与财务审核](docs/WITHDRAWALS.md)。

Deposit 页新增独立 VPay 建单表单，默认关闭；GSPAY+ MYR 与 USDT 保留未开放的入口，USDT 不接收新订单。服务端只读查询固定 VPay 网关状态，总部后台可查看脱敏的检查结果；配置资料存在或网关报告就绪均不会自动开启本平台结算。GSPAY+ MYR 已加入不联网的签名、查单/回调验签及 DuitNow 状态校验，并提供登录后、按租户隔离的固定关闭状态接口。两个“集成网关 → 门户”的内部 Payment/DuitNow 机器入口只接受独立 Bearer token 与最多 16 KiB 的 JSON object；即使凭据和正文有效也固定返回 503 `GSPAY_SETTLEMENT_DISABLED`，不查厂家、不保存回调、不写订单/审计/钱包、不返回成功确认。厂家截图中的公开路径、建单、USDT 与 Payout 均未实现。普通会员不接收秘密或诊断详情，USDT 保持停止新订单。详见 [Deposit 申请说明](docs/DEPOSIT.md)及 [GSPAY+ MYR 接入准备](docs/GSPAY.md)。

每笔平台充值订单另存明确来源 `vpay`、`gspay_myr`、`bank_transfer` 或 `unknown`。新增迁移把旧银行订单归为银行转账，其余已有平台订单归为 VPay；后续未指定来源的记录会进入“未识别渠道”单独核对，不会混进 VPay 金额。财务员工须经总部或租户老板单独授权，才可查看并导出本租户统一充值记录；普通员工不能查看。统一记录筛选按 Asia/Kuching 日期计算，CSV 时间戳仍标明 UTC。GSPAY+ MYR 的离线协议与固定 503 内部边界不会自动启用建单、公开厂家回调或入账。

VPay 的独立离线契约模块提供 MYR 精确金额、未签名建单资料及供应商返回字段校验；模块自身不导入数据库、不读取密钥、不发送请求或入账；本分支另有服务路由使用它校验付款字段。解析到供应商的“已付款”状态仍返回 `authenticated:false` 与 `fundsProcessed:false`，不能据此入账。实现范围及真实联调前提见 [VPay 接入准备](docs/VPAY.md)。

## 接手人员

已新增会员建单、充值核验、事务入账、会员充值余额与后台核对代码，建单和回调默认关闭。尚未部署或接通原游戏平台会员与游戏主钱包；完整范围、配套网关依赖及验收限制见 [钱包与后台核对](docs/WALLET.md)。

阅读 [通用接口说明](docs/INTEGRATION.md) 和 [Deposit 申请说明](docs/DEPOSIT.md)。事件接收采用独立密钥、签名、时间窗口、重复事件校验，并存储到配置所属工作空间；默认未配置任何外部服务。`202 accepted` 只表示接收，`processed:false` 明确表示尚未处理，不会产生任何资金、余额或业务状态变化。

## 备份

```sh
node standalone/admin.mjs backup /PRIVATE_BACKUP_PATH/portal-backup.sqlite
```

以上命令仅用于本地 SQLite；PostgreSQL 使用受信任环境中的 pg_dump，详见云端说明。目标必须不存在。备份含敏感账号信息，需私密保存并下载至受控备份位置；同一磁盘内的副本不能替代异地备份。恢复前停止服务、备份当前文件，经审核后恢复快照，并撤销旧会话。

## 交付状态与范围

本仓库提供可运行源码、SQLite/PostgreSQL 两种存储适配与部署配置；GitHub 上传不代表已在 Render 上线。正式服务部署、生产老板开户、正式域名、手机与多用户运行、备份恢复仍需实机验收。没有完成旧站数据迁移、实际收付款、完整游戏钱包或短信/邮件 OTP。本分支增加的 VPay 钱包充值账本与后台核对仍需原站会员与钱包映射、配套网关、供应商验收和部署接线；默认不会处理线上资金。原有网关状态查询不创建订单或处理资金，通用回调不会冒充任何供应商协议。

账号安全入口要求当前密码及新密码确认；成功后退出所有会话、使旧恢复码失效，并仅显示一次新恢复码。没有邮件或短信发送，不能将人工批准或恢复码当成 OTP。

SQLite 与嵌入式 PostgreSQL/PGlite 本地 HTTP 回归测试通过，包含事务回滚与数据重新打开检查。Supabase 已验证空表、RLS 与浏览器角色无直接读取权限；真实服务到 Supabase 的网络/TLS/账号连接尚未验证，不等于已经上线。
