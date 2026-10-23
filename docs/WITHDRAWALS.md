# 人工提现与财务审核

本模块提供会员提现申请、余额冻结、财务审核、人工付款登记、钱包扣账与 CSV。它默认关闭，不调用 VPay、GSPAY+ 或银行接口，也不会自动出款。

## 流程

1. 会员读取 `GET /api/v1/withdrawals/config`，查看正式环境的已入账余额、冻结金额和可用余额。
2. `PORTAL_WITHDRAWALS_ENABLED=true` 时，会员可向 `POST /api/v1/withdrawals` 提交 MYR 金额、银行、户口名字、户口号码和独立请求标识。
3. 服务在同一事务内锁定会员、重验账号与租户、检查可用余额，并写入 `pending_review` 申请及 `active` 冻结。并发申请不能超过可用余额。
4. 总部、租户老板或获单独授权的财务员工在后台开始处理，状态变为 `processing`。该动作不连接银行，也不代表已付款。
5. 财务在受控银行后台完成人工付款后，填写唯一银行参考号并标记 `paid`。同一事务把冻结改为 `consumed`，写入唯一负数钱包账本，并保留财务动作与审计记录。
6. `pending_review` 可拒绝；`processing` 可标记失败。两者都把冻结改为 `released`，不会扣钱包。每个动作有独立幂等键，重复请求不会重复扣账。

新申请开关关闭后，既有申请仍可查看、拒绝、标记失败或在完成银行核对后登记已付款，避免遗留冻结无法处理。任何真实付款都必须由有权限的财务人员在银行端另行完成；平台不收集银行登录密码、OTP 或 Authenticator 动态码。

## 数据与权限

- `0008_manual_withdrawals.sql` 分开保存申请、余额冻结、负数提现账本及财务动作。
- PostgreSQL 表位于私有 schema，启用 RLS，并撤销公开及浏览器角色的直接访问。
- 会员只读本人记录；总部和租户老板只管理已选择租户；财务员工须先获明确授权。
- `GET /api/v1/wallet` 保留兼容字段 `balanceMinor`，并返回 `postedBalanceMinor`、`heldMinor`、`availableMinor`。正式余额为已核验充值减已付款提现；可用余额再减活动冻结。
- 今日提现金额按 `Asia/Kuching` 当日的 `paid_at` 计算；申请、开始处理或失败不会计入已付款总额。
- 导出最多 10000 条，并对可能触发表格公式的字段加保护；导出本身留下审计。
- 银行资料会出现在受权限控制的财务页面和导出中，因此只能由实际业务所需人员访问。

## 配置与验证

唯一开关为 `PORTAL_WITHDRAWALS_ENABLED`，只有字面值 `true` 才接受新申请。没有自动出款、供应商 Payout 或银行 API 开关。

```sh
npm run test:withdrawals
npm run test:wallet
npm run test:bank-deposits
npm run test:migrations
```

所有测试使用临时 SQLite／PGlite 与合成数据，不发送厂家或银行请求，不处理真实资金。上线前还需确定财务负责人、银行操作复核、每日对账、异常升级和备份恢复流程。
