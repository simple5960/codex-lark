# simple's codex · Lark ↔ Codex

通过 Lark 私聊或群聊驱动本机 Codex 执行任务，使用 Lark 官方 Node SDK 的 WebSocket 长连接、Codex 官方 TypeScript SDK 和 AWS Secrets Manager。不需要公网服务器或 HTTP 回调。

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
   群聊另需添加 `im:message.group_at_msg:readonly`（接收 @机器人的群消息）。如果希望群里无需 @ 就能直接下任务，申请 `im:message.group_msg`（获取群组中所有消息，敏感权限），审批发布后生效。机器人必须已加入对应群。
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
| 普通文本 | 群聊持续使用本群上下文，忙时顺序排队；私聊空闲时续聊、忙时创建独立任务 |
| `/task 描述` | 显式创建独立任务，可连续提交多条 |
| `/tasks` | 查看本群的最近任务及 ID；私聊查看自己的任务 |
| `/continue 任务ID 描述` | 继续指定任务，复用其目录与 Codex 线程 |
| `/result 任务ID` | 查看任务的最近结果 |
| `/whoami` | 查询 Lark open_id，无需事先授权 |
| `/help` | 命令说明 |
| `/status [任务ID]` | 查看任务列表或指定任务状态 |
| `/new [描述]` | 切换新会话；附带描述时立即创建新任务，不取消现有任务 |
| `/cancel [任务ID]` | 取消自己正在执行或排队的任务；多任务时需指定 ID |
| `/login` | 查看本机 ChatGPT 登录说明 |

### 用群区分上下文

新建不同的 Lark 群并分别拉入机器人，直接发需求即可，无需 `/session`。群 A、群 B 各自保留 Codex 线程、工作目录和文件修改，可以同时执行。每个群的新消息形成一个新的任务记录和进度卡片，自动衔接上一轮上下文；同群执行期间收到的新消息依次排队，待上一轮完成后复用最新线程和目录。回复旧卡片仍延续本群当前上下文。`/new` 可显式重开本群上下文，`/task 描述` 可显式新建独立上下文，同群仍顺序执行。

多个授权用户用逗号分隔。空白白名单禁止执行任务。只处理授权真人的文本消息，忽略机器人消息和附件。**同群的授权成员共享上下文，也能查询、续聊和取消本群任务；结果会发到群内，所有群成员都可能看到。** 未授权成员不能操作；不同群和私聊相互隔离，私聊仍按发送者隔离。群里只有 @消息权限时，每条请求（含命令）都需 @机器人；只有实际推送到服务的消息会进入上下文，不会自动读取历史群聊。正文开头的结构化 @提及会被去除。

默认同时运行 2 个任务，额外最多排队 20 个；队列满时明确拒绝，取消或完成后自动补位。`MAX_PARALLEL_TASKS` 可设为 1–8，`MAX_QUEUED_TASKS` 可设为 0–100。当前 AWS m7i.xlarge（4 vCPU / 16 GiB）部署设为 4 个并发名额；仓库默认仍为 2。提高并发需评估 CPU、内存和 ChatGPT 额度。`TASK_TIMEOUT_MS` 默认 30 分钟，从任务开始执行时计时，不包括排队。消息 ID 持久化去重一天。

每个新任务使用独立 Git worktree 和 `codex/task-txxxxxxxx` 分支。`CODEX_WORKSPACE` 必须指向已有提交的 Git 仓库根目录。新任务基于该仓库的已提交 HEAD 创建，不会复制原目录里的未提交或未跟踪文件，也不会自动复制 node_modules、密钥或环境配置。需要依赖的项目应在各自目录安装/准备依赖；任务仍受当前网络沙箱限制。目录默认保存在 [.data/worktrees/](./.data/worktrees/)，可以通过 `TASK_WORKTREE_ROOT` 更改。

任务卡片会显示 ID、分支及目录，修改保留在对应 worktree，不自动合并回主目录。需要合并时应先检查并提交该任务分支上的修改，再按正常 Git 流程 merge/cherry-pick。完成、取消和失败都不会自动删除目录。已有旧版本会话会复用原工作目录和线程，保留原有未提交修改；同一个目录或任务不会被同时执行两次。

## 执行与凭据边界

默认 `workspace-write` 沙箱，禁用任务网络访问，超出沙箱的操作直接失败。可以设置 `CODEX_SANDBOX=read-only`。服务没有聊天端提权命令；执行审批策略是 `never`，不会卡在无人可见的审批提示。SDK 执行时只把必要环境变量传给子进程，不传 AWS/Lark 凭据或 API key。但这不是操作系统级的凭据隔离：Codex 仍可能读取当前系统用户能访问的文件，部署给多人使用时应使用专门系统账号与工作目录。

[.env.prod](./.env.prod)、[.data/](./.data/) 和日志均被 Git 忽略。AWS Secret 只读入服务内存；不记录原始 SDK 错误对象、消息正文或命令输出。任务结果会作为机器人回复发送至 Lark，Codex 自身仍会按本机配置保存历史。ChatGPT 登录缓存由 Codex 管理，切勿上传认证缓存。

状态保存在 [.data/state.json](./.data/state.json)，包含任务提示词、最近结果、目录、线程与消息绑定。一个状态目录只允许运行一个服务实例。正常退出会中止正在执行的任务并保存排队任务；下次启动恢复排队任务，已中断的任务不会自动重跑，可用 `/continue` 继续。若机器崩溃留下锁，确认进程已停止后删除 [.data/state.json.lock](./.data/state.json.lock)。不同机器或不同状态目录无法共享任务调度，不要同时使用相同的工作目录和 worktree 根目录。

去重在执行前落盘，防止重复修改文件。如果进程中途崩溃，旧消息不会自动重新执行；确认文件现状后发送新消息继续。会话重开只切换上下文，不回滚文件。

## 开发验证

```sh
npm test
npm run typecheck
npm run build
```

测试覆盖权限拒绝、群聊隔离与共享上下文、同群排队、四群并行、重启续聊、去重、真实 worktree 同文件并行写入、调度限额与排队、指定任务续聊/取消、重启恢复、旧会话迁移、超时、进度卡片、Secret 校验和中文长消息切分。真实 Lark 端到端验证需要发布应用、配置事件权限并发送一条私聊消息。

官方文档：[Codex SDK](https://developers.openai.com/codex/sdk/)、[Codex ChatGPT 登录](https://developers.openai.com/codex/auth/)、[Lark Node SDK](https://github.com/larksuite/node-sdk)。
