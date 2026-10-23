# VPay 接入准备

依据 [Trader API Integration Documentation](https://gateway.vpay.club/api/doc/trader_en)，公开正文读取于 2026-10-23。页面未列明确协议版本。以下是离线代码与测试范围，不是供应商认证、云端部署或充值到账证明。

`standalone/vpay-contract.mjs` 不读取密钥、不导入数据库、不发出网络请求，尚未注册到服务端路由。现有充值通道继续禁用，Deposit 申请仍只有 `awaiting_connection` 状态。

## 已实现

- `normalizeVPayMYR`：只接受正数十进制字符串，使用整数分，输出固定两位小数；不接受浮点、指数、千位分隔、负数或超过两位的小数。限制符合当前建单文档的 10 字符金额上限，不代表商户渠道限额。
- `createUnsignedVPayOrder`：校验 `TRADER_ORDER` 的字段，要求服务端提供商户 `traderId`、已确认开通的 `enabledTradeCodes`、通知来源及返回来源；输入商户与服务端配置不同会被拒绝，不因为文档列出某通道就默认开通。通知 URL 必须是匹配来源的 HTTPS 地址且不含查询参数。文本采用保守的 UTF-8 字节长度上限，订单号限定为应用生成的 ASCII 字母、数字、下划线及连字符。
- `inspectVPayCreateResult`：核对商户、内部订单和金额；付款链接只允许已登记的 `https://payment.vpay.club` 来源，拒绝没有订单路径或查询参数的收银台首页，不跟随跳转。到期时间保留供应商原文，不推断时区。`code=0` 仅报告供应商声称建单成功。
- `inspectVPayQueryResult`、`inspectVPayNotification`：核对已保存的外部订单、内部订单和精确金额。通知另要求商户一致及签名字段存在；**签名存在并非验签成功**。查单表没有商户字段时记录 `merchantReturned:false`。通知状态 5 作为风控中，查单未记载的状态仍为未知。

所有解析结果都固定 `authenticated:false`、`environmentVerified:false`、`fundsProcessed:false`、`settlementStatus:verification_required`。供应商返回“已付款”不改变这些限制；模块不会返回 `SUCCESS`、修改钱包或发起任何交易。输入原文不被修改；投影后的输出不能替代将来对原始全部扩展字段的验签。原始输入、未签名草稿及解析结果仍应留在受控服务端，不能写入普通日志；尤其 `payUrl` 保留完整查询参数，可能含付款会话令牌，不能当成脱敏诊断输出。今后只向有权访问该订单的会员交付付款链接。

`npm run test:payments` 运行既有只读状态测试和本模块的合成离线测试，不使用真实账号或调用供应商。

## 尚未实现及确认项

签名和网络传输尚未实现。官方签名说明的 `ToLocalTime` 没有指定时区，通知时间来源及有效窗口、空值与零值、特殊字符编码需要供应商确认及可复现测试向量；演示 sign 不是测试向量。未签名草稿的金额格式尚需按测试向量验证，不能直接投入交易。官方签名编码可能包含 API token，sign 与密钥都不得进入前端、普通日志或错误输出。

`ORDER_GET` 参数表不列 `trade_no`，示例却携带，暂不生成查单请求以免猜定契约。需要确认状态 5 的查单规则、超时查单及重试限制。

真实联调还需要核定商户对应的密钥、环境、开通渠道和限额，安全注入密钥，完成机器认证、回调来源核查、持久化收件箱、幂等订单、资金账本、到账核验及对账。只有完成可靠接收或事务处理的可信事件，才能按协议回应纯文本大写 `SUCCESS`。银行收款公告不能证明登录商户身份，手机号或验证器绑定也不等于支付接口已经接通。
