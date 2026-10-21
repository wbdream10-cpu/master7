# White-label Platform

全新的普通服务平台：客户前台、老板后台、独立账号密码、Logo 设置、公告、服务申请、账号审批、操作记录、通用签名事件接收接口。默认没有照片、客户资料、公告、申请、连接配置或事件。只有部署负责人创建的老板账号可以管理平台。

## 安装与验证

需要 Node.js 24.19.0 或更高版本。

```sh
npm ci --include=dev
npm run build
npm test
```

源码不依赖 ChatGPT 登录或 Sites 运行环境。数据库迁移只创建表，不导入任何旧数据。测试使用临时数据库，结束后删除测试数据。

## Render

仓库根目录的 `render.yaml` 定义新服务 `ahbi-service-portal`，新加坡、0.5 CPU/512 MB、1 GB 持久磁盘，数据库 `/var/data/portal.sqlite`。基本费用采用用户已批准的约 US$7.25/月预算；实际以 Render 显示为准。禁止将生产数据库放在临时磁盘。

在 ahbi 工作区导入该 Blueprint，先检查配置和费用再部署。结构验证通过不代表部署成功。初始没有老板默认密码，必须在服务的受信任 Shell 中亲自创建老板账号。不可直接把数据库、密码或恢复码提交到 GitHub。

```sh
read -rs -p '老板密码：' portal_password
printf '%s' "$portal_password" | node standalone/admin.mjs create-owner boss owner@example.com
unset portal_password
```

把示例邮箱替换为自己的邮箱。此命令从标准输入读取密码，只显示一次恢复码。密码至少 12 个字符；自行离线保存恢复码。已有老板时命令拒绝覆盖。

## 入口

| 路径 | 用途 |
|---|---|
| `/` | 客户前台，需登录 |
| `/admin` | 老板后台，需老板权限 |
| `/accounts` | 老板审批或暂停客户账号 |
| `/connections` | 老板配置通用回调接收通道 |
| `/signin`、`/register`、`/reset` | 登录、申请注册、恢复码重设密码 |
| `/health` | 进程健康检查 |

客户注册后需老板核实并批准。邮箱没有自动验证，不应仅根据填写的邮箱批准账号。只有一个全局老板管理品牌工作空间；没有员工角色或每个租户独立老板。自定义外观只提供 Logo 入口。

## 接手人员

阅读 [通用接口说明](docs/INTEGRATION.md)。事件接收采用独立密钥、签名、时间窗口、重复事件校验，并存储到配置所属工作空间；默认未配置任何外部服务。`202 accepted` 只表示接收，`processed:false` 明确表示尚未处理，不会产生任何资金、余额或业务状态变化。

## 备份

```sh
node standalone/admin.mjs backup /var/data/portal-backup.sqlite
```

目标必须不存在。备份含敏感账号信息，需私密保存并下载至受控备份位置；同一磁盘内的副本不能替代异地备份。恢复前停止服务、备份当前文件，经审核后恢复快照，并撤销旧会话。

## 交付状态与范围

本仓库提供可运行源码与部署配置；GitHub 上传不代表已在 Render 上线。正式服务部署、生产老板开户、正式域名、手机与多用户运行、备份恢复仍需实机验收。没有旧站数据迁移、照片、外部供应商适配、实际收付款、余额、Deposit 订单或短信/邮件 OTP。通用回调不会冒充任何供应商协议。真实接入由接手人员另行实现并测试。
