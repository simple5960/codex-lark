# simple's codex · Lark ↔ Codex

通过 Lark 私聊驱动本机 Codex 执行任务，使用 Lark 官方 Node SDK 的 WebSocket 长连接、Codex 官方 TypeScript SDK 和 AWS Secrets Manager。不需要公网服务器或 HTTP 回调。

AWS 常驻部署、机器登录和服务管理见 [部署说明](./deploy/README.md)。

## 安装与配置

需要 Node.js >= 22.18、AWS 凭据，以及有 Codex 使用权限的 ChatGPT 账号。

```sh
npm ci
cp .env.example .env.prod
npm run login
```

`npm run login` 启动 Codex 官方浏览器登录。已有 Codex ChatGPT 登录可直接复用。无浏览器的机器可运行 `npm run login:device`，按终端提示在浏览器完成验证；需要账号或工作区启用设备码登录。登录属于服务运行机器上的 Codex，Lark 用户共用该账号的额度；不会给每个 Lark 用户创建独立的 ChatGPT 登录。

修改 [.env.prod](./.env.prod)：

```dotenv
AWS_REGION=us-west-2
AWS_SECRET_ID=simple-codex
LARK_DOMAIN=lark
ALLOWED_OPEN_IDS=ou_你的ID
CODEX_WORKSPACE=/absolute/path/to/your/project
CODEX_SANDBOX=workspace-write
```

Secret 必须是 JSON，包含 `simple-codex-app-id` 和 `simple-codex-app-secret`。服务使用 AWS SDK 默认凭据链，支持本地 AWS 登录、环境变量、`AWS_PROFILE` 或 IAM role。角色需要对该 Secret 的 `secretsmanager:GetSecretValue`，使用客户管理 KMS 密钥时还需对应的 `kms:Decrypt`。不要把密钥复制到项目配置。

## Lark 应用后台

在 [Lark 开发者后台](https://open.larksuite.com/app) 打开 **simple's codex**：

1. 启用应用的「机器人」能力。
2. 在「权限管理」添加 `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息）和 `im:message:send_as_bot`（以应用身份发送消息）。
3. 在「事件与回调」选择「使用长连接接收事件」，订阅 `im.message.receive_v1`。
4. 创建并发布版本，将自己加入应用可用范围；如组织要求审批，等待审批后生效。
5. 本机运行 `npm start` 建立连接。首次配置时可先启动连接，再保存后台长连接设置。
6. 在 Lark 中找到机器人并发送 `/whoami`，把返回的 `ou_...` 填入 `ALLOWED_OPEN_IDS`，重启服务。

如果应用实际在中国版飞书后台创建，设置 `LARK_DOMAIN=feishu` 并使用 [飞书开发者后台](https://open.feishu.cn/app)。两套平台的凭据不可混用。

## 使用

```sh
npm run doctor       # 检查 AWS Secret、Lark 应用和 Codex 登录，不显示密钥
npm start            # 前台启动；保持此进程和机器在线
```

在 Lark 私聊发送「检查这个项目的测试失败原因并修复」，机器人创建一张 JSON 2.0 Markdown 任务卡片，后台执行时持续更新同一条消息。卡片展示当前步骤、任务计划、命令的近期输出、阶段性回复和耗时；进度更新合并并限速为最多每 2 秒一次，没有新事件时每分钟刷新耗时。完成、失败、超时或取消均写回原卡片。

进度来自 Codex SDK 实际提供的事件，不保证每个工具都有逐字输出。只展示最近的有限输出，不展示 reasoning 项。最终结果通常保存在同一张卡片；超过卡片容量时，主卡片保留首段并追加补充卡片，避免丢失结果。若最终更新失败，另外发送完整结果；普通命令回复的卡片被明确拒绝时仍可回退纯文本。更新接口使用应用自己发送的共享卡片（`update_multi: true`）。

| 消息 | 功能 |
| --- | --- |
| 普通文本 | 创建任务或继续当前 Codex 会话 |
| `/whoami` | 查询 Lark open_id，无需事先授权 |
| `/help` | 命令说明 |
| `/status` | 当前会话任务状态及工作目录 |
| `/new` | 清除当前会话绑定，下次消息创建新线程 |
| `/cancel` | 中止自己的任务，保留已产生的文件修改 |
| `/login` | 查看本机 ChatGPT 登录说明 |

多个授权用户用逗号分隔。空白白名单禁止执行任务。只处理真人私聊的文本消息，忽略群聊、机器人消息和附件。会话按工作目录、聊天、发送者隔离，重启后可续聊。同一服务一次执行一个任务；忙时拒绝新任务，不静默排队。消息 ID 持久化去重一天；任务最长默认 30 分钟，可设置 `TASK_TIMEOUT_MS`。

## 执行与凭据边界

默认 `workspace-write` 沙箱，禁用任务网络访问，超出沙箱的操作直接失败。可以设置 `CODEX_SANDBOX=read-only`。服务没有聊天端提权命令；执行审批策略是 `never`，不会卡在无人可见的审批提示。SDK 执行时只把必要环境变量传给子进程，不传 AWS/Lark 凭据或 API key。但这不是操作系统级的凭据隔离：Codex 仍可能读取当前系统用户能访问的文件，部署给多人使用时应使用专门系统账号与工作目录。

[.env.prod](./.env.prod)、[.data/](./.data/) 和日志均被 Git 忽略。AWS Secret 只读入服务内存；不记录原始 SDK 错误对象、消息正文或命令输出。任务结果会作为机器人回复发送至 Lark，Codex 自身仍会按本机配置保存历史。ChatGPT 登录缓存由 Codex 管理，切勿上传认证缓存。

状态保存在 [.data/state.json](./.data/state.json)。一个状态目录只允许运行一个服务实例。正常 Ctrl+C 会取消任务、断开连接并释放锁。若机器崩溃留下锁，确认进程已停止后删除 [.data/state.json.lock](./.data/state.json.lock)。不同机器或不同状态目录无法共享互斥锁，不要同时驱动相同工作目录。

去重在执行前落盘，防止重复修改文件。如果进程中途崩溃，旧消息不会自动重新执行；确认文件现状后发送新消息继续。会话重开只切换上下文，不回滚文件。

## 开发验证

```sh
npm test
npm run typecheck
npm run build
```

测试覆盖权限拒绝、私聊过滤、去重、重启状态、续聊、并发互斥、取消、超时、Secret 校验、环境变量隔离和中文长消息切分。真实 Lark 端到端验证需要发布应用、配置事件权限并发送一条私聊消息。

官方文档：[Codex SDK](https://developers.openai.com/codex/sdk/)、[Codex ChatGPT 登录](https://developers.openai.com/codex/auth/)、[Lark Node SDK](https://github.com/larksuite/node-sdk)。
