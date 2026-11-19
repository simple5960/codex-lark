# AWS 常驻部署

`bootstrap.sh` 用于专用 Ubuntu 22.04 EC2 实例的 user-data，会安装 Node.js、依赖、全局 Codex CLI（0.170.0） 和 `codex-lark` systemd 服务。应用安装在 `/opt/codex-lark`，任务工作目录为 `/srv/codex/workspace`，ChatGPT 登录保存在专用 `codex` 用户的 home 中。脚本是首次安装用，不应在已有业务机器上重复运行。

## 已部署实例

- 区域：`us-west-2`
- 实例：`i-058d25437e4b5a9bd`（`simple-codex-lark`）
- 类型：`m7i.xlarge`（4 vCPU / 16 GiB），20 GiB 加密 gp3 系统盘，2 GiB swap
- IAM Role：`simple-codex-ec2`，包含 Session Manager 权限及仅针对 `simple-codex` 的 Secret 读取权限
- 安全组：仅出站，无入站规则；通过 AWS Session Manager 登录

实例、磁盘和公网 IPv4 会按 AWS 价格计费。未创建域名、负载均衡器、弹性 IP 或公网 HTTP 服务。

## 登录 ChatGPT

打开 [EC2 连接页面](https://us-west-2.console.aws.amazon.com/ec2/home?region=us-west-2#ConnectToInstance:instanceId=i-058d25437e4b5a9bd)，选择 **Session Manager → Connect**。需要先登录有权限的 AWS 账号。进入终端后执行：

```sh
sudo -u codex -H bash -lc 'cd /opt/codex-lark && npm run login:device'
```

保持终端命令运行，在浏览器打开终端显示的 OpenAI 地址，输入一次性验证码，用你自己的 ChatGPT 账号完成授权。设备码登录需要在个人账号安全设置或工作区权限中启用。不要把密码、验证码或登录缓存提交到 Git。

完成后检查并重启：

```sh
sudo -u codex -H bash -lc 'cd /opt/codex-lark && npm run login:status'
sudo systemctl restart codex-lark
sudo systemctl status codex-lark --no-pager
```

机器上的服务使用机器自己的 ChatGPT 登录，不会复制 Mac 上的登录缓存。

## 运维

```sh
# 查看服务日志
sudo journalctl -u codex-lark -n 50 --no-pager
# 停止/启动服务
sudo systemctl stop codex-lark
sudo systemctl start codex-lark
# 检查 AWS Secret、应用和 ChatGPT 登录
sudo -u codex -H bash -lc 'cd /opt/codex-lark && npm run doctor'
```

服务崩溃后 systemd 会自动重启；启动前清理本服务遗留的锁。只能由这个 systemd 单元启动，不要再手动启动第二份 `npm start`。Mac 上的同一机器人服务也应停止，避免 Lark 在多个连接间分发任务。

应用配置位于 `/opt/codex-lark/.env.prod`，该文件不包含 Lark Secret，只包含区域、Secret 名称、白名单和工作目录。修改后重启服务。登录缓存与 Codex 历史在 `/home/codex/.codex`；服务会话状态在 `/opt/codex-lark/.data`；项目修改在 `/srv/codex/workspace`。这些目录依赖系统盘持久化；终止实例会删除系统盘，重要代码应提交到 Git，并自行建立备份策略。

当前部署使用 `MAX_PARALLEL_TASKS=4`、`MAX_QUEUED_TASKS=20`（代码默认并发为 2），升级时旧配置无需新增字段即可使用默认值。新任务的修改位于 `/opt/codex-lark/.data/worktrees/<任务ID>` 的独立分支；`/srv/codex/workspace` 作为新任务的已提交基线，同时保留旧会话的修改。更新服务代码不要覆盖、重置或删除这些任务目录。服务重启后恢复排队任务，运行中的任务标记中断，需要用户显式续聊。

参考：[AWS Session Manager 登录](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-with-systems-manager-session-manager.html)、[Codex 设备码登录](https://developers.openai.com/codex/auth/)。

群聊按 chat_id 共享上下文，同群顺序执行、不同群并行。后台需发布群消息读取权限，再将机器人加入群；只开 @权限时每条请求需 @机器人，免 @需 `im:message.group_msg` 权限。

## 全局 CLI 与扩展管理

机器人使用 `/usr/local/bin/codex`，在应用配置中设置 `CODEX_EXECUTABLE=/usr/local/bin/codex`；项目依赖不包含 Codex CLI 或 SDK。所有系统用户可运行全局程序，用户配置不自动共享。要与机器人共用登录、MCP、插件和用户级 Skill：

```sh
sudo -u codex -H bash
cd /srv/codex/workspace
codex
```

更新程序使用管理员终端执行 `sudo npm install -g @openai/codex@版本号`，先验证非交互执行、JSONL 和续聊兼容性，再重启服务。不要复制认证缓存或把配置目录改成所有用户可写。运行 `npm run doctor` 会验证实际配置的全局可执行文件和登录状态。
