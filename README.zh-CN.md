# omp-hub

[English](README.md) | 简体中文

[omp](https://github.com/can1357/oh-my-pi) 智能体会话的无界面远程控制套件。

## 功能预览

**集中管理机器与会话。** 选择机器和 omp 配置档，启动或恢复会话，并复制完整控制或只读链接。

![Hub 首页：已连接机器、会话控制和最近历史](docs/screenshots/dashboard.png)

**在浏览器中操作实时会话。** 查看转录、展开工具运行结果，并直接发送提示词。

![实时会话：问候语演示与展开的 bash 工具结果](docs/screenshots/live-session.png)

<details>
<summary>移动端会话界面</summary>

<img src="docs/screenshots/mobile-session.png" alt="移动端会话转录、工具结果与提示词输入框" width="390">

</details>

截图来自隔离的演示机器和预先准备的示例转录；没有请求模型服务，也没有使用私人会话历史。

## 组件

| 目录 | 运行位置 | 职责 |
|---|---|---|
| `packages/hub` | 服务器或 Docker 容器 | 协作中继、机器与会话注册表、Web UI 托管、代理控制通道 |
| `packages/agent` | 每台需要受控的机器 | 无界面守护进程：接收 Hub 命令，启动 SDK 会话并通过协作通道托管 |
| `packages/web` | 构建后由 Hub 提供静态资源 | 桌面与移动端浏览器界面：机器列表、会话启停与完整的实时控制 |

代理所在机器不会打开本地 TUI/GUI。用户通过浏览器操作，也可以用真正的 omp 客户端执行
`omp join "<链接>"` 接入实时会话。

## 主要功能

- 在已连接机器上启动会话，可指定工作目录（cwd）、omp 配置档和初始提示词；查看并恢复该机器保存的会话。
- **完整的浏览器会话操作**：流式转录、工具卡片、发送提示词、中断任务、子智能体面板
  （聊天、终止、唤醒、查看转录）、宿主交互对话框（选择器、编辑器）以及停止会话。
- **omp 客户端接入**：复制会话的完整控制或只读协作链接，在终端运行 `omp join` 获得原生 TUI 体验。
- **响应式界面**：手机和桌面布局沿用上游 collab-web 的断点设计。
- **单容器 Hub**：一个端口同时提供中继、API 和 Web UI。
- **Web 斜杠命令**：在输入框键入 `/` 打开命令面板，支持 `/model`、`/thinking`、`/rewind`、
  `/settings`、`/collab`（链接）、`/theme`、`/dump`、`/leave`、`/help`。模型与思考等级的切换
  通过 Hub → 代理控制通道在宿主机执行；斜杠命令文本不会作为提示词发送给模型。
- **机器用量面板**：代理机器上的 omp 统计信息通过 Hub 代理到浏览器。

## 工作原理（30 秒）

```text
┌────────────┐   WSS /agent (token)   ┌──────────────────────────────┐
│ omp-hub-   │ ───────────────────▶  │             HUB              │
│ agent (per │                        │  relay /r/:room  (WS)        │
│ machine)   │ ◀── start {cwd} ────  │  API   /api/*    (Bearer)    │
└────────────┘                       │  web   /*        (static UI) │
      │ spawns per session           └──────────────────────────────┘
      ▼                                          ▲            ▲
┌────────────┐  collab E2E frames  ┌─────────────┴───┐   ┌────┴─────────┐
│ session-   │ ──────────────────▶ │ browser (web UI)│   │ omp join     │
│ host (SDK) │ ◀── prompt/abort ── │ guest (full     │   │ (TUI attach) │
└────────────┘                     │ write link)     │   └──────────────┘
                                   └─────────────────┘
```

- 会话内容在 session-host 与访客（浏览器或 `omp join`）之间使用 **AES-256-GCM 端到端加密**；
  Hub 中继不解密消息。不过，Hub *注册表*保存其管理的会话链接及密钥，因此 Hub 本身仍是可信方，
  部署时必须按敏感服务对待。
- 代理只主动连接 Hub，不监听入站端口，因此适用于 NAT 后面的机器。

## 快速开始（本地开发、单机）

前提：Bun ≥ 1.3.14、Rust/Cargo 和原生构建工具链、已配置可用模型提供商的 omp 凭据目录
（`~/.omp`，也可通过环境变量提供模型 API 密钥），以及兼容的 omp SDK 源码。代理通过同级目录
`../oh-my-pi` 解析 SDK 导入；它不是可独立安装的 npm 包。在 `omp-hub` 仓库根目录执行以下命令；
如果同级目录已有该仓库，请勿覆盖，应核对其版本和依赖：

```bash
git clone https://github.com/KamijoToma/oh-my-pi.git ../oh-my-pi
git -C ../oh-my-pi checkout 7ae76f8e4daca0c8f409f61bcd514260cd522365
bun --cwd=../oh-my-pi install --frozen-lockfile
bun --cwd=../oh-my-pi run build:native
mkdir -p /tmp/omp-hub-demo
```

以上 SDK 修订版是本项目本地验证时使用的版本。源码映射及部署约束参见
[代理说明（英文）](packages/agent/README.md)。

```bash
# 1. 启动 Hub 演示模式：安装锁定版本的 Web 依赖、构建 UI，并在 :8080 提供中继、API 和页面
cd packages/hub
HOST=127.0.0.1 HUB_TOKEN=dev-token bun run demo

# 2. 在另一个终端从本仓库根目录启动代理
cd packages/agent
HUB_TOKEN=dev-token bun run dev -- --hub ws://127.0.0.1:8080 --name dev-machine
```

在浏览器打开 `http://127.0.0.1:8080`，输入仅用于本机开发的令牌 `dev-token`，选择
`dev-machine`，以 `cwd=/tmp/omp-hub-demo` 启动会话。若要从终端加入，在会话页面复制**完整控制**
协作链接，再运行 `omp join "<在此粘贴完整链接>"`。完整链接具有会话写入权限，必须保密。

分别进入 `packages/web`、`packages/hub`、`packages/agent` 执行
`bun install --frozen-lockfile && bun run typecheck` 进行类型检查；代理的类型检查需要同级
`oh-my-pi` 源码及其已安装的依赖。在 `packages/web` 执行 `bun run build` 可仅重建静态 UI，
不启动 Hub。

## Docker（仅 Hub）

本地部署时，把容器端口仅映射到宿主机的回环地址：

```bash
docker build -f docker/Dockerfile -t omp-hub .
export HUB_TOKEN="$(openssl rand -hex 32)"
docker run --rm -p 127.0.0.1:8080:8080 -e HUB_TOKEN="$HUB_TOKEN" omp-hub
```

也可以使用 `docker compose -f docker/docker-compose.yml up --build`；它同样读取已导出的
`HUB_TOKEN`。代理需要访问受控机器的本地文件系统、Shell 和 omp 凭据，因此必须直接在受控机器
上运行，不包含在此 Hub 镜像中。

浏览器或代理从远端访问时必须使用 **HTTPS/WSS**：可通过 `HUB_TLS_CERT` 和 `HUB_TLS_KEY`
让 Hub 自行终止 TLS，或在反向代理终止 TLS 并设置 `HUB_PUBLIC_URL=https://...`。
浏览器的 WebCrypto 需要安全上下文，非本机的 `ws://` 协作链接也会被拒绝。
若需让 Hub 直接监听非回环地址，应显式设置 `HOST=0.0.0.0` 并置于防火墙之后；Docker 镜像
在容器内部监听所有地址，但上面的示例只在宿主机回环地址发布端口。挂载 TLS 证书时，须保证
镜像内的非 root 用户能够读取证书文件。详情见
[局域网与 TLS 约束（英文）](docs/architecture.md#tls--lan-notes-hard-constraints-from-upstream)。

## 安全模型与限制

`HUB_TOKEN` 是代理通道和 HTTP API 共用的 Bearer 凭据；未设置或为空时 Hub 会拒绝启动。
浏览器在本地存储该令牌。任何持有令牌的用户都可获得会话的完整写入链接；Hub 注册表也保存
所有会话链接及密钥。会话宿主在无界面自动批准模式下运行 omp 工具，能够访问代理机器的文件
和模型凭据。令牌持有者还能查看机器上跨项目的近期 omp 会话历史（包括路径、标题和首条消息摘要）
并恢复保存的会话。若私人历史需要隔离，请用独立的系统账户运行代理。

`/r/` 中继无需令牌，也没有房间数量限制或宿主身份校验：持有只读链接的人可能在宿主断线后
抢占宿主位置。**这不是面向不可信用户的多租户或公网服务**；只允许可信用户和网络访问，
不要公开令牌或会话链接。Hub 状态只保存在内存中；重启 Hub 会丢失实时房间。详情见
[安全模型（英文）](docs/architecture.md#security-model-mvp)。

## 文档

- [架构（英文）](docs/architecture.md)：组件、部署拓扑、安全模型和设计取舍。
- [协议（英文）](docs/protocol.md)：代理与 Hub 的控制协议、HTTP API 和中继约定。
- [里程碑（英文）](docs/milestones.md)：MVP 阶段与后续计划。
- [端到端验证记录（英文）](docs/e2e.md)：人工验证步骤和已知限制。

GitHub Actions 会按锁文件安装三个包的依赖，运行类型检查和测试，构建 Web UI 与容器镜像，
并固定代理使用的外部 SDK 修订版。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。Web 客户端包含源自
[`@oh-my-pi/collab-web`](https://github.com/can1357/oh-my-pi) 的代码（MIT）；原作者的版权声明
和授权文本保留在 `LICENSE`。构建进 Web UI 的第三方库仍适用其各自的许可证（包括 Lucide 的
ISC／Feather 声明和 Marked 的 Markdown 声明）；Hub 的 Docker 镜像在 `/app/licenses/` 中附带
完整的第三方授权文本。
