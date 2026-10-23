# VPay 建单、自动入账与后台核对（待部署接线）

本分支在已有服务门户中实现会员充值建单、核验、钱包充值账本和后台记录。代码尚未部署，尚未接入原游戏平台的会员；不代表 `master7.vip` 或 `master7.best` 已接通钱包，不迁移或覆盖旧余额。

## 执行流程

1. 已批准会员在 Deposit 页填写充值方式、MYR 金额及付款人姓名。`POST /api/v1/payments/vpay/orders` 要求会员会话、同源 Origin、JSON 和 `X-Portal-Request: 1`。会员、租户、商户、环境、回调地址与标题均由服务端确定。
2. 平台先保存订单和请求标识，再以条件更新认领一次建单任务。查单凭据读取固定网关的认证配置，核对商户、环境、开通通道及回调地址；另一份仅建单凭据调用网关。厂商密钥和网关管理员凭据不进入门户或浏览器。
3. 平台校验建单回执中的商户、内外订单号、精确金额和固定 VPay 收银台地址，再提供付款链接。浏览器不能提交或绑定厂商单号。原 Deposit 申请登记仍独立保留，不会产生可付款订单。
4. 建单超时、服务重启或响应字段异常均保留原订单，重试相同请求标识不会再次向厂商建单。页面在当前浏览器标签页保留原请求资料，刷新后需主动查询原订单，不会自动发送付款。付款链接不保存在浏览器缓存中；请求资料含用户填入的付款人姓名，不能视作秘密存储。
5. VPay 通知先经过网关验签，再用独立机器凭据转发到 `/api/v1/payment-callbacks/vpay/payment`。钱包独立执行认证 `ORDER_GET`，核对商户、内外订单号、币种、金额及已付款状态。响应丢失但已发起建单的订单，可经相同核验恢复绑定与入账。
6. 同一数据库事务更新订单状态、写入金额相反且总和为零的会员／清算账本记录并留下审计。提交完成后才返回精确 `SUCCESS`；重复通知不会重复加钱，事务失败全部回滚并允许回调重试。
7. 会员查看自己的充值账本余额与记录；总部及租户老板查看授权租户记录、异常与 CSV。`GET /payment-return` 只提示查阅记录，不信任浏览器参数、不触发入账。

## 数据与核对边界

- SQLite／PostgreSQL 迁移 `0003_wallet_deposits.sql` 创建私有订单、账本和复核表；`0004_vpay_checkout.sql` 添加建单结果与回执字段，不改写已有账本。PostgreSQL 使用私有 schema、RLS 并撤销浏览器角色直接访问。
- UAT／production 分开记账。UAT 只是本地配置，不能证明供应商提供沙箱；本地模拟测试不允许使用真实付款补测。
- `GET /api/v1/wallet` 保留 `balanceMinor`，并返回 `postedBalanceMinor`、`heldMinor` 与 `availableMinor`。正式环境余额包含已核验充值和已登记付款的人工提现，活动提现冻结只减少可用额；UAT 仍只有充值测试账本。尚无旧余额初始化、游戏扣款、退款冲正或完整游戏主钱包，不能用于宣称原会员游戏余额已恢复。人工提现边界见 [人工提现与财务审核](WITHDRAWALS.md)。
- `GET /api/v1/payment-records` 支持环境、租户、最多 31 个 UTC 日筛选及 100 条分页；合计覆盖整个筛选期间。核验／入账时间按 MYT 显示。
- `GET /api/v1/payment-records/export` 仅管理角色可用，完整导出期间最多 10000 条订单，超限明确拒绝；导出审计并防止表格公式注入。后台查询和 CSV 不包含付款链接。
- 汇总来自本地订单与账本；没有导入 VPay／银行全量结算报表，不能声称银行结算对账完成。
- 金额、币种、订单不符、撤销、风险状态、会员归属变化进入复核；临时查单或入账失败留痕并重试。没有公开改余额、清除复核或伪造成功接口。
- 建单结果不确定且没有后续通知的订单，需要独立核对；暂未实现定时查单、取消、超时自动重建、复核操作台或退款。供应商过期时间保留原文，不猜测时区或自动判定可重建。
- 仅保存白名单核对字段；不保存原始通知、签名、密钥、银行卡号或厂商错误原文。VPay `sign` 可能含可逆秘密，禁止记录。付款链接只作为私有订单字段保存并仅向该会员返回。

## 配置

所有开关默认关闭。秘密分别生成，通过服务密钥管理配置，不复用管理员密钥。

| 门户变量 | 用途 |
| --- | --- |
| `PORTAL_VPAY_SETTLEMENT_ENABLED` | 只有字面字符串 `true` 启用接收 |
| `PORTAL_VPAY_ORDERS_ENABLED` | 只有字面字符串 `true` 启用会员建单，同时要求入账开关启用 |
| `PORTAL_VPAY_TRADER_ID` | 已核对的商户编号 |
| `PORTAL_VPAY_ENVIRONMENT` | 显式 `uat` 或 `production` |
| `PORTAL_VPAY_TRADE_CODES` | 已确认开通的通道字符串 JSON 数组，不得凭文档枚举推断开通 |
| `PUBLIC_ORIGIN` | 门户真实 HTTPS 来源 |
| `PORTAL_VPAY_RETURN_URL` | 同一来源的完整 HTTPS 返回地址，可用 `/payment-return` |
| `PORTAL_VPAY_CALLBACK_TOKEN` | 网关至钱包，32–1024 字节 |
| `PORTAL_VPAY_QUERY_TOKEN` | 门户认证配置与查单，32–1024 字节 |
| `PORTAL_VPAY_ORDER_TOKEN` | 门户仅建单，32–1024 字节 |

配套网关固定为 `https://master7-integration-gateway.onrender.com`。`platform-samples` 分支 `codex/vpay-wallet-query-peer` 提供：

- `GET /platform/vpay/config`：`PLATFORM_QUERY_TOKEN` 认证，返回商户、环境、通道和回调配置，无秘密。
- `POST /platform/vpay/order-query`：同一查询凭据，仅 `ORDER_GET`，必须包含内外订单号。
- `POST /platform/vpay/order`：独立 `PLATFORM_ORDER_TOKEN`，仅建单；不能提现、查余额或访问管理员 API。严格核对服务器配置的通道和通知／返回地址。

网关与门户的对应查询、建单、回调秘密分别一致。网关显式设置 `VPAY_ENABLED_TRADE_CODES` 字符串 JSON 数组、`VPAY_RETURN_URL`、`VPAY_MODE`、`PUBLIC_BASE_URL`、`VPAY_PAYMENT_FORWARD_URL` 和现有启用开关。通知地址固定网关 `/callbacks/vpay/payment`；转发目标为钱包的机器回调路由，不能指向登录页或厂商后台。

当前运行网关尚无上述配套端点；新代码未配置秘密、未启用支付、未部署。先确认原站会员／钱包映射、真实数据库备份迁移、通道开通与供应商验收，再安排接线。旧页面、域名和 Cloudflare 保持原状。

## 验证

```sh
npm run build
npm run test:checkout
npm run test:wallet
npm run test:wallet:http
npm run test:payments
npm test
npm run test:postgres
npm run test:migrations
npm run test:storage
```

建单与钱包用例在临时 SQLite 和 PGlite 验证。HTTP 用例模拟网关配置、建单与查单，实际经过会员提交、机器回调、入账、会员余额、后台查询和 CSV。覆盖权限、CSRF、默认关闭、并发重复、超时不重建、响应丢失恢复、字段不符、事务回滚、环境隔离及旧账本升级。

没有调用真实支付创建接口、没有真实资金、没有给线上会员加款。本地测试不替代真实 PostgreSQL 网络、用户设备、供应商签名回调和生产验收。

可选浏览器检查：在已安装 Playwright 和 Chromium 的受控环境执行
`PORTAL_BROWSER_QA=1 npm run test:wallet:http`。可用 `CHROMIUM_EXECUTABLE`
指定浏览器路径，用 `PORTAL_BROWSER_ARTIFACTS` 指定已存在的截图目录。
测试只代理到本地合成数据库和模拟网关，检查手机表单、刷新恢复、无横向依赖的
会员记录卡片、租户切换后的后台记录及 CSV 下载，不访问真实付款链接。
