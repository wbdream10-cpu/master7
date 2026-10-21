# 空白云数据库与 PostgreSQL 运行说明

本版保留独立账号和服务器租户授权，增加外部 PostgreSQL 存储。浏览器仍只请求本平台 API，不直接请求 Supabase Data API，不使用 Supabase Auth，也不向前端提供数据库连接字符串或 service role 密钥。

## 已创建的资源

- 组织：jackysim8800-hue's Org。
- 项目：ahbi-service-portal。
- 项目 ID：aarihmvlnlssxulktbmb。
- 地区：ap-southeast-1（新加坡）。
- 创建时报价：US$0/月；新项目返回 ACTIVE_HEALTHY。后续配额、暂停规则和资源变化以账号实际状态为准，不自动购买或升级。
- 已建立 portal_private 下 13 张表，账号、租户、申请、通道、事件及 Deposit 申请均为空。没有生产老板账号。

管理入口：https://supabase.com/dashboard/project/aarihmvlnlssxulktbmb

这是数据库管理入口，不是前台或后台网址。Render Web Service 尚未部署。

## 代码选择存储的规则

1. 设置非空 PORTAL_POSTGRES_URL：使用 pg 驱动和外部 PostgreSQL。
2. 普通本地开发未设置该变量：使用原有 SQLite，PORTAL_DATABASE 指定本地文件路径。
3. Render 环境缺少 PORTAL_POSTGRES_URL：启动失败，不回退到临时 SQLite。
4. PORTAL_TEST_POSTGRES 仅供自动测试使用嵌入式 PGlite；生产与 Render 禁用该测试驱动。

查询值使用参数绑定。应用生成的 SQLite 参数和冲突目标转换为 PostgreSQL 格式；仅对项目已有查询及其表名适配，不是接受任意外部 SQL 的执行入口。业务表始终限定 portal_private，不依赖连接池会话保留 search_path。事务使用同一个请求所属连接，异常时回滚并归还连接。

请求在单实例内串行处理数据库业务，避免本地 SQLite 在 await 之间交错事务。POST 正文在进入队列前按 16 KB 上限读取，HTTP 设置请求超时。连接池上限 2，数据库语句超时 10 秒。当前按单实例运行设计；未完成多实例、多进程或正式负载验收，不应直接提高实例数量。

## 安全配置连接字符串

部署负责人从 Supabase 项目的 Connect 面板取得适合部署网络的真实连接字符串，在 Render 新服务的秘密环境变量中设置 PORTAL_POSTGRES_URL。不能只用项目 ID、项目 HTTP 地址或 publishable key 代替 Postgres 连接字符串。不要在聊天里发送数据库密码。

本适配器运行迁移，需要对 portal_private 拥有对应建表、索引与权限管理能力，且业务连接必须能以受信任后台角色读取该 schema。当前默认假定使用表拥有者的可信服务器连接；没有创建额外数据库登录角色。若改成最小权限独立角色，必须另行设计授权与 RLS 策略，并重新验收，不能直接给 anon/authenticated 开放权限。

驱动强制 TLS 并校验证书。连接字符串中的 ssl 相关查询参数不会降低此设置；需要专用根证书时使用 PORTAL_POSTGRES_CA_FILE 指向安全证书文件，不得把 rejectUnauthorized 改为 false 来掩盖错误。真实网络、IPv4/IPv6、池化连接及证书是否可用，须在部署环境验收。

其他变量：PUBLIC_ORIGIN 为正式 HTTPS 来源，HOST 为 0.0.0.0，PORT 跟随平台。Render 配置使用 RENDER_EXTERNAL_URL 作为来源，没有在源码中猜测新服务网址。

## 数据结构与浏览器访问

standalone/postgres/0001_portal.sql 是新数据库初始化文件；无业务种子数据。运行时校验迁移哈希，不自动导入 SQLite 或旧站数据。部分开通管理信息由 Supabase 自身保存，不属于平台客户数据。

所有表启用 RLS；schema 和表不向 PUBLIC、anon、authenticated 开放。没有给浏览器添加读取策略。数据库表拥有者的可信后台连接仍可操作表，租户与角色权限由平台服务器实现，因此不能把“RLS 已启用”单独当成数据库层租户隔离证明。

Supabase 安全检查中的 RLS Enabled No Policy 是此关闭直连设计的 INFO 提示。不要为了消除此提示而添加允许所有用户访问的策略。参考：https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy

## 验证方式与实际状态

```sh
npm ci --include=dev
npm run build
npm test
npm run test:postgres
```

第二套测试在本地 PGlite PostgreSQL 引擎上启动真实 HTTP 服务，使用临时数据库覆盖注册、审批、登录、修改密码、会话撤销、各职责与租户隔离、公告、申请、通道、Deposit 申请、事务异常回滚和关闭后重新打开的数据保留。测试显式去掉真实数据库 URL，不向 Supabase 写入测试客户。

已在 Supabase 核对表结构、空记录、RLS 以及 anon/authenticated 没有 SELECT 权限。尚未完成真实 pg 网络连接、生产账号、Render 服务、手机、多用户负载或正式备份恢复。PGlite 测试通过不能代替这些验收。

## 部署顺序

1. 确认新 Web Service 所属 Render 工作区和免费配额，使用当前仓库的免费配置；不绑定收费磁盘。
2. 在安全配置界面填入 PORTAL_POSTGRES_URL；必要时配置 CA 文件。
3. 部署并检查构建与启动日志，避免记录秘密值。
4. 核对返回的实际 URL 和 PUBLIC_ORIGIN；创建生产总部账号，保存一次性恢复码。
5. 用实际用户完成权限、重启持久性、手机、并发和备份恢复验收。
6. 最后交付前台 / 与后台 /admin 正式链接，再由接手人员处理外部连接。

## 备份与恢复

PostgreSQL 不能使用 SQLite VACUUM INTO。standalone/admin.mjs 在 PostgreSQL 模式下明确拒绝 SQLite 备份命令。

负责人应在受信任环境使用 pg_dump 备份 portal_private，连接凭据通过安全的 Postgres 环境/服务配置传入，不直接写入命令历史。备份文件含密码哈希、会话与用户资料，需要私密保存。恢复须先在隔离数据库演练，确认表结构、权限、RLS、迁移哈希与业务记录后，撤销恢复出的旧会话，再开放服务。目前未配置自动备份、恢复按钮或生产恢复任务。
