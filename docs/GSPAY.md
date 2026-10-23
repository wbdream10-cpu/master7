# GSPAY+ 接入准备

本页依据用户提供的 GSPAY+ Prod 后台说明及 API 文档截图整理，证据时点为 2026-10-24（Asia/Kuala_Lumpur）。以下内容用于离线合约实现和测试，不代表厂家认证、生产回调已保存、余额已读取、真实订单已创建或会员钱包已入账。

`standalone/gspay-contract.mjs` 只处理 MYR 金额、签名和状态规则。它接收运行时传入的签名资料，但不自行从环境读取、不持久化、不投影商户凭据，也不发出网络请求或修改数据库。`standalone/gspay-runtime.mjs` 另外提供一个默认关闭的内部边界；它同样不会联系厂家、保存回调、建立订单或修改钱包。GSPAY+ MYR 充值、DuitNow、USDT 和提款通道仍保持关闭。

## 默认关闭的门户运行时边界

门户提供以下三个受控路径：

| 路径 | 调用方 | 固定行为 |
| --- | --- | --- |
| `GET /api/v1/payments/gspay/config?tenant=...` | 已登录会员、租户老板或总部 | 按会话与租户范围返回脱敏状态；所有启用和就绪字段固定为 `false`，blocker 为 `GSPAY_SETTLEMENT_DISABLED` |
| `POST /api/v1/payment-callbacks/gspay/payment` | MASTER7 集成网关 | 只接受独立 Bearer token、`application/json` 和最多 16 KiB 的 JSON object；有效请求仍固定返回 HTTP 503 `GSPAY_SETTLEMENT_DISABLED` |
| `POST /api/v1/payment-callbacks/gspay/duitnow` | MASTER7 集成网关 | 与 Payment 内部入口相同，固定关闭 |

这两个 POST 是“集成网关 → 门户”的内部机器路径，**不是厂家后台应填写的公开回调 URL**。它们位于浏览器 Origin/CSRF 流程之外，先校验服务端机器凭据，再读取有限请求体。`PORTAL_GSPAY_CALLBACK_TOKEN` 必须至少 32 字节，并与 VPay、游戏网关、通用 hook、总部开户及 GSPAY 厂家凭据不同；变量只由服务器秘密配置注入。未配置或重复使用凭据时入口返回 503，配置有效但凭据错误或缺失时返回 401。

即使设置了该变量，Payment 与 DuitNow 的有效 JSON 请求仍只返回 503。运行时不会使用、保存或回显厂家 auth key、secret、token、IP、签名、remark 或原始正文；请求正文只在机器认证后限量解析为 JSON object，随即丢弃。厂家凭据只在内存中用于阻止内部 token 复用，不参与验签或网络请求。运行时不写 audit、订单或钱包账本，不发出厂家查询，不返回 `SUCCESS` 或任何 2xx 确认。设置内部 token 不会启用结算。

## MYR Payment

### 创建订单

- 请求：`POST https://api.thegspay.com/v2/integrations/operators/{operator_authentication_key}/payment`
- JSON：`transaction_id`、`amount`、`player_username`、`signature`
- 签名原文：`transaction_id + player_username + amount（固定两位小数） + operator_secret_key`
- 算法：MD5；各字段之间不加空格。
- 厂家生成的付款订单及付款 URL 只存活两分钟。
- 如需一程返回，文档要求在厂家返回的支付 URL 后追加经过 URL 编码的 `return` 参数。当前资料没有说明完整拼接规则和允许的返回域名，因此代码不会自行猜定。

文档只说明 HTTP 200 代表请求成功，未显示成功响应的完整 JSON。付款 URL、厂家 payment ID、到期字段、失败错误码及错误正文的准确字段名仍待取得，不能在字段未知时接通真实建单。

### 查询订单

- 请求：`GET https://api.thegspay.com/v2/integrations/operators/{operator_authentication_key}/getpayment`
- 文档参数：`auth_key`、`transaction_id`。
- 响应字段：`payment_id`、`transaction_id`、`player_username`、`amount`、`completed`、`success`、`remark`、`signature`。
- 响应签名原文：`payment_id + amount（固定两位小数） + transaction_id + operator_secret_key`。

必须先确认 `completed=true/1`，再判断 `success=true/1`。查询值同时要与平台已保存的订单、会员和精确金额一致。路径中已有认证 key，但参数表又列出 `auth_key`；它究竟放在 query、header 还是其他位置仍待厂家确认。

### Payment 回调

厂家在完成支付后向商户设置的 Payment Callback URL 发送 POST。文档列出认证参数 `auth_key`，但未说明它位于 query、header 或 JSON。

回调 JSON 字段为：`success`、`completed`、`payment_id`、`transaction_id`、`player_username`、`amount`、`remark`、`signature`。签名公式与查单相同。只有订单、会员、金额、auth key 和签名全部通过，且独立查单也确认 `completed=true`、`success=true`，才具备进入幂等账本事务的条件；单靠回调布尔值不入账。

`payment_id` 标为 bigint。若厂家以超过 JavaScript 安全整数范围的 JSON 数字发送，解析时可能丢失精度并使验签无效；正式适配前需确认实际编码为字符串还是数字。

## DuitNow MYR

- 创建请求：`POST https://api.thegspay.com/v2/integrations/operators/{operator_authentication_key}/duitnow/payment`
- 请求字段和建单签名与普通 Payment 相同。
- 付款订单及二维码只存活两分钟。会员必须支付厂家实际返回的精确金额；不能保存二维码后脱离当前订单重复使用。
- 厂家可能因为金额占用返回调整后的唯一金额。平台必须分别保存会员请求金额与厂家应付金额，不能覆盖或混为一个字段。

DuitNow 回调字段为 `dnpayment_id`、`transaction_id`、`amount`、`expire_date`、`status`、`remark`、`signature`。`expire_date` 不在厂家列出的签名公式中，代码只把它保留为厂家报告值，不用它决定结算或可信到期时间。签名原文为：

```text
dnpayment_id + amount（固定两位小数） + transaction_id + status + operator_secret_key
```

已见状态：`0` Pending/Expired、`1` Success（manual update）、`2` Success、`4` Timeout/Rejected。状态 1 必须交给财务复核；状态 2 也应以厂家查单或对账确认后才入账。现有截图没有 DuitNow 独立查单接口、回调应答格式或重试规则，因此不能把回调直接当作最终结算证明。

## 余额查询

后台文档显示：

```text
GET https://api.thegspay.com/v2/integrations/operator/{auth_key}/get/balance
```

这里的路径使用单数 `operator`，与付款接口的复数 `operators` 不同，应原样保留并等待实际文档或测试环境确认。页面只说明 HTTP 200 时从 `data` 读取操作员余额，非 200 时读取 `message`；没有给出 `data` 的字段、币种、数值类型或示例。当前代码不会调用该接口，余额也不会计入会员钱包、充值统计或可用资金。

## Callback Settings 与白名单

厂家后台提供四个独立设置项：Payment Callback URL、Ewallet Callback URL、Payout Callback URL 和 Crypto Callback URL。截图中的目标路径为：

| 设置项 | 截图中的路径 | 当前处理 |
| --- | --- | --- |
| Payment | `https://master7.vip/api/payment/gspay/callback` | 厂家截图路径；门户固定返回 404，不可保存启用 |
| Ewallet / DuitNow | `https://master7.vip/api/payment/gspay/duitnow/callback` | 厂家截图路径；门户固定返回 404，不可保存启用 |
| Payout | `https://master7.vip/api/payment/gspay/payout/callback` | 提款关闭；门户固定返回 404 |
| Crypto | `https://master7.vip/api/payment/gspay/callback` | USDT 关闭；与 Payment 共用路径会造成协议冲突，不能按截图直接启用 |

设置页显示已配置一个生产 IP；具体值只保留在受控交接记录中，不提交公开仓库。页面并提示可用 `IP_1||IP_2||IP_3` 登记多个 IP。另一页“Server IP to Whitelist”列出厂家文档地址 `52.221.96.227`。两者的流量方向、所有者、是否固定及更新通知方式没有说明，不能把其中任一地址当作唯一认证。正式启用前需要厂家确认：哪个是平台对外请求的固定出口 IP，哪个是厂家回调源 IP，以及是否需要同时登记。所有回调仍必须校验 auth key、签名、订单关联、精确金额和幂等键。

回调设置页出现“Save Changes”按钮。当前内部 503 路径不能填入厂家后台，也不构成正式回调验收。只有另行设计并部署公开边界、完成证书、请求体限制、厂家认证、验签、独立查单、幂等账本、监控和回滚验收后，才应保存正式配置。

## 保持关闭的功能

- **GSPAY+ USDT / Crypto**：用户转交资料记录该产品退场；不创建新 USDT 订单，也不启用 Crypto 回调。
- **Payout / 提款**：资料显示提交提款会立即从 Settlement Balance 扣款，且厂家不核验提交的账户名。当前缺少会员提现冻结、收款账户验证、双人复核、幂等出款、查单和异常对账的完整验收，因此不实现或调用真实提款。
- **真实余额与资金操作**：不读取生产余额，不创建订单，不提交付款或提款，不根据截图直接改变会员余额。

## 正式联调前仍需确认

1. MYR 建单成功与失败的完整 JSON 示例，尤其付款 URL、payment ID、到期时间和错误码字段。
2. `auth_key` 在查询和各回调中的准确位置；认证 key 出现在 URL 路径时还要避免普通访问日志泄漏。
3. Payment 与 DuitNow 回调收到后的成功 HTTP 状态、响应正文、重试间隔与最长重试时间。
4. 所有金额字段使用 JSON 字符串还是数字，以及 MYR 最低/最高金额。
5. 厂家是否提供 UAT/沙箱、测试商户及可复现的失败和重复回调用例。
6. DuitNow 的独立查单接口及厂家返回的实际应付金额字段。
7. Callback Settings 的白名单流量方向和稳定性，以及生产出口 IP 的真实归属。

只有这些项目明确、离线及沙箱验收通过、密钥通过服务端秘密配置注入，并完成回调收件箱、独立查单、幂等钱包账本和财务对账后，才能考虑开放 GSPAY+ MYR。
