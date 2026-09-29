# RFC: Superagent 仓库检查能力与会话消息来源

状态：**讨论记录，暂缓实施**。本文保存方案、反对理由与验证结果；不是已经批准的协议，也不要求立即修改 Hub、Agent、Web 或上游 SDK。两个议题可以分别实施。

## 背景与现状

- Superagent 会话通过 `packages/agent/src/session-host.ts` 的 `toolNames`、`restrictToolNames`、`allowRestrictedCustomTools` 只暴露 `fleet_*` 工具；daemon 的 `fleet-proxy.ts` 只转发 `/api/fleet/*`。Hub 从受监督子会话确定 owner，按 namespace 和控制权授权。
- 现有 `fleet_start_session`、`fleet_watch_session`、`fleet_message_session`、消息读取与事件收件箱已经能启动、指挥、观察 worker。Worker 默认拥有完整的本机工具，且与 superagent 运行在相同机器账户下。Namespace 只是 Hub 控制面边界，不是文件系统或进程沙箱。因此，禁止 superagent *直接*调用 shell 是防误操作的护栏，不能阻止它让有权限的 worker 间接执行 shell。
- 网页访客提示通过加密 collab 的 `prompt` 帧进入 host；历史中的 `collab-prompt` 有 `details.from`。Fleet 的 `message` 则通过 Hub 命令进入 `session-host.ts`，直接调用 SDK 的 `session.prompt`、`steer` 或 `followUp`，只传文本和模式，不把已验证的 superagent 身份写进产生的 `role: "user"` 消息。`Transcript.tsx` 对这种普通用户消息显示相同气泡；当前 `controllerId` 会变，不能用于推断旧消息作者。

## 议题一：Git 检查与委派权限

### 讨论过的选择

| 选择 | 收益 | 结论 / 风险 |
|---|---|---|
| 保持现有 fleet 工具，让 worker 检查 Git 并汇报 | 立即可用，不新增 superagent 权限 | 可作为当前流程；多一次模型交互和等待 |
| 给 superagent 通用只读文件或“受限 shell” | 自行检查仓库更快 | 任意路径、Git 配置及进程环境会扩大直接权限；仅限制工具名称不构成 OS 隔离 |
| 直接开放 SDK 原生 `task` | 子代理编排看似方便 | **不建议**：SDK 默认 task 子代理未指定 `toolNames`，子会话仅继承 `restrictToolNames` 不会继承父会话那组 `fleet_*` 名称；未指定名称时 SDK 会启用默认注册的内建工具。子任务也不会自动成为 Hub 可授权、可停止、可观察的 namespace worker |
| 专用只读 `fleet_git_status` | 低成本获取可信仓库状态，保留 fleet 授权 | **优先研究的方向**；接口、允许访问的仓库范围及审批规则尚未定稿 |

`fleet_git_status` 的拟议边界：绑定已在 namespace 内的会话及其机器/工作目录（若要在创建会话前检查，另需显式的机器/仓库 allowlist），由 daemon 在该机器执行固定 Git argv，而不是接受 shell 字符串或任意 `git` 子命令；返回分支、HEAD、工作区脏路径和合并冲突摘要。限制超时、输出字节数、路径/符号链接范围；避免可选写锁并禁用可执行的 fsmonitor 等配置。Git 状态输出仍可能暴露文件名，不能将它视为公开信息。

Git merge、切分支和部署属于**修改性**操作，不包括在状态读取接口内；尤其合并 `prod` 会触发自动部署，应另行约束及审批。若需要批量任务/DAG，应在 Hub 的 fleet worker 生命周期之上编排，而非把 SDK 原生 `task` 直接授予 superagent。若安全目标是抵御恶意 superagent 指挥 worker 读写本机，需要给 **worker** 配置独立 OS 身份、工作目录或沙箱；单独收窄 superagent 工具不能实现该目标。

## 议题二：区分人类与 superagent 消息

### 所需语义

- 保持发送给 worker 模型的 `role: "user"`：superagent 是委派指令的**来源**，不是提升为 system/developer 角色。来源字段必须与 SDK 的 `message.attribution` 分离。
- 拟议的可选字段示意：`message.origin = { kind: "fleet", operatorSessionId, operationId, mode }`。`mode` 至少覆盖 start、steer、follow_up；由 superagent 发起的新 worker 初始提示和 interrupt 后的替代提示也必须有来源，是否增加 `initial`/`replacement` 模式尚待确定。字段形状及是否保存当时的展示名称也未定稿。
- Hub 依据受认证的 owner 设置来源，不能让模型自报身份。历史归属按**发送时**记录，不能按显示时的 `controllerId` 回填。操作 ID 应与被实际排队/持久化的那条消息关联；投递失败不应产生一条假消息。
- Web 会话页及只读访客视图显示轻量“Superagent · 名称/ID”标签及温和的视觉区分，保持正文和普通用户提示的结构；没有来源字段的旧消息不猜测作者。`fleet_get_messages` 也应投影该字段，否则 superagent 读取 worker 历史仍无法区别来源。原始 JSONL 字段只用于展示与诊断，**不是不可伪造的审计记录或权限依据**：本机账户可以编辑会话文件。

### 不改 SDK 的备选方案及限制

- SDK 的 `attribution: "user" | "agent"` 表示发起/计费类别，**不包含具体发送者**。把 fleet 消息改成 `"agent"` 不只是上色：SDK 部分排队准备逻辑会区分它，Copilot 的 `X-Initiator` 与本地 premium-request 计算、Anthropic 的 conversational-user 标记也会受影响。因此不为 UI 样式改此字段。
- `sendCustomMessage({ customType, details })` 可以无 SDK 修改地持久化准确身份，但若用它**替代** `prompt/steer/followUp`，历史角色成为 `custom_message`，提示处理、搜索、回溯、排队和标题生成语义不再等价。另存 sidecar 元数据也不可靠：当前 API 返回的 operationId 不会与 SDK 最终写入的 user entry id 绑定；并发人工提示、重复文本及排队重排都可能错配。文本前缀可伪造并污染模型输入。
- 若要求“同一条普通 `role:user` 消息保留原语义且携带准确 owner”，需扩展 SDK 提交、排队与持久化路径；可以先维护本项目的 SDK 补丁，不必等待上游接受，但这仍是修改 SDK。

## SDK 补丁、版本和 API 成本

- 当前 `packages/agent/package.json` 将 7 个 `@oh-my-pi/*` 依赖精确锁在 **18.4.2**，已有按版本命名的 Bun 补丁，修改 `pi-coding-agent` 的 collab host/协议以实现近期历史分页。新字段预计涉及 `pi-coding-agent` 的 `PromptOptions`、`FollowUpOptions`、`SteerOptions`、用户消息构建和排队路径，以及 `pi-ai` 的 `UserMessage` 类型；若正式扩展 wire 类型，`pi-wire` 也需同步。不能只修改 React 类型。字段应小且可选，避免 provider 请求带上未经审查的内部来源元数据。
- 不必自动追每个上游版本。但每次升级都需要同步依赖与 lock、重建对应版本的补丁并检查其**行为**，更新 `packages/agent/scripts/build-native.ts` 中的 SDK 版本，执行 agent 类型检查/测试、原生包构建与 smoke，以及 Web/Hub 协议测试。`agent-session.ts` 的排队/提交逻辑比纯类型补丁更容易因上游调整而出现“补丁能应用但来源丢失”。上游接受可选字段后可移除相应私有补丁。
- Hub→daemon→session-host 的命令需携带 Hub 派生的 owner；SDK 负责在异步入库的消息上保存字段；Web wire、transcript 和 fleet 消息投影读取它。Hub 自有协议变更须更新 `docs/protocol.md` 和版本。可选的 collab JSON 字段在旧客户端被忽略，原则上不要求提高 `COLLAB_PROTO=3`，但实施时需验证各 guest。混合 daemon 版本的消息可能没有来源，应显示“未标记”而非冒认人类或 superagent；若要求所有新指令必有标签，再讨论版本门槛。
- **发布前置问题，已复现**：`.github/workflows/ci.yml` 的源码归档步骤复制了 agent 的 `src/types/package.json/bun.lock`，未复制 `patches/`；在不含补丁文件的隔离目录执行 `bun install --frozen-lockfile` 退出 1，报 `Couldn't find patch file: patches/@oh-my-pi%2Fpi-coding-agent@18.4.2.patch`。继续维护任何补丁前应修复归档内容并保留解包安装 smoke。原生包编译时也必须实际包含补丁后的 SDK。

## 与标准 omp 会话文件的兼容性

拟议方案仅在现有 v3 JSONL 的 `message.role: "user"` 中增加**可选** `origin`；不改文件头版本、已有角色或历史 entry 类型。新 SDK 应把缺失字段视为旧消息；旧 SDK 应跳过未知字段，允许先后读取、续写同一文件。不要据此允许两个进程**同时**写该会话文件。

已做的隔离验证（**模拟可选字段；拟议补丁尚未实现**）：

1. 标准 `omp 18.4.3` 通过 RPC `new_session` 创建 v3 JSONL；Hub 当前锁定的 SDK `18.4.2` 使用 `SessionManager.open` 正常读取。
2. 用 SDK `18.4.2` 写入带模拟 `origin` 的用户消息，重开并追加无来源消息后，第一条的字段仍保留；标准 `omp 18.4.3` 成功导出该文件，通过 RPC `set_session_name` 写回后字段仍保留。所有临时文件已清理，未调用远端模型。

这只证明目前的解析、普通续写与改名路径；拟议补丁写出的实际消息、真实模型续聊、压缩、回溯、分支重组、完整历史重写及旧版 `omp join` 展示尚未验证。标准 omp 可忽略/保留字段，不代表会显示来源标签或保证每种历史变换都保留它。

## 实施前的验收条件（暂未执行）

1. 先解决发布包缺失 SDK 补丁；提供可复现的源码安装与原生 daemon smoke。
2. 来源覆盖 fleet 初始提示、start、steer、follow_up、interrupt 替代提示；相同文本及人类/超级代理并发时不串源；取消、失败及队列清空不产生虚假来源。
3. 验证消息入库、重启、重连、旧/新历史分页、只读访客、`fleet_get_messages`、搜索/回溯/压缩，以及标准 omp ↔ 补丁 SDK 的双向文件读写和真实模型续聊。
4. UI 文案只展示已持久化来源；旧消息和旧 daemon 的无来源记录降级显示，不以 JSONL 来源字段做授权或审计。

尚未决定：`fleet_git_status` 的仓库授权粒度、变更性 Git 操作的审批机制、来源字段最终 schema/名称、SDK 上游提交时机及混合版本的强制门槛。**此 RFC 不启动实现。**
