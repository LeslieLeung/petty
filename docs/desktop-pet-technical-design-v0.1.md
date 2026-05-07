# Desktop Pet 技术设计文档（v0.1 / MVP）

## 1. 文档信息

- 项目名称：Desktop Pet
- 文档类型：Technical Design Document
- 对应产品文档：`desktop-pet-prd-v0.2.md`
- 目标版本：MVP（v0.1）
- 目标平台：macOS / Windows
- 客户端技术方向：Tauri 2 + PixiJS
- 资源生产方式：离线生成，客户端只负责消费资源

---

## 2. 设计目标

本文档用于把 PRD 中的产品目标细化为可研发落地的技术方案，重点覆盖：

1. MVP 的总体架构与模块划分
2. 资源包兼容方案与内部运行时模型
3. 状态系统、行为调度与自主行为机制
4. 桌面交互与屏幕边缘交互实现方式
5. macOS / Windows 平台差异与适配边界
6. 本地存储、错误处理、性能与测试策略
7. 面向后续能力（窗口感知 / 聊天 / ASR / TTS / SOUL / 记忆）的扩展点

本文档明确一个 MVP 范围约束：

- **MVP 不要求支持 PRD 中列举的全部扩展状态**
- **MVP 优先兼容 hatch-pet 现有产物与其已有状态集合**
- **更丰富的自主状态与表面状态，通过资源包 v2 和 capability 机制渐进启用**

---

## 3. 范围定义

## 3.1 MVP 覆盖范围

### 3.1.1 基础运行
- 单宠物运行
- 透明背景宠物窗口
- 常驻桌面显示
- 托盘 / 菜单栏控制
- 开机自启动

### 3.1.2 资源管理
- 导入资源包
- 安装 / 删除 / 切换宠物
- 兼容旧版 hatch-pet 资源
- 支持新版 `manifest.json` 资源包

### 3.1.3 基础交互
- 单击
- 双击
- 拖拽
- 右键菜单
- 可选悬停反馈

### 3.1.4 状态与行为
- 基于旧资源的基础状态播放
- 自动状态切换
- 长时间无交互后的自主行为轮换
- 用户行为打断与恢复

### 3.1.5 环境交互
- 屏幕底边 / 左右边 / 顶边识别
- 底边吸附与活动
- 越界修正与表面丢失回退

### 3.1.6 设置与调试
- 基本设置持久化
- 调试模式
- 资源加载错误提示

## 3.2 不在 MVP 内
- 窗口边缘感知
- 多宠物
- 聊天 / LLM
- ASR / TTS
- SOUL.md 运行时能力
- 记忆系统
- 云同步 / 账号体系

---

## 4. 总体架构

## 4.1 架构原则

1. **资源与运行解耦**：客户端不参与资源生成
2. **外部格式与内部格式解耦**：所有资源先转成统一 Runtime Manifest
3. **平台能力与通用逻辑解耦**：平台适配放在 Tauri/Rust 层，动画与行为逻辑放在前端运行时
4. **语义驱动，不硬编码状态名**：调度器依赖语义角色，不直接依赖资源中的原始状态名
5. **渐进增强**：高级环境交互与 companion 能力通过 capability 增量接入

## 4.2 分层架构

```text
+-----------------------------------------------------------+
|                       Management UI                        |
|          设置页 / 资源管理页 / 调试页 / 托盘菜单          |
+-----------------------------------------------------------+
|                    Pet Runtime (TypeScript)                |
|  Resource Loader / State Machine / Scheduler / Interaction |
|  Surface Controller / Persistence Sync / Runtime Adapter   |
+-----------------------------------------------------------+
|                      Renderer (PixiJS)                     |
|        Atlas Loader / Clip Playback / Hit Test / Overlay   |
+-----------------------------------------------------------+
|                    Tauri Shell (Rust)                      |
|  Window / Tray / Autostart / FileSystem / Screen Info      |
|  Platform Adapter / Event Bridge / Install Management      |
+-----------------------------------------------------------+
|                OS APIs (macOS / Windows)                   |
+-----------------------------------------------------------+
```

## 4.3 组件职责

### A. Tauri Shell（Rust）
负责：
- 应用生命周期管理
- 宠物窗口、设置窗口、资源窗口创建
- 托盘菜单 / 菜单栏菜单
- 开机自启动
- 文件系统与数据目录
- 资源导入 / 安装 / 删除
- 屏幕几何信息获取
- 与前端的命令和事件桥接

### B. Pet Runtime（TypeScript）
负责：
- 宠物运行时初始化
- 加载 Runtime Manifest
- 状态机与状态过渡
- 自主行为调度
- 用户交互处理
- 屏幕边缘表面控制
- 和设置、持久化状态同步

### C. Renderer（PixiJS）
负责：
- 加载 atlas 图片
- 切分帧序列
- 播放动画 clip
- sprite 位置、缩放、翻转
- 交互命中区域
- 调试信息 overlay

### D. Compatibility Adapter
负责：
- 读取旧版 `pet.json + spritesheet.webp`
- 读取新版 `manifest.json`
- 统一转换为 Runtime Manifest
- 补齐默认字段和降级策略

### E. Management UI
负责：
- 已安装宠物列表
- 导入资源包
- 设置读写
- 调试信息展示
- 错误信息展示

---

## 5. 模块划分

## 5.1 Rust / Tauri 模块

```text
src-tauri/
  src/
    main.rs
    app/
      mod.rs
      lifecycle.rs
      window_manager.rs
      tray.rs
      autostart.rs
    pet/
      install_service.rs
      package_validator.rs
      package_index.rs
      storage_paths.rs
    platform/
      mod.rs
      screen.rs
      workarea.rs
      windows.rs        # v0.2+ 预留
      macos.rs          # v0.2+ 预留
    api/
      commands.rs
      events.rs
    state/
      app_state.rs
```

### 关键职责

- `window_manager.rs`
  - 创建宠物透明窗口
  - 创建设置窗口 / 资源管理窗口
  - 处理 show / hide / always-on-top / ignore-focus 等窗口行为

- `install_service.rs`
  - 处理资源导入、解压、安装、删除
  - 执行包校验
  - 生成安装索引

- `package_validator.rs`
  - 判断资源是旧格式还是新格式
  - 校验必需文件是否存在
  - 生成校验报告

- `screen.rs`
  - 提供屏幕尺寸、工作区、缩放信息
  - 向前端同步当前显示器边界

- `commands.rs`
  - 暴露给前端的 Tauri commands

## 5.2 Frontend / Runtime 模块

```text
src/
  core/
    bootstrap.ts
    runtime.ts
    event-bus.ts
  pet-runtime/
    resource/
      resource-loader.ts
      runtime-manifest.ts
      legacy-adapter.ts
      v2-adapter.ts
      manifest-normalizer.ts
    render/
      pixi-stage.ts
      sprite-controller.ts
      atlas-slicer.ts
      clip-player.ts
      debug-overlay.ts
    state/
      pet-state-machine.ts
      semantic-role.ts
      transition-policy.ts
    behavior/
      scheduler.ts
      activity-policy.ts
      inactivity-tracker.ts
      cooldown-store.ts
    interaction/
      click-handler.ts
      drag-handler.ts
      hover-handler.ts
      context-menu-handler.ts
    surface/
      screen-surface.ts
      edge-snap.ts
      support-check.ts
      recovery-policy.ts
    store/
      settings-store.ts
      runtime-store.ts
      pet-library-store.ts
  ui/
    settings/
    library/
    debug/
```

---

## 6. 数据模型设计

## 6.1 外部资源格式

客户端需要支持两类外部资源：

### A. Legacy Resource（旧格式）
```text
pet.json
spritesheet.webp
```

### B. Package v2（新格式）
```text
pet-package/
  manifest.json
  sprites/
    main.webp
  meta/
    thumbnail.png
    soul.md
  audio/
```

## 6.2 内部统一模型：Runtime Manifest

运行时不直接消费外部格式，统一转成以下内部结构：

```ts
interface RuntimeManifest {
  meta: RuntimePetMeta
  atlas: RuntimeAtlas
  clips: Record<string, RuntimeClip>
  semanticRoles: RuntimeSemanticRoles
  interactions: RuntimeInteractionMap
  behaviorPolicy: RuntimeBehaviorPolicy
  surfacePolicy: RuntimeSurfacePolicy
  capabilities: RuntimeCapabilities
  compatibility: RuntimeCompatibilityInfo
}
```

### 6.2.1 Meta

```ts
interface RuntimePetMeta {
  id: string
  name: string
  version: string
  description?: string
  defaultScale: number
  defaultState: string
}
```

### 6.2.2 Atlas

```ts
interface RuntimeAtlas {
  imagePath: string
  cellWidth: number
  cellHeight: number
  sheetWidth: number
  sheetHeight: number
  columns: number
  rows: number
}
```

### 6.2.3 Clip

```ts
interface RuntimeClip {
  key: string
  frames: RuntimeFrameRef[]
  fps: number
  loop: boolean
  interruptible: boolean
  nextState?: string
  tags: string[]
  minDurationMs?: number
  cooldownSeconds?: number
}

interface RuntimeFrameRef {
  row: number
  col: number
}
```

### 6.2.4 Semantic Roles

```ts
interface RuntimeSemanticRoles {
  idle?: string[]
  greet?: string[]
  jump?: string[]
  moveLeft?: string[]
  moveRight?: string[]
  moveGeneric?: string[]
  busy?: string[]
  failed?: string[]
  sleep?: string[]
  doze?: string[]
  eat?: string[]
  groom?: string[]
  observe?: string[]
  edgeStand?: string[]
  edgeWalk?: string[]
  fall?: string[]
  land?: string[]
}
```

### 6.2.5 Behavior Policy

```ts
interface RuntimeBehaviorPolicy {
  inactivityThresholds: {
    mildIdleMs: number
    autonomousMs: number
  }
  actions: RuntimeBehaviorAction[]
}

interface RuntimeBehaviorAction {
  key: string
  candidateClips: string[]
  weight: number
  cooldownSeconds: number
  minDurationMs: number
  interruptOnUserInput: boolean
  requiresGround?: boolean
}
```

### 6.2.6 Surface Policy

```ts
interface RuntimeSurfacePolicy {
  enabled: boolean
  supportedSurfaces: Array<'screen-bottom' | 'screen-left' | 'screen-right' | 'screen-top'>
  snapDistancePx: number
  fallbackMode: 'idle' | 'move' | 'teleport-to-ground'
}
```

### 6.2.7 Capabilities

```ts
interface RuntimeCapabilities {
  basicAnimation: boolean
  interaction: boolean
  autonomousBehavior: boolean
  surfaceAware: boolean
  windowAware: boolean
  chat: boolean
  asr: boolean
  tts: boolean
  memory: boolean
  soul: boolean
}
```

---

## 7. 资源兼容方案

## 7.1 兼容目标

- 旧格式资源可直接导入运行
- 新格式资源优先消费 `manifest.json`
- 内部只存在一种运行时结构
- 状态缺失时功能降级，不导致运行时崩溃

## 7.2 兼容流程

```text
导入资源
  -> 判断格式（legacy / v2）
  -> 结构校验
  -> 解析元数据
  -> 转换为 Runtime Manifest
  -> 补齐默认字段
  -> 写入 runtime-manifest.cache.json
  -> 运行时加载
```

## 7.3 Legacy Adapter

### 7.3.1 目标
把旧的 `pet.json` 映射成内部 clip + semantic role。

### 7.3.2 状态映射策略

MVP 不直接依赖 PRD 中完整状态集合，而是先做语义角色映射。

#### 原始状态 → 语义角色

```text
idle           -> idle
waving         -> greet
jumping        -> jump
running-right  -> moveRight
running-left   -> moveLeft
running        -> moveGeneric / busy
review         -> busy / observe
failed         -> failed
```

#### 缺失状态时的回退

```text
sleep    -> idle
doze     -> idle / review
eat      -> idle / review
groom    -> idle
observe  -> review / idle
edge-*   -> idle / running-left / running-right
fall     -> jump / idle
land     -> idle
```

### 7.3.3 Legacy Runtime Policy 默认值

对旧资源自动补以下默认策略：

- `defaultScale = 1.0`
- `autonomousBehavior = true`
- `surfaceAware = false`（逻辑层可运行，但资源层不声明）
- `snapDistancePx = 24`
- `fallbackMode = teleport-to-ground`

## 7.4 V2 Adapter

直接读取 `manifest.json`，并执行：
- 字段必填校验
- 缺省值填充
- clips 规范化
- capability 解析
- transitions / interactions 转内部结构

## 7.5 安装期缓存

导入成功后，生成：

```text
runtime-manifest.cache.json
validation-report.json
```

这样运行时切换宠物无需重复解析原始资源。

---

## 8. 状态系统设计

## 8.1 设计原则

1. 运行时状态机依赖语义角色，不依赖固定原始状态名
2. 资源动画状态和运行时控制状态分离
3. 用户交互优先级高于自主行为
4. 伪状态允许存在，不要求资源必须提供动画

## 8.2 状态层级

### 8.2.1 运行时控制状态（Control State）

```text
booting
loading
idle
autonomous
interacting
dragging
recovering
error
```

### 8.2.2 动画播放状态（Clip State）

由 Runtime Manifest 中的 clip 决定，例如：

```text
idle
waving
jumping
running-right
running-left
review
failed
```

## 8.3 状态属性

```ts
interface RuntimeStateNode {
  key: string
  priority: number
  interruptible: boolean
  minDurationMs: number
  cooldownSeconds?: number
  interruptOnUserInput?: boolean
}
```

## 8.4 状态优先级建议

```text
error / loading                100
user drag / drag-end recovery   90
double click interaction        80
single click interaction        70
surface recovery                60
autonomous action               40
default idle                    10
```

## 8.5 伪状态设计

以下状态允许仅存在运行时逻辑，不要求资源包有对应动画：

- `dragging`
- `recovering`
- `snap-to-edge`
- `surface-lost`

处理策略：
- 若资源提供动画，则播放动画
- 若无动画，则只执行位置 / 逻辑变化，结束后切回可用 clip

---

## 9. 行为调度器设计

## 9.1 为什么 MVP 不使用行为树

MVP 的目标是：
- 支持长时间无交互的自动切换
- 支持权重、冷却、最短时长
- 支持被用户打断

这些需求用规则调度器足够满足；过早引入行为树或 needs system 会显著增加复杂度。

## 9.2 调度器输入

- 当前运行时状态
- 最近一次用户交互时间
- 当前 clip
- 当前表面状态
- 当前 cooldown store
- 资源能力与可用 clip 集合
- 当前设置（是否允许自动走动 / 是否启用自主行为）

## 9.3 调度器输出

- 下一个要播放的 clip key
- 播放时长下限
- 是否允许被用户输入打断
- 播放完成后的回退策略

## 9.4 调度循环

### 高频渲染循环
- 由 Pixi ticker 驱动
- 只负责位置和帧推进

### 低频调度循环
- 250ms ~ 500ms 一次
- 负责判断是否切换行为
- 低频即可，减少 CPU 占用

## 9.5 调度优先级

```text
强制异常状态
  > 用户交互状态
  > 表面恢复状态
  > 自主行为
  > 默认待机
```

## 9.6 自主行为策略

### 9.6.1 行为槽位
MVP 不要求资源必须有 sleep/eat/groom 等具体状态，而是按行为槽位运行：

- `calm_idle`
- `attention_shift`
- `short_move`
- `greet_variant`
- `busy_loop`

### 9.6.2 对旧资源的默认映射

```text
calm_idle       -> idle
attention_shift -> review / idle
greet_variant   -> waving / idle
short_move      -> running-left / running-right / running
busy_loop       -> running / review
```

### 9.6.3 调度条件

- 用户长时间无交互
- 当前无更高优先级状态
- 候选行为不在 cooldown
- 满足地面 / 表面要求

### 9.6.4 打断规则

- 用户 click / double click / drag 可中断自主行为
- 中断后立即切用户交互状态
- 用户交互结束后回到默认 idle 或重新进入调度

---

## 10. 渲染与动画设计

## 10.1 渲染目标

- 单窗口透明背景
- 单宠物 sprite 为主
- 支持动画 clip 播放
- 支持调试 overlay
- 尽量减少无意义重排与资源重建

## 10.2 Pixi 场景层次

```text
Stage
  ├─ PetContainer
  │   └─ PetSprite / AnimatedSprite-like controller
  ├─ BubbleLayer
  └─ DebugOverlayLayer
```

## 10.3 帧切分策略

不直接依赖 Pixi 的通用 spritesheet json，而由运行时根据 atlas 网格切帧：

```ts
x = col * cellWidth
y = row * cellHeight
w = cellWidth
h = cellHeight
```

按 `RuntimeClip.frames` 生成纹理数组。

## 10.4 动画控制器

`ClipPlayer` 负责：
- 播放指定 clip
- 处理 fps
- 处理 loop / once
- 播放完成后发出 `clip:end`
- 切换 clip 时保留必要的朝向与位置

## 10.5 位置与朝向

宠物位置使用运行时模型统一维护：

```ts
interface PetTransform {
  x: number
  y: number
  scale: number
  facing: 'left' | 'right'
}
```

规则：
- `moveLeft` 默认朝左
- `moveRight` 默认朝右
- `moveGeneric` 可根据当前 facing 选择反转显示或选择对应 clip

## 10.6 命中测试

MVP 用 AABB 命中即可：
- sprite 当前显示 bounds
- 可选加入脚底偏移，避免透明边缘命中过大

像素级命中不做 MVP 范围。

---

## 11. 交互控制设计

## 11.1 单击

流程：

```text
pointerdown/up
  -> 判断非拖拽
  -> emit click
  -> 状态机请求 interaction
  -> 优先播放 greet / click 语义 clip
```

## 11.2 双击

流程：

```text
double click
  -> emit doubleClick
  -> 状态机选择强反馈 clip
  -> 若无专用 clip，则 greet + jump 组合
```

## 11.3 拖拽

### 拖拽开始
- 记录鼠标与宠物原点偏移
- 暂停自主行为调度
- 进入 `dragging` 控制状态

### 拖拽进行中
- sprite 跟随鼠标更新位置
- 每帧更新位置，不切自动行为

### 拖拽结束
- 计算是否靠近边缘 / 是否落在有效工作区
- 应用吸附 / 修正 / 回退策略
- 切到 `recovering`
- 恢复 idle 或进入表面状态

## 11.4 右键菜单

右键触发由外壳层统一处理，避免宠物窗口内部自己渲染菜单。

菜单项建议：
- 显示 / 隐藏宠物
- 切换宠物
- 暂停互动
- 打开设置
- 重新加载资源
- 打开数据目录
- 退出

---

## 12. 屏幕边缘与表面控制

## 12.1 MVP 边界

MVP 只处理**屏幕边缘**，不处理窗口表面。

## 12.2 表面模型

```ts
type SurfaceKind =
  | 'screen-bottom'
  | 'screen-left'
  | 'screen-right'
  | 'screen-top'
  | 'none'
```

## 12.3 工作区获取

由 Rust 层提供：
- 当前显示器矩形
- 当前工作区矩形
- DPI / scale factor

前端运行时只做逻辑判断，不直接读平台 API。

## 12.4 吸附逻辑

### 条件
- 拖拽结束时距离边缘小于 `snapDistancePx`
- 当前允许贴边行为

### 行为
- 将位置吸附到最近合法边界
- 优先底边
- 若资源支持 surface-aware clip，则切换对应语义
- 若不支持，则仍使用普通 idle / move 表现

## 12.5 表面丢失恢复

当检测到位置不合法或越界：
- 先尝试修正到最近工作区合法位置
- 再切回 idle / recover
- 若未来资源支持 `fall/land`，再增加掉落视觉

## 12.6 为什么 MVP 不做窗口边缘

因为这部分需要：
- 枚举窗口矩形
- 跟踪前台窗口变化
- 处理多显示器与窗口移动
- 处理系统权限和平台差异

实现复杂度高，适合 v0.2 单独接入。

---

## 13. 平台层设计

## 13.1 Tauri Command 列表

建议暴露以下命令：

### 资源与存储
- `install_pet_package(path)`
- `remove_pet_package(pet_id)`
- `list_installed_pets()`
- `get_pet_installation(pet_id)`
- `read_runtime_manifest(pet_id)`

### 窗口与系统
- `show_settings_window()`
- `show_library_window()`
- `set_autostart(enabled)`
- `get_autostart_status()`
- `get_screen_info()`
- `get_app_paths()`

### 状态持久化
- `load_settings()`
- `save_settings(payload)`
- `load_runtime_state()`
- `save_runtime_state(payload)`

## 13.2 前后端事件桥接

### Rust -> Frontend
- `screen-info-updated`
- `pet-installed`
- `pet-removed`
- `settings-updated`

### Frontend -> Rust
- command invoke 为主
- 高频位置信息不通过 Rust 往返

## 13.3 平台差异处理

### macOS
- 透明窗口、always-on-top、dock/menu bar 表现需要重点验证
- 若需要更接近桌宠体验，可能涉及私有 API 能力约束

### Windows
- 重点验证透明窗口、穿透行为、任务栏遮挡、DPI 缩放

### 统一策略
- 所有平台差异封装在 Rust `platform/` 下
- 前端只消费统一的 screen/workarea 信息

---

## 14. 本地存储设计

## 14.1 目录结构

```text
app-data/
  settings.json
  runtime-state.json
  pets/
    index.json
    <pet-id>/
      <version>/
        raw/
        normalized/
          runtime-manifest.cache.json
          validation-report.json
        assets/
```

## 14.2 settings.json

保存：
- 是否开机自启动
- 是否显示名字 / 气泡
- 当前缩放
- 是否允许自动走动
- 是否启用自主行为
- 自主行为频率
- 是否启用贴边行为
- 调试模式

## 14.3 runtime-state.json

保存：
- 当前宠物 ID
- 当前宠物位置
- 当前朝向
- 最近交互时间
- 上次选择的显示器 / 工作区信息摘要

## 14.4 pets/index.json

保存：
- 安装列表
- 版本
- 安装时间
- 来源路径
- 校验状态
- 缩略图路径

---

## 15. 错误处理与降级策略

## 15.1 错误分类

### A. 安装期错误
- 缺少资源文件
- 资源结构不合法
- 图像解码失败
- manifest / pet.json 解析失败

### B. 运行期错误
- clip 不存在
- 帧越界
- atlas 加载失败
- 设置写入失败
- 屏幕信息异常

## 15.2 降级原则

1. 单个资源包错误不影响整个应用启动
2. clip 缺失时优先降级到 `idle`
3. 语义角色无候选时，该行为不参与调度
4. 表面状态缺失时仍保留位置逻辑，不强求动画表现
5. 调试模式下明确显示降级原因

## 15.3 错误展示

- 安装失败：资源管理页 + toast
- 当前宠物加载失败：宠物窗口不显示，转为空态提示或回到宠物选择页
- 调试模式：展示 validation report 摘要

---

## 16. 性能设计

## 16.1 目标

- 启动后尽快显示宠物
- 长时间挂机 CPU 占用低
- 切换宠物无明显卡顿
- 不因频繁状态切换产生额外纹理重建

## 16.2 策略

### A. 资源缓存
- 安装期生成 runtime manifest cache
- atlas 纹理切片缓存于运行时内存

### B. 调度降频
- 调度器低频执行
- 渲染帧率与调度频率分离

### C. 避免高频 Rust 往返
- 位置与交互逻辑尽可能在前端运行时完成
- 只有设置和持久化才走 command

### D. 透明窗口优化
- 减少不必要的多层 DOM 覆盖
- Pixi 单 canvas 输出

---

## 17. 调试与可观测性

## 17.1 调试模式内容

建议在宠物窗口上提供可开关 overlay，显示：
- 当前控制状态
- 当前 clip key
- 当前 semantic role
- 当前 surface
- 调度器最近一次决策原因
- 当前 cooldown 列表
- 当前位置、朝向、缩放
- 当前资源 capabilities
- 当前降级情况

## 17.2 日志层级

### Rust
- `info`: 生命周期、安装、删除、窗口操作
- `warn`: 包字段缺失、回退安装
- `error`: 安装失败、文件写入失败、窗口初始化失败

### Frontend
- `info`: 资源加载、状态切换、调度切换
- `warn`: clip 缺失、fallback 触发
- `error`: atlas 加载失败、状态机异常

---

## 18. 测试策略

## 18.1 单元测试

### Rust
- 资源包路径与校验
- 安装索引读写
- screen/workarea 数据结构转换

### TypeScript
- legacy adapter
- manifest normalizer
- semantic role 映射
- scheduler 的候选选择 / cooldown / 优先级
- surface snap 计算

## 18.2 集成测试

- 导入旧资源包 -> 成功安装 -> 生成 runtime manifest
- 切换宠物 -> 新宠物正确加载
- 点击 / 双击 / 拖拽 -> 状态切换正确
- 关闭后重启 -> 位置与设置恢复

## 18.3 手工验收重点

- macOS 透明窗口表现
- Windows DPI 缩放
- 多显示器工作区边界
- 长时间挂机 CPU 占用
- 旧 hatch-pet 资源兼容性

---

## 19. 安全与权限边界

MVP 不涉及高敏感权限，但需要注意：

- 资源导入路径只做本地文件读取
- 不执行资源包中的脚本或动态代码
- SOUL.md 在 MVP 仅保留文件，不做执行逻辑
- 不申请麦克风等权限
- 不做窗口级环境感知权限申请

---

## 20. 里程碑与实施顺序

## 20.1 Milestone 1：基础壳与透明窗口

交付：
- Tauri 应用壳
- 宠物透明窗口
- 托盘
- 设置窗口骨架
- 本地路径初始化

## 20.2 Milestone 2：资源导入与兼容层

交付：
- 资源安装流程
- legacy / v2 格式识别
- runtime manifest cache
- 宠物库

## 20.3 Milestone 3：Pixi 渲染与 clip 播放

交付：
- atlas 加载
- clip 切片与播放
- 宠物基本显示
- 默认 idle 播放

## 20.4 Milestone 4：状态机与交互

交付：
- click / double click / drag / right click
- 状态机优先级与切换
- 伪状态 dragging / recovering

## 20.5 Milestone 5：自主行为与恢复策略

交付：
- inactivity tracker
- scheduler
- cooldown / weight / minDuration
- 打断与恢复

## 20.6 Milestone 6：屏幕边缘交互

交付：
- screen/workarea 接入
- 边缘吸附
- 越界修正
- 表面回退策略

## 20.7 Milestone 7：调试与验收

交付：
- 调试 overlay
- validation report 展示
- 跨平台验收清单

---

## 21. 面向 v0.2+ 的扩展设计

## 21.1 窗口边缘感知

新增：
- `WindowSurfaceProvider`
- 窗口矩形枚举
- 前台窗口追踪
- `windowAware` capability

运行时只需新增 surface provider，不需要推翻状态机与调度器。

## 21.2 丰富状态资源包

新增：
- `sleep`
- `doze`
- `eat`
- `groom`
- `observe`
- `edge-stand`
- `edge-walk`
- `fall`
- `land`

运行时只需补充 semantic role 候选和 behavior policy，不需要重构渲染层。

## 21.3 聊天 / ASR / TTS / SOUL / 记忆

建议新增独立模块：

```text
companion/
  chat-service.ts
  asr-provider.ts
  tts-provider.ts
  soul-loader.ts
  memory-store.ts
```

其和宠物运行时通过事件总线对接：
- `chat:open`
- `speech:start`
- `speech:end`
- `memory:updated`
- `persona:changed`

这样 companion 能力不会侵入 MVP 的桌宠播放器主体。

---

## 22. 关键设计结论

1. **MVP 本质上是一个桌宠运行时播放器，而不是宠物生成器**
2. **统一 Runtime Manifest 是整个架构的核心**
3. **状态机依赖语义角色，而不是硬编码旧状态名**
4. **MVP 自主行为用规则调度器即可，不引入行为树**
5. **MVP 只做屏幕边缘，不做窗口表面**
6. **平台差异收敛在 Rust/Tauri 层，前端运行时只做通用逻辑**
7. **通过 capability 和 adapter 机制，为后续 richer state 和 companion 能力留出扩展位**

---

## 23. 附录：MVP 推荐默认参数

```text
scheduler tick interval:       300ms
inactivity mild threshold:     15s
inactivity autonomous:         45s
edge snap distance:            24px
default click response max:    300ms 内启动
default scale:                 1.0
runtime state persist debounce: 500ms
```

---

## 24. 附录：MVP 术语表

- **Legacy Resource**：旧版 hatch-pet 产物，通常为 `pet.json + spritesheet.webp`
- **Package v2**：新版资源包格式，核心为 `manifest.json`
- **Runtime Manifest**：客户端内部统一资源模型
- **Clip**：一个可播放的动画片段
- **Semantic Role**：状态语义角色，如 idle / greet / moveLeft
- **Control State**：运行时控制状态，如 dragging / recovering
- **Surface**：宠物所处的表面语义，如 screen-bottom
- **Capability**：资源包能力声明，如 `surfaceAware`

