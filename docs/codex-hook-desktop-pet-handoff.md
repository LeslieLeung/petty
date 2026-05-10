# Codex 低侵入接入方案 Handoff（桌宠状态监听 + 审批气泡）

## 1. 文档目标

本文档用于 handoff 给本地开发 agent，目标是在**尽量不改变用户 Codex 使用习惯**的前提下，把 Codex 的运行状态接入桌宠客户端，使桌宠能够：

1. 在用户使用 Codex 时进入 `work` 状态
2. 在 Codex 需要审批时弹出说话气泡和 `批准 / 拒绝` 按钮
3. 在审批后恢复到相应状态
4. 在 Codex 停止或空闲后回到 `idle/review`
5. 失败时进入 `failed`

## 2. 结论摘要

本方案采用 **Codex hooks + 本地 bridge** 的方式实现，不接入 app-server，不要求桌宠代理启动 Codex，不要求修改项目仓库，只在**用户级** `~/.codex` 配置层安装 hooks。

这是当前“低侵入 + 稳定 + 能支持审批闭环”的最佳平衡点。

### 为什么选 hooks

- Codex 官方支持生命周期 hooks，并支持放在用户级配置层
- `PermissionRequest` 可以在 Codex 弹原生审批前触发，并返回 `allow` / `deny` / 不决定
- 桌宠可以借此实现外部审批 UI；若桌宠无响应，可回退到 Codex 原生审批流
- 不需要把 Codex 改成由桌宠启动，也不需要包一层 wrapper
- 用户继续正常使用 `codex`

### 为什么不做纯旁路监听

纯旁路监听只能粗略判断“可能在忙”，但不能稳定得到“等待审批”这一关键状态，更无法把“批准 / 拒绝”真正回写给 Codex。因此**纯旁路监听不适合作为审批方案主路径**。

## 3. 范围

### 本期目标

- 支持 Codex CLI 的用户级 hooks 接入
- 支持桌宠状态：
  - `idle`
  - `work`
  - `awaiting_approval`
  - `review`
  - `failed`
- 支持桌宠审批气泡：
  - 显示审批原因 / 工具名 / 命令摘要
  - 用户点击 `批准` / `拒绝`
  - 超时后回退 Codex 原生审批

### 本期非目标

- 不接入 Codex app-server
- 不做对任意 agent 进程的系统级扫描和识别
- 不保证捕获 Codex 的全部内部活动
- 不做远程审批同步
- 不修改项目级 `.codex/` 配置
- 不做 Claude Code / OpenCode 接入（另案）

## 4. 官方能力与约束

以下约束已经核实，开发实现应以这些边界为准：

### 4.1 hooks 需要 feature flag

Codex hooks 需要在 `config.toml` 中开启：

```toml
[features]
hooks = true
```

### 4.2 hooks 的推荐安装位置

Codex 会从这些位置发现 hooks：

- `~/.codex/hooks.json`
- `~/.codex/config.toml`
- `<repo>/.codex/hooks.json`
- `<repo>/.codex/config.toml`

本方案只使用**用户级**层：

- `~/.codex/config.toml`
- `~/.codex/hooks.json`
- `~/.codex/hooks/`（自定义脚本目录）

### 4.3 我们需要的事件

本方案主要使用这些 hook 事件：

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PermissionRequest`
- `Stop`

### 4.4 hook 的输入输出方式

- 每个 command hook 都会从 `stdin` 收到一个 JSON 对象
- hook 通过 `stdout` 返回 JSON 决策或附加信息
- `PermissionRequest` 可以返回 `allow`、`deny`，或不作决定
- `Stop` 在 exit 0 时要求 `stdout` 为 JSON；纯文本输出无效

### 4.5 关键限制

#### PreToolUse / PostToolUse 不是完整覆盖

官方明确说明：

- `PreToolUse` 目前还不能拦截全部 shell 调用
- 对 `WebSearch` 等非 shell、非 MCP 工具也不完整
- 因此不能把 “是否正在工作” 完全依赖在 `PreToolUse/PostToolUse` 上

#### 多个 hooks 会并发运行

同一事件的多个匹配 hook 会并发启动，因此不能依赖 hook 之间的串行顺序。

#### PermissionRequest 是本方案核心

`PermissionRequest` 在 Codex 即将请求审批时触发，能够：

- `allow`
- `deny`
- decline to decide（不决定，继续原生审批流程）

这使得桌宠审批可以做到：

- 桌宠在线并及时响应 → 由桌宠完成审批
- 桌宠挂掉 / bridge 不可用 / 用户未响应 → 自动回退 Codex 自身审批

## 5. 方案总览

## 5.1 架构

```text
Codex CLI
  └─ hooks (user-level, ~/.codex)
      ├─ session_start hook
      ├─ user_prompt_submit hook
      ├─ pre_tool_use hook
      ├─ post_tool_use hook
      ├─ permission_request hook
      └─ stop hook
              │
              ▼
      Local Bridge (桌宠本地 bridge 进程 / 服务)
              │
              ├─ 状态总线 / 会话管理
              ├─ 审批等待与超时控制
              ├─ Tauri IPC / WebSocket / local HTTP
              ▼
      Desktop Pet Client
              ├─ 状态切换 work / idle / review / failed
              └─ 审批气泡 + 批准/拒绝按钮
```

## 5.2 设计原则

1. **低侵入**  
   不改变用户运行 `codex` 的方式，只安装用户级 hooks

2. **主路径稳定**  
   审批主路径依赖 `PermissionRequest`，不依赖解析终端文本

3. **失败可回退**  
   桌宠或 bridge 异常时，不阻断 Codex 原生审批体验

4. **状态粗细分层**  
   - 粗粒度工作态：`UserPromptSubmit` 到 `Stop`
   - 细粒度执行态：`PreToolUse/PostToolUse` 增强显示，但不是强依赖

5. **会话隔离**  
   以 `session_id + turn_id` 为主键跟踪状态，避免多会话串线

## 6. 推荐实现拆分

建议拆成三个部分：

### A. Hook Scripts

职责：

- 接收 Codex hook stdin JSON
- 解析成统一事件
- 发送给本地 bridge
- 对 `PermissionRequest` 同步等待 bridge 返回审批结果
- 输出符合 Codex 要求的 hook JSON

建议语言：

- Python 3（首选，跨平台、开发快）
- 或 Node.js（若桌宠主工程偏 TypeScript）

### B. Local Bridge

职责：

- 作为桌宠与 hooks 的本地中间层
- 聚合会话状态
- 推送状态给桌宠前端
- 管理审批请求的 pending 状态
- 为 PermissionRequest hook 提供同步等待结果的接口

建议形态：

- 作为桌宠应用启动时拉起的本地服务
- 提供 loopback HTTP 接口（优先）
- 或本地 WebSocket / named pipe / Unix socket

首版建议：**loopback HTTP + 随机 token 认证**

### C. Tauri Client / Desktop Pet UI

职责：

- 订阅 bridge 状态
- 更新桌宠状态机
- 渲染审批气泡
- 响应用户点击 `批准 / 拒绝`
- 将决策发回 bridge

## 7. 统一事件模型

bridge 内部不要直接传播 Codex hook 原始事件，统一转换成桌宠内部事件：

```ts
type AgentEvent =
  | { type: "session_started"; sessionId: string; cwd: string; source: "startup" | "resume" }
  | { type: "turn_started"; sessionId: string; turnId: string; prompt?: string }
  | { type: "tool_started"; sessionId: string; turnId: string; toolName: string; toolUseId?: string; summary?: string }
  | { type: "tool_finished"; sessionId: string; turnId: string; toolName: string; toolUseId?: string }
  | { type: "approval_requested"; requestId: string; sessionId: string; turnId: string; toolName: string; summary?: string; reason?: string; command?: string }
  | { type: "approval_resolved"; requestId: string; sessionId: string; turnId: string; decision: "approve" | "deny" | "fallback" }
  | { type: "turn_stopped"; sessionId: string; turnId: string; lastAssistantMessage?: string | null }
  | { type: "agent_error"; sessionId?: string; turnId?: string; message: string };
```

## 8. 桌宠状态映射

建议映射如下：

| 内部事件/状态 | 桌宠状态 | UI 行为 |
|---|---|---|
| session_started | review / idle | 可选轻提示 |
| turn_started | work | 进入工作动画 |
| tool_started | work | 强化工作中状态 |
| tool_finished | work | 若 turn 未结束则仍保持工作 |
| approval_requested | awaiting_approval | 说话气泡 + 批准/拒绝按钮 |
| approval_resolved: approve | work | 收起气泡，继续工作 |
| approval_resolved: deny | failed / annoyed | 短暂反馈后回 review/idle |
| approval_resolved: fallback | awaiting_approval -> review | 桌宠收起气泡，不再主导审批 |
| turn_stopped | review / idle | 结束工作态 |
| agent_error | failed | 短暂失败状态 |

建议：
- 以 **turn 维度** 驱动 `work`
- 以 **approval_requested** 驱动审批 UI
- 不把 `PreToolUse/PostToolUse` 当成唯一状态来源

## 9. 状态判定规则

## 9.1 工作态

建议规则：

1. 收到 `UserPromptSubmit` → 标记 turn active → 桌宠进入 `work`
2. 若期间收到 `PreToolUse/PostToolUse` → 仅更新“活动摘要”
3. 收到 `Stop` → turn inactive
4. 若当前无 active turn 且无 pending approval → 回 `review/idle`

## 9.2 审批态

收到 `PermissionRequest` 时：

- bridge 创建 pending approval
- 桌宠进入 `awaiting_approval`
- 渲染审批气泡

若用户点击：
- `批准` → bridge 返回 approve
- `拒绝` → bridge 返回 deny

若超时：
- PermissionRequest hook 返回“未决定”
- Codex 继续原生审批
- bridge 把此次审批标记为 `fallback`

## 10. 本地 bridge 协议（建议版）

首版建议 bridge 提供本地 HTTP API。

## 10.1 安全策略

- 仅监听 `127.0.0.1`
- 桌宠首次启动生成随机 token
- token 存在用户数据目录
- hooks 调用 bridge 时带 `Authorization: Bearer <token>`
- token 不写进项目目录

## 10.2 Hook -> Bridge

### POST /v1/codex/events

用于上报普通事件（不需要同步等待）。

请求体示例：

```json
{
  "source": "codex",
  "eventType": "turn_started",
  "sessionId": "sess_123",
  "turnId": "turn_456",
  "cwd": "/path/to/project",
  "toolName": null,
  "toolUseId": null,
  "payload": {
    "prompt": "fix the failing tests"
  },
  "timestamp": "2026-05-09T12:00:00Z"
}
```

返回：

```json
{ "ok": true }
```

### POST /v1/codex/approval-request

用于 `PermissionRequest`，需要同步等待审批结果。

请求体示例：

```json
{
  "source": "codex",
  "requestId": "apr_001",
  "sessionId": "sess_123",
  "turnId": "turn_456",
  "cwd": "/path/to/project",
  "toolName": "Bash",
  "payload": {
    "reason": "Command requires approval",
    "command": "git push origin main",
    "description": "Push commits to remote"
  },
  "timeoutMs": 20000,
  "timestamp": "2026-05-09T12:00:00Z"
}
```

同步响应：

```json
{ "decision": "approve" }
```

或：

```json
{ "decision": "deny", "message": "Rejected from desktop pet UI" }
```

或：

```json
{ "decision": "fallback" }
```

规则：
- `approve` → hook 输出 Codex `allow`
- `deny` → hook 输出 Codex `deny`
- `fallback` / bridge 不可达 / 超时 / 非 2xx → hook 不作决定，回退原生审批

## 10.3 Client <-> Bridge

### GET /v1/agent/state

获取当前聚合状态：

```json
{
  "agent": "codex",
  "isActive": true,
  "activeTurnCount": 1,
  "pendingApprovalCount": 1,
  "topState": "awaiting_approval",
  "sessions": [
    {
      "sessionId": "sess_123",
      "cwd": "/path/to/project",
      "activeTurns": [
        {
          "turnId": "turn_456",
          "status": "awaiting_approval",
          "latestToolName": "Bash",
          "latestSummary": "git push origin main"
        }
      ]
    }
  ]
}
```

### GET /v1/agent/events/stream

建议使用 SSE 或 WebSocket，向桌宠推送事件。

### POST /v1/approvals/{requestId}/decision

桌宠用户操作审批后调用：

```json
{
  "decision": "approve"
}
```

或：

```json
{
  "decision": "deny"
}
```

## 11. Hook 与 bridge 的时序

## 11.1 工作态时序

```text
用户运行 codex
  -> SessionStart hook
    -> bridge: session_started
  -> UserPromptSubmit hook
    -> bridge: turn_started
    -> 桌宠切换到 work
  -> PreToolUse hook（可选增强）
    -> bridge: tool_started
  -> PostToolUse hook（可选增强）
    -> bridge: tool_finished
  -> Stop hook
    -> bridge: turn_stopped
    -> 桌宠回到 review/idle
```

## 11.2 审批时序

```text
Codex 即将请求审批
  -> PermissionRequest hook
    -> bridge: approval_requested
    -> 桌宠弹气泡 + 按钮
      -> 用户点批准
         -> client -> bridge: approve
         -> bridge -> hook: approve
         -> hook stdout: allow
         -> Codex 继续
         -> 桌宠回到 work

      -> 用户点拒绝
         -> client -> bridge: deny
         -> bridge -> hook: deny
         -> hook stdout: deny
         -> Codex 拒绝本次操作
         -> 桌宠短暂 failed/annoyed 后回 idle/review

      -> 用户无操作 / 桌宠挂掉 / bridge 不可达
         -> bridge/hook timeout
         -> hook 不返回 allow/deny
         -> Codex 继续原生审批 prompt
         -> 桌宠标记 fallback 并收起气泡
```

## 12. Hook 脚本推荐行为

## 12.1 SessionStart

用途：
- 感知有新的 Codex 会话
- 可作为桌宠轻提示，不一定进入 `work`

建议：
- 只 fire-and-forget 上报事件
- 不做阻塞逻辑

## 12.2 UserPromptSubmit

用途：
- turn 级工作开始信号
- 首版主要工作态入口

建议：
- 上报 `turn_started`
- 记录 prompt 摘要

## 12.3 PreToolUse

用途：
- 工作中细粒度增强
- 可展示当前工具和命令摘要

建议：
- 只做观察，不做 deny
- 首版不在这里做策略拦截
- 不依赖其完整性

## 12.4 PostToolUse

用途：
- 更新活动摘要
- 可记录最近一次工具完成

建议：
- 只做观察
- 不做继续 / block 逻辑

## 12.5 PermissionRequest

用途：
- 审批闭环核心

建议：
- 向 bridge 发同步审批请求
- 最长等待 `15~20s`
- bridge 不可达 / 超时 / 未决策 → fallback
- 仅对桌宠展示必要信息，不泄漏过多上下文

## 12.6 Stop

用途：
- turn 结束信号
- 工作态恢复入口

建议：
- 上报 `turn_stopped`
- 如果该 turn 下还有 pending approval，需要先清理状态
- 不使用 Stop 的“继续执行”能力

## 13. Hook 配置建议

优先使用 `~/.codex/config.toml` + 外部脚本。

示例：

```toml
[features]
hooks = true

[[hooks.SessionStart]]
matcher = "startup|resume"

[[hooks.SessionStart.hooks]]
type = "command"
command = "python3 ~/.codex/hooks/deskpet_codex_hook.py SessionStart"

[[hooks.UserPromptSubmit]]
matcher = ".*"

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "python3 ~/.codex/hooks/deskpet_codex_hook.py UserPromptSubmit"

[[hooks.PreToolUse]]
matcher = ".*"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "python3 ~/.codex/hooks/deskpet_codex_hook.py PreToolUse"

[[hooks.PostToolUse]]
matcher = ".*"

[[hooks.PostToolUse.hooks]]
type = "command"
command = "python3 ~/.codex/hooks/deskpet_codex_hook.py PostToolUse"

[[hooks.PermissionRequest]]
matcher = ".*"

[[hooks.PermissionRequest.hooks]]
type = "command"
command = "python3 ~/.codex/hooks/deskpet_codex_hook.py PermissionRequest"
timeout = 25

[[hooks.Stop]]
matcher = ".*"

[[hooks.Stop.hooks]]
type = "command"
command = "python3 ~/.codex/hooks/deskpet_codex_hook.py Stop"
```

说明：
- 可先全量匹配 `.*`
- 后续可以针对 `Bash`、`apply_patch` 等做更细分 matcher
- `PermissionRequest` 需要设置足够 timeout，保证用户有点击空间

## 14. Hook stdin 到统一事件的映射

### Common input fields

常用字段：

- `session_id`
- `transcript_path`
- `cwd`
- `hook_event_name`
- `model`

### Event-specific 字段

#### SessionStart
- `source`: `startup` / `resume`

#### UserPromptSubmit
- `turn_id`
- `prompt`

#### PreToolUse
- `turn_id`
- `tool_name`
- `tool_use_id`
- `tool_input`

#### PostToolUse
- `turn_id`
- `tool_name`
- `tool_use_id`
- `tool_input`
- （可能包含工具输出相关信息，首版可不消费）

#### PermissionRequest
- `turn_id`
- `tool_name`
- `tool_input`
- `tool_input.description`

#### Stop
- `turn_id`
- `stop_hook_active`
- `last_assistant_message`

## 15. UI 交互建议

## 15.1 审批气泡内容

推荐展示：

- 标题：`Codex 需要批准`
- 工具：`Bash` / `apply_patch` / MCP tool
- 摘要：命令前 1 行或简短描述
- 项目：当前目录 basename
- 按钮：`批准` / `拒绝`

不要默认展示：
- 超长命令全文
- 敏感路径
- transcript 原文大段内容

可以加一个 `详情` 按钮，打开更完整信息面板。

## 15.2 超时与回退

- 默认超时：20 秒
- 倒计时可选
- 超时后文案：`未处理，已回到 Codex 原生审批`
- 桌宠收起按钮，但可短暂提示

## 15.3 多审批并发

首版建议：
- 只展示最近一个 pending approval
- bridge 内部可以支持队列
- UI 不做复杂多审批面板

## 16. 失败处理

## 16.1 Bridge 不可达

- hook 捕获连接失败
- 非 PermissionRequest 事件：静默忽略，不影响 Codex
- PermissionRequest：返回 fallback，不阻断原生审批

## 16.2 桌宠未运行

与 bridge 不可达相同处理。

## 16.3 hook 脚本异常

- 记录本地日志
- 不要把异常抛出到影响 Codex 正常使用的程度
- PermissionRequest 异常时必须 fail-open 到原生审批

## 16.4 状态错乱

例如：
- 收到 Stop 但 turn 不存在
- approval 已结束又收到重复决策

处理：
- bridge 保持幂等
- 未知 turn 直接忽略或记录 warning
- 决策接口应只允许 pending 状态转换一次

## 17. 安装与卸载

## 17.1 安装

桌宠在设置页提供：

- `启用 Codex 接入`
- 自动检查 `~/.codex/config.toml`
- 自动备份原配置
- 追加 hooks 配置
- 写入 `~/.codex/hooks/deskpet_codex_hook.py`
- 生成 bridge token

建议提供：
- 一键安装
- 一键修复
- 查看日志
- 校验 hooks 是否生效

## 17.2 卸载

- 删除或回滚桌宠写入的 hook 配置
- 删除 `~/.codex/hooks/deskpet_codex_hook.py`
- 删除 bridge token
- 不删除用户已有其他 Codex 配置

安装器应只管理自己加的区块，避免破坏用户现有配置。

## 18. 研发优先级建议

### P0

- bridge 基础服务
- SessionStart / UserPromptSubmit / Stop
- PermissionRequest 审批闭环
- 桌宠状态切换
- 按钮 UI + 超时回退

### P1

- PreToolUse / PostToolUse 活动摘要
- 项目名、命令摘要展示
- 配置安装器 / 卸载器
- 日志与诊断页

### P2

- 多 session / 多 turn 可视化
- 审批详情面板
- 更细的 tool matcher
- 审批历史

## 19. 建议的验收标准

1. 用户不改变日常 `codex` 使用方式
2. 安装用户级 hooks 后，桌宠可感知 turn 开始与结束
3. Codex 需要审批时，桌宠必定弹出审批气泡
4. 用户点击 `批准`，Codex 继续执行
5. 用户点击 `拒绝`，Codex 拒绝该操作
6. 桌宠未响应或 bridge 异常时，Codex 回到原生审批流程
7. bridge / hook 异常不会导致 Codex CLI 不可用
8. 同时打开多个项目时，状态不会串会话

## 20. 实现建议（代码组织）

建议代码目录：

```text
desktop-pet/
  apps/
    tauri-client/
    bridge/
  integrations/
    codex/
      installer/
      hook/
        deskpet_codex_hook.py
      protocol/
      tests/
  docs/
    codex-hook-handoff.md
```

## 21. 明确不采用的方案

### A. 纯终端输出解析
不采用。脆弱，且无法稳定承接审批。

### B. 直接监控 `~/.codex/sessions/` 等内部状态文件
不作为主路径。可以作为诊断或 fallback 观察，但不作为产品主实现。

### C. 通过桌宠启动 Codex / 包装 Codex 命令
不采用。侵入性更高，不符合目标。

### D. 直接用 app-server
当前不采用。能力更强，但侵入性和接入复杂度更高，不符合“只是监听用户使用 Codex”的首发目标。

## 22. 开发注意事项

1. **PermissionRequest 必须 fail-open**  
   bridge 不可达 / UI 无响应时，必须回退 Codex 原生审批

2. **不要把 PreToolUse 当作完整状态来源**  
   其覆盖不完整，不能单独作为“是否在工作”的判据

3. **不要把 hook 设计成重逻辑脚本**  
   hook 应尽量轻，复杂逻辑放 bridge

4. **所有 hook 调用都要设置短超时**  
   普通事件 hook：1~2s  
   PermissionRequest：15~25s

5. **安装器要可逆**  
   不能破坏用户现有 Codex 配置

## 23. 参考资料

1. OpenAI Developers — Codex Hooks  
   https://developers.openai.com/codex/hooks

2. OpenAI Developers — Codex Configuration Reference  
   https://developers.openai.com/codex/config-reference

3. OpenAI Developers — Codex App Server  
   https://developers.openai.com/codex/app-server

## 24. 已核实的关键官方事实（供实现时参考）

- hooks 需通过 `[features] hooks = true` 开启
- hooks 可放在用户级 `~/.codex/hooks.json` 或 `~/.codex/config.toml`
- `PreToolUse`、`PermissionRequest`、`PostToolUse`、`UserPromptSubmit`、`Stop` 是 turn-scoped hooks
- 每个 command hook 会从 stdin 收到一个 JSON 对象
- `PermissionRequest` 可返回 allow / deny / 不决定
- `PermissionRequest` 只在需要审批时触发，不会对无需审批的命令触发
- `PreToolUse` 对 shell 拦截仍不完整，不覆盖所有 shell / WebSearch / 非 shell / 非 MCP 路径
- 同一事件的多个匹配 command hooks 会并发运行

---

这份 handoff 到这里即可直接进入开发。首版建议先打通：

- `UserPromptSubmit -> work`
- `PermissionRequest -> 审批气泡`
- `Stop -> idle`

然后再加 `PreToolUse/PostToolUse` 做状态细化。
