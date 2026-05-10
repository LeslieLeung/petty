import './styles.css'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { PetRuntime, type AgentBridgeDebugInfo, type AgentRuntimeState, type UserInputActivityPayload } from './pet-runtime/runtime'
import { petModels, type PetModelDefinition } from './pet-models'
import { applyLanguageMetadata, t, translateUserVisibleError, type LanguagePreference } from './i18n'
import type { LegacyPetJson } from './pet-runtime/resource/legacy-adapter'
import type { Rect } from './pet-runtime/surface/screen-surface'
import {
  createImportedModelDefinition,
  getImportedModelMetas,
  loadStoredModelDefinition,
  saveImportedModel,
  fileToDataUrl,
  buildImportedModelId,
  folderNameFromFile,
  findFileInList,
  type ImportedModelMeta,
} from './model-store'

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('Missing #app root')
const appRoot = root
applyLanguageMetadata('Petty')

// Runtime-imported models (context menu, this session only) are supplemented by
// stored models (localStorage) which persist across sessions.
const runtimeImportedModels: PetModelDefinition[] = []

const SCALE_OPTIONS = [
  { value: 0.5, labelKey: 'settings.appearance.scale.normal' },
  { value: 0.75, labelKey: 'settings.appearance.scale.large' },
  { value: 1, labelKey: 'settings.appearance.scale.xlarge' },
] as const
const ACTIVE_MODEL_KEY = 'petty.active-model'
const DEBUG_VISIBLE_KEY = 'petty.debug-visible'
const ZOOM_KEY = 'petty.zoom'
const KEEP_VISUAL_SIZE_KEY = 'petty.keep-visual-size-across-displays'
const HOST_STARTUP_IPC_DELAY_MS = 300

let activeModel = resolveModel(localStorage.getItem(ACTIVE_MODEL_KEY) ?? 'hana')
// `runtime` is guaranteed to be assigned before any event listener can use it (inside startApp).
// eslint-disable-next-line prefer-const
let runtime!: PetRuntime
// Monitor rects in CSS pixels relative to the window origin (populated in Tauri mode).
let cachedMonitors: Rect[] = []
let refreshMonitorsTimer: ReturnType<typeof setTimeout> | null = null
let startDeferredClickThroughPolling: (() => void) | undefined

async function refreshMonitorsFromHost(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return
  try {
    await invoke('fit_pet_window_to_current_screen')
  } catch (error) {
    console.warn('[petty] fit_pet_window_to_current_screen failed', error)
  }
  try {
    cachedMonitors = await invoke<Rect[]>('get_monitors')
    runtime?.setMonitors(cachedMonitors.length > 0 ? cachedMonitors : undefined)
    console.log('[petty] monitors refreshed:', cachedMonitors)
  } catch (error) {
    console.warn('[petty] get_monitors failed on refresh', error)
  }
}

function scheduleRefreshMonitors(): void {
  if (refreshMonitorsTimer != null) clearTimeout(refreshMonitorsTimer)
  refreshMonitorsTimer = setTimeout(() => {
    refreshMonitorsTimer = null
    void refreshMonitorsFromHost()
  }, 120)
}
let debugVisible = getInitialDebugVisible()
let petScale: number = Number.parseFloat(localStorage.getItem(ZOOM_KEY) ?? '0.5')
let keepVisualSizeAcrossDisplays = getInitialKeepVisualSizeAcrossDisplays()
let isSwitchingModel = false
let pendingSwitchModelId: string | null = null

interface ImportedModelSwitchPayload {
  id: string
  meta: ImportedModelMeta
  petJson: LegacyPetJson
  spritesheetDataUrl: string
}

type SwitchModelPayload = string | ImportedModelSwitchPayload

interface HostCursorSnapshot {
  cursorX: number
  cursorY: number
  monitors: Rect[]
}

type BridgeTopState = 'idle' | 'thinking' | 'working' | 'awaitingApproval' | 'error'
type AgentStateHint = 'thinking' | 'working' | 'editing' | 'running' | 'testing' | 'waiting' | 'success' | 'error' | 'idle'
type AgentKind = 'codex' | 'claude-code' | 'opencode' | 'custom'

interface ApprovalView {
  requestId: string
  agentKind: AgentKind
  adapterId: string
  sessionId: string
  turnId?: string
  cwd?: string
  project?: string
  toolName?: string
  summary?: string
  reason?: string
  requestedAt: number
}

interface AgentStateSnapshot {
  agent: string
  isActive: boolean
  activeTurnCount: number
  pendingApprovalCount: number
  topState: BridgeTopState
  topStateHint: AgentStateHint
  activeApproval?: ApprovalView
  recentCompletedTurn?: CompletedTurnView
  sessions: AgentSessionView[]
}

interface AgentSessionView {
  agentKind: AgentKind
  adapterId: string
  sessionId: string
  cwd?: string
  activeTurns: AgentTurnView[]
}

interface AgentTurnView {
  turnId: string
  status: AgentStateHint
  latestToolName?: string
  latestSummary?: string
}

interface CompletedTurnView {
  agentKind: AgentKind
  adapterId: string
  sessionId: string
  turnId: string
  cwd?: string
  latestToolName?: string
  latestSummary?: string
  completedAt: number
  visibleUntil: number
}

interface AgentBridgeInfo {
  host: string
  port: number
  configPath: string
}

function getInitialDebugVisible(): boolean {
  const stored = localStorage.getItem(DEBUG_VISIBLE_KEY)
  if (stored !== null) return stored === 'true'
  return import.meta.env.DEV
}

function getInitialKeepVisualSizeAcrossDisplays(): boolean {
  const stored = localStorage.getItem(KEEP_VISUAL_SIZE_KEY)
  return stored === null ? true : stored === 'true'
}

document.addEventListener('contextmenu', (event) => event.preventDefault())

const menu = createContextMenu()
appRoot.appendChild(menu.element)
const agentTaskBubble = createAgentTaskBubble(resetExpiredCompletedAgentState)
appRoot.appendChild(agentTaskBubble.element)
let latestAgentBridgeInfo: AgentBridgeInfo | undefined
let latestAgentSnapshot: AgentStateSnapshot | undefined

function updateScaleMenuItems(): void {
  menu.updateScaleItems()
}

// Load any previously stored imported models into the active-model resolution
// chain so they're available immediately on startup.
getImportedModelMetas().forEach(({ id }) => {
  const def = loadStoredModelDefinition(id)
  if (def) runtimeImportedModels.push(def)
})

startApp().catch(renderStartupError)

window.addEventListener('beforeunload', () => runtime.destroy())
window.addEventListener('pointerdown', (event) => {
  const target = event.target
  if (!(target instanceof Node)) return
  if (!menu.element.contains(target)) menu.hide()
})
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') menu.hide()
})

if ('__TAURI_INTERNALS__' in window) {
  window.addEventListener('resize', scheduleRefreshMonitors)
  listen<SwitchModelPayload>('switch-model', (event) => {
    handleSwitchModelEvent(event.payload).catch(renderStartupError)
  }).catch(console.error)
  listen<number>('change-scale', (event) => {
    applyScale(event.payload)
    updateScaleMenuItems()
  }).catch(console.error)
  listen<boolean>('change-visual-size-lock', (event) => {
    applyVisualSizeLock(event.payload)
  }).catch(console.error)
  listen<LanguagePreference>('language-changed', () => {
    applyLanguageMetadata('Petty')
    menu.updateLabels()
    if (latestAgentSnapshot) applyAgentSnapshot(latestAgentSnapshot)
  }).catch(console.error)
  listen<UserInputActivityPayload>('user-input-activity', (event) => {
    runtime?.notifyKeyboardActivity(event.payload)
  }).catch(console.error)
  listen<AgentStateSnapshot>('agent-state-changed', (event) => {
    applyAgentSnapshot(event.payload)
  }).catch(console.error)
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function startApp(): Promise<void> {
  runtime = createRuntime(activeModel)
  await mountRuntime()
  if ('__TAURI_INTERNALS__' in window) {
    // Avoid hitting Tauri's WKURLSchemeHandler/IPC path while WebKit is still
    // finishing the initial document and asset loads. Intel WebKit is notably
    // easier to crash here if startup IPC races with custom protocol tasks.
    window.setTimeout(() => {
      void refreshMonitorsFromHost()
      invoke<AgentBridgeInfo>('get_agent_bridge_info')
        .then((info) => {
          latestAgentBridgeInfo = info
          applyAgentBridgeDebug()
        })
        .catch(console.warn)
      invoke<AgentStateSnapshot>('get_agent_bridge_state')
        .then(applyAgentSnapshot)
        .catch(console.warn)
      startDeferredClickThroughPolling?.()
    }, HOST_STARTUP_IPC_DELAY_MS)
  }
}

function applyAgentSnapshot(snapshot: AgentStateSnapshot): void {
  latestAgentSnapshot = snapshot
  runtime?.setAgentState(agentRuntimeState(snapshot))
  applyAgentBridgeDebug()
  agentTaskBubble.update(snapshot)
}

function applyAgentBridgeDebug(): void {
  if (!latestAgentSnapshot) return
  runtime?.setAgentBridgeDebug(agentBridgeDebugInfo(latestAgentSnapshot, latestAgentBridgeInfo))
}

function agentBridgeDebugInfo(snapshot: AgentStateSnapshot, info: AgentBridgeInfo | undefined): AgentBridgeDebugInfo {
  return {
    host: info?.host,
    port: info?.port,
    configPath: info?.configPath,
    isActive: snapshot.isActive,
    activeTurnCount: snapshot.activeTurnCount,
    pendingApprovalCount: snapshot.pendingApprovalCount,
    topState: snapshot.topState,
    topStateHint: snapshot.topStateHint,
    sessions: snapshot.sessions,
  }
}

function agentRuntimeState(snapshot: AgentStateSnapshot): AgentRuntimeState {
  if (snapshot.topState === 'awaitingApproval') return 'waiting'
  if (snapshot.topState === 'error' || snapshot.topStateHint === 'error') return 'error'
  if (snapshot.topStateHint === 'success' && snapshot.recentCompletedTurn && snapshot.recentCompletedTurn.visibleUntil > Date.now()) return 'success'
  if (snapshot.topState === 'thinking') return 'thinking'
  if (snapshot.topState === 'working') return 'working'
  return 'idle'
}

function resetExpiredCompletedAgentState(): void {
  const snapshot = latestAgentSnapshot
  const completed = snapshot?.recentCompletedTurn
  if (!snapshot || !completed) return
  if (snapshot.isActive || snapshot.activeApproval) return
  if (completed.visibleUntil > Date.now()) return
  runtime?.setAgentState('idle')
}

// ── Model resolution ──────────────────────────────────────────────────────────

/** Resolve a model ID to a PetModelDefinition, checking all sources. */
function resolveModel(id: string): PetModelDefinition {
  // 1. Runtime-imported (this session)
  const rt = runtimeImportedModels.find((m) => m.id === id)
  if (rt) return rt

  // 2. Built-in
  const builtin = petModels.find((m) => m.id === id)
  if (builtin) return builtin

  // 3. Persisted in localStorage
  if (id.startsWith('imported:')) {
    const stored = loadStoredModelDefinition(id)
    if (stored) {
      runtimeImportedModels.push(stored) // cache so manifest is created only once
      return stored
    }
  }

  // Fallback
  return petModels[0]
}

function createRuntime(model: PetModelDefinition): PetRuntime {
  return new PetRuntime(model.createManifest(), {
    onContextMenu: ({ x, y }) => menu.show(x, y),
    monitors: cachedMonitors.length > 0 ? cachedMonitors : undefined,
    keepVisualSizeAcrossDisplays,
    refreshHostMonitorLayout: () => scheduleRefreshMonitors(),
    trackHostCursorScreen: async () => {
      const snapshot = await invoke<HostCursorSnapshot | null>('follow_pet_window_to_cursor_screen')
      if (!snapshot) return null
      cachedMonitors = snapshot.monitors
      return {
        x: snapshot.cursorX,
        y: snapshot.cursorY,
        monitors: snapshot.monitors,
      }
    },
  })
}

async function handleSwitchModelEvent(payload: SwitchModelPayload): Promise<void> {
  if (typeof payload === 'string') {
    await switchModel(payload)
    return
  }

  saveImportedModel(payload.meta, payload.petJson, payload.spritesheetDataUrl)
  registerRuntimeImportedModel(
    createImportedModelDefinition(payload.meta, payload.petJson, payload.spritesheetDataUrl),
  )
  await switchModel(payload.id)
}

function registerRuntimeImportedModel(model: PetModelDefinition): void {
  const index = runtimeImportedModels.findIndex((existing) => existing.id === model.id)
  if (index >= 0) runtimeImportedModels[index] = model
  else runtimeImportedModels.push(model)
}

async function mountRuntime(): Promise<void> {
  await runtime.mount(appRoot)
  runtime.setDebugVisible(debugVisible)
  runtime.setKeepVisualSizeAcrossDisplays(keepVisualSizeAcrossDisplays)
  runtime.setScale(petScale)
  applyAgentBridgeDebug()
  if (latestAgentSnapshot) applyAgentSnapshot(latestAgentSnapshot)
}

function applyScale(scale: number): void {
  petScale = scale
  localStorage.setItem(ZOOM_KEY, String(scale))
  runtime.setScale(scale)
  if ('__TAURI_INTERNALS__' in window) {
    emit('scale-changed', scale).catch(console.error)
  }
}

function applyVisualSizeLock(enabled: boolean): void {
  keepVisualSizeAcrossDisplays = enabled
  localStorage.setItem(KEEP_VISUAL_SIZE_KEY, String(enabled))
  runtime.setKeepVisualSizeAcrossDisplays(enabled)
  if ('__TAURI_INTERNALS__' in window) {
    emit('visual-size-lock-changed', enabled).catch(console.error)
  }
}

async function switchModel(modelId: string): Promise<void> {
  if (isSwitchingModel) {
    pendingSwitchModelId = modelId
    return
  }

  const nextModel = resolveModel(modelId)
  if (nextModel.id === activeModel.id) return

  isSwitchingModel = true
  try {
    menu.hide()
    activeModel = nextModel
    localStorage.setItem(ACTIVE_MODEL_KEY, activeModel.id)
    runtime.destroy()
    runtime = createRuntime(activeModel)
    await mountRuntime()
    if ('__TAURI_INTERNALS__' in globalThis) {
      emit('model-changed', activeModel.id).catch(console.error)
    }
  } finally {
    isSwitchingModel = false
    const next = pendingSwitchModelId
    pendingSwitchModelId = null
    if (next) switchModel(next).catch(renderStartupError)
  }
}

// ── Error fallback ────────────────────────────────────────────────────────────

function renderStartupError(error: unknown): void {
  console.error(error)
  appRoot.innerHTML = `
    <div class="fallback">
      <strong>${t('error.startup')}</strong><br />
      ${error instanceof Error ? error.message : String(error)}
    </div>
  `
}

// ── Context menu ──────────────────────────────────────────────────────────────

function createContextMenu(): { element: HTMLDivElement; show: (x: number, y: number) => void; hide: () => void; updateScaleItems: () => void; updateLabels: () => void } {
  const element = document.createElement('div')
  element.className = 'context-menu'
  element.hidden = true
  element.innerHTML = `
    <button type="button" data-action="settings"></button>
    <button type="button" data-action="import-folder"></button>
    <div class="context-menu-separator"></div>
    <div class="context-menu-section-label" data-label="size"></div>
    <div class="context-menu-scale-row">
      ${SCALE_OPTIONS.map((s) => `<button type="button" class="context-menu-scale-btn" data-action="scale" data-scale="${s.value}">${t(s.labelKey)}</button>`).join('')}
    </div>
    <div class="context-menu-separator"></div>
    <button type="button" data-action="toggle-debug"></button>
    <div class="context-menu-separator"></div>
    <button type="button" data-action="quit" class="context-menu-danger"></button>
  `

  const directoryInput = document.createElement('input')
  directoryInput.type = 'file'
  directoryInput.multiple = true
  directoryInput.hidden = true
  directoryInput.setAttribute('webkitdirectory', '')
  directoryInput.setAttribute('directory', '')
  element.appendChild(directoryInput)

  directoryInput.addEventListener('change', () => {
    importFolder(directoryInput.files).catch((error: unknown) => {
      console.error(error)
      window.alert(translateUserVisibleError(error))
    })
    directoryInput.value = ''
  })

  element.addEventListener('pointerdown', (event) => event.stopPropagation())
  element.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const action = target.dataset.action
    if (action === 'settings') {
      element.hidden = true
      openSettingsWindow()
    }
    if (action === 'import-folder') {
      element.hidden = true
      directoryInput.click()
    }
    if (action === 'scale') {
      const scale = Number.parseFloat(target.dataset.scale!)
      if (!Number.isNaN(scale)) {
        applyScale(scale)
        updateScaleMenuItems()
      }
      element.hidden = true
    }
    if (action === 'toggle-debug') {
      debugVisible = !debugVisible
      localStorage.setItem(DEBUG_VISIBLE_KEY, String(debugVisible))
      runtime.setDebugVisible(debugVisible)
      element.hidden = true
    }
    if (action === 'quit') {
      element.hidden = true
      invoke('quit_app').catch(console.error)
    }
  })

  function updateScaleItems(): void {
    element.querySelectorAll<HTMLElement>('[data-action="scale"]').forEach((btn) => {
      btn.classList.toggle('is-active', Number.parseFloat(btn.dataset.scale!) === petScale)
    })
  }

  function updateLabels(): void {
    const settings = element.querySelector<HTMLElement>('[data-action="settings"]')
    const importFolder = element.querySelector<HTMLElement>('[data-action="import-folder"]')
    const size = element.querySelector<HTMLElement>('[data-label="size"]')
    const toggleDebug = element.querySelector<HTMLElement>('[data-action="toggle-debug"]')
    const quit = element.querySelector<HTMLElement>('[data-action="quit"]')
    if (settings) settings.textContent = t('context.settings')
    if (importFolder) importFolder.textContent = t('context.loadCustomModel')
    if (size) size.textContent = t('context.size')
    if (toggleDebug) toggleDebug.textContent = t('context.toggleDebug')
    if (quit) quit.textContent = t('context.quit')
  }

  updateLabels()

  return {
    element,
    show(x, y) {
      updateScaleItems()
      element.hidden = false
      requestAnimationFrame(() => {
        const width = element.offsetWidth
        const height = element.offsetHeight
        element.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`
        element.style.top = `${Math.min(y, window.innerHeight - height - 8)}px`
      })
    },
    hide() {
      element.hidden = true
    },
    updateScaleItems,
    updateLabels,
  }
}

function openSettingsWindow(): void {
  if (!('__TAURI_INTERNALS__' in window)) return
  invoke('open_settings_window').catch((error: unknown) => {
    console.warn('Failed to open settings window', error)
  })
}

function createAgentTaskBubble(onCompletedHidden: () => void): {
  element: HTMLDivElement
  update: (snapshot: AgentStateSnapshot) => void
  hide: () => void
  hitTest: (x: number, y: number) => boolean
} {
  const element = document.createElement('div')
  element.className = 'agent-task-bubble'
  element.hidden = true

  let lastText = ''
  let activeRequestId: string | null = null
  let positionFrame: number | null = null
  let completionHideTimer: number | null = null

  element.addEventListener('pointerdown', (event) => event.stopPropagation())
  element.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const decision = target.dataset.decision
    if (!decision || !activeRequestId) return
    invoke<AgentStateSnapshot>('decide_agent_approval', {
      requestId: activeRequestId,
      decision,
    })
      .then(applyAgentSnapshot)
      .catch((error) => console.warn('[petty] approval decision failed', error))
  })

  function render(task: AgentTaskView): void {
    const tasks = task.sessions ?? [task]
    const textKey = tasks
      .map((item) => `${item.title}\n${item.meta.join('\n')}\n${item.summary}\n${item.approvalRequestId ?? ''}`)
      .join('\n')
    if (textKey === lastText) return
    lastText = textKey
    element.innerHTML = `
      ${tasks.map((item) => `
        <div class="agent-task-bubble-task">
          <div class="agent-task-bubble-title">${escapeHtml(item.title)}</div>
          <div class="agent-task-bubble-meta">
            ${item.meta.map((meta) => `<span>${escapeHtml(meta)}</span>`).join('')}
          </div>
          <div class="agent-task-bubble-summary">${escapeHtml(item.summary)}</div>
          ${item.approvalRequestId ? `
            <div class="agent-task-bubble-actions">
              <button type="button" data-decision="deny" class="agent-task-bubble-btn agent-task-bubble-btn-deny">${escapeHtml(t('agent.approval.deny'))}</button>
              <button type="button" data-decision="approve" class="agent-task-bubble-btn agent-task-bubble-btn-approve">${escapeHtml(t('agent.approval.allow'))}</button>
            </div>
          ` : ''}
        </div>
      `).join('')}
    `
  }

  function schedulePosition(): void {
    if (positionFrame !== null) return
    positionFrame = requestAnimationFrame(() => {
      positionFrame = null
      if (element.hidden) return
      positionAgentTaskBubble(element)
      schedulePosition()
    })
  }

  return {
    element,
    update(snapshot) {
      if (completionHideTimer !== null) {
        window.clearTimeout(completionHideTimer)
        completionHideTimer = null
      }
      const task = agentTaskView(snapshot)
      if (!task) {
        this.hide()
        return
      }
      activeRequestId = task.approvalRequestId ?? null
      render(task)
      element.classList.toggle('is-interactive', Boolean(activeRequestId))
      element.hidden = false
      schedulePosition()
      if (task.visibleUntil) {
        const delay = Math.max(0, task.visibleUntil - Date.now())
        completionHideTimer = window.setTimeout(() => {
          this.hide()
          onCompletedHidden()
        }, delay)
      }
    },
    hide() {
      element.hidden = true
      lastText = ''
      activeRequestId = null
      element.classList.remove('is-interactive')
      if (completionHideTimer !== null) {
        window.clearTimeout(completionHideTimer)
        completionHideTimer = null
      }
      if (positionFrame !== null) {
        cancelAnimationFrame(positionFrame)
        positionFrame = null
      }
    },
    hitTest(x, y) {
      if (element.hidden || !activeRequestId) return false
      const rect = element.getBoundingClientRect()
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    },
  }
}

interface AgentTaskView {
  title: string
  meta: string[]
  summary: string
  approvalRequestId?: string
  sessions?: AgentSessionTaskView[]
  visibleUntil?: number
}

interface AgentSessionTaskView {
  title: string
  meta: string[]
  summary: string
  approvalRequestId?: string
}

function agentTaskView(snapshot: AgentStateSnapshot): AgentTaskView | null {
  if (snapshot.activeApproval) return approvalTaskView(snapshot.activeApproval)
  if ((!snapshot.isActive || snapshot.topState === 'idle') && snapshot.recentCompletedTurn) {
    return completedTaskView(snapshot.recentCompletedTurn)
  }
  if (!snapshot.isActive || snapshot.topState === 'idle') return null

  const activeSessions = activeAgentSessions(snapshot)
  const turn = activeAgentTurn(snapshot)
  const session = turn?.session ?? snapshot.sessions[0]
  const agent = session ? agentDisplayName(session.agentKind) : 'Agent'
  const project = session?.cwd?.split(/[\\/]/).filter(Boolean).at(-1)
  const tool = turn?.turn.latestToolName
  const rawSummary = turn?.turn.latestSummary
  const state = displayAgentState(turn?.turn.status ?? snapshot.topStateHint, tool, rawSummary)
  const summary = taskSummary(tool, turn?.turn.latestSummary, state)
  const meta = [toolDisplayName(tool, rawSummary), project].filter((item): item is string => Boolean(item))

  return {
    title: `${agent} ${agentStateLabel(state)}`,
    meta,
    summary,
    sessions: activeSessions.length > 1 ? activeSessions.map(agentSessionTaskView) : undefined,
  }
}

function approvalTaskView(approval: ApprovalView): AgentTaskView {
  const agent = agentDisplayName(approval.agentKind)
  const project = approval.project ?? approval.cwd?.split(/[\\/]/).filter(Boolean).at(-1)
  const tool = toolDisplayName(approval.toolName) ?? t('agent.tool.action')

  return {
    title: t('agent.approval.title', { agent }),
    meta: [tool, project].filter((item): item is string => Boolean(item)),
    summary: approvalSummary(approval, agent),
    approvalRequestId: approval.requestId,
  }
}

function completedTaskView(turn: CompletedTurnView): AgentTaskView | null {
  if (turn.visibleUntil <= Date.now()) return null

  const agent = agentDisplayName(turn.agentKind)
  const project = turn.cwd?.split(/[\\/]/).filter(Boolean).at(-1)
  const summary = completionSummary(turn.latestSummary)
  const meta = [toolDisplayName(turn.latestToolName, turn.latestSummary), project].filter((item): item is string => Boolean(item))

  return {
    title: `${agent} ${agentStateLabel('success')}`,
    meta,
    summary,
    visibleUntil: turn.visibleUntil,
  }
}

function isReadTool(toolName: string | undefined): boolean {
  const tool = toolName?.toLowerCase() ?? ''
  return tool.includes('read') || tool.includes('open') || tool.includes('view') || tool.includes('cat')
}

function displayAgentState(state: AgentStateHint, toolName: string | undefined, rawSummary: string | undefined): AgentStateHint {
  const tool = toolName?.toLowerCase() ?? ''
  const normalized = normalizeSummary(rawSummary)
  if (isReadFileSummary(normalized)) return 'working'
  if (!isReadTool(toolName) && !isReadFileSummary(normalized) && filePathFromSummary(normalized)) return 'editing'

  if (tool.includes('apply_patch') || tool.includes('edit') || tool.includes('write')) return 'editing'
  if (tool.includes('test')) return 'testing'

  return state
}

function activeAgentTurn(snapshot: AgentStateSnapshot): { session: AgentSessionView; turn: AgentTurnView } | undefined {
  const turns = snapshot.sessions.flatMap((session) => session.activeTurns.map((turn) => ({ session, turn })))
  return turns[0]
}

function activeAgentSessions(snapshot: AgentStateSnapshot): { session: AgentSessionView; turn: AgentTurnView }[] {
  return snapshot.sessions
    .map((session) => {
      const turn = session.activeTurns[0]
      return turn ? { session, turn } : undefined
    })
    .filter((item): item is { session: AgentSessionView; turn: AgentTurnView } => Boolean(item))
}

function agentSessionTaskView(item: { session: AgentSessionView; turn: AgentTurnView }): AgentSessionTaskView {
  const agent = agentDisplayName(item.session.agentKind)
  const project = item.session.cwd?.split(/[\\/]/).filter(Boolean).at(-1)
  const tool = item.turn.latestToolName
  const rawSummary = item.turn.latestSummary
  const state = displayAgentState(item.turn.status, tool, rawSummary)
  const meta = [toolDisplayName(tool, rawSummary), project].filter((value): value is string => Boolean(value))

  return {
    title: `${agent} ${agentStateLabel(state)}`,
    meta,
    summary: taskSummary(tool, rawSummary, state),
  }
}

function agentDisplayName(agentKind: AgentKind): string {
  if (agentKind === 'codex') return t('agent.name.codex')
  if (agentKind === 'claude-code') return t('agent.name.claudeCode')
  if (agentKind === 'opencode') return t('agent.name.opencode')
  return t('agent.name.generic')
}

function agentStateLabel(state: AgentStateHint): string {
  switch (state) {
    case 'thinking':
      return t('agent.state.thinking')
    case 'editing':
      return t('agent.state.editing')
    case 'running':
      return t('agent.state.running')
    case 'testing':
      return t('agent.state.testing')
    case 'waiting':
      return t('agent.state.waiting')
    case 'success':
      return t('agent.state.success')
    case 'error':
      return t('agent.state.error')
    case 'working':
      return t('agent.state.working')
    case 'idle':
      return t('agent.state.idle')
  }
}

function taskFallbackSummary(state: AgentStateHint): string {
  switch (state) {
    case 'thinking':
      return t('agent.summary.thinking')
    case 'editing':
      return t('agent.summary.editing')
    case 'running':
      return t('agent.summary.running')
    case 'testing':
      return t('agent.summary.testing')
    case 'waiting':
      return t('agent.summary.waiting')
    case 'success':
      return t('agent.summary.success')
    case 'error':
      return t('agent.summary.error')
    case 'working':
      return t('agent.summary.working')
    case 'idle':
      return t('agent.summary.idle')
  }
}

function taskSummary(toolName: string | undefined, rawSummary: string | undefined, state: AgentStateHint): string {
  const normalized = normalizeSummary(rawSummary)
  const file = filePathFromSummary(normalized)
  if (file && (isReadTool(toolName) || isReadFileSummary(normalized))) {
    const summary = t('agent.summary.readingFile', { file })
    debugAgentText('taskSummary:file:read', { toolName, rawSummary, normalized, file, summary })
    return summary
  }
  if (file) {
    const summary = t('agent.summary.editingFile', { file })
    debugAgentText('taskSummary:file:edit', { toolName, rawSummary, normalized, file, summary })
    return summary
  }
  const fromCommand = summaryFromCommand(normalized)
  if (fromCommand) {
    debugAgentText('taskSummary:command', { toolName, rawSummary, normalized, summary: fromCommand })
    return fromCommand
  }

  const tool = toolName?.toLowerCase() ?? ''
  if (tool.includes('apply_patch') || tool.includes('edit') || tool.includes('write')) return debugAgentSummary('taskSummary:tool:edit', t('agent.summary.editing'), { toolName, rawSummary, normalized })
  if (tool.includes('search') || tool.includes('grep')) return debugAgentSummary('taskSummary:tool:search', t('agent.summary.search'), { toolName, rawSummary, normalized })
  if (tool.includes('read') || tool.includes('open')) return debugAgentSummary('taskSummary:tool:read', t('agent.summary.readFile'), { toolName, rawSummary, normalized })
  if (tool.includes('browser')) return debugAgentSummary('taskSummary:tool:browser', t('agent.summary.browser'), { toolName, rawSummary, normalized })

  if (normalized && !looksLikeInternalId(normalized)) return debugAgentSummary('taskSummary:raw', humanizeSummary(normalized), { toolName, rawSummary, normalized })
  return debugAgentSummary('taskSummary:fallback', taskFallbackSummary(state), { toolName, rawSummary, normalized, state })
}

function completionSummary(rawSummary: string | undefined): string {
  const normalized = normalizeSummary(rawSummary)
  const file = filePathFromSummary(normalized)
  if (file && isReadFileSummary(normalized)) {
    return debugAgentSummary('completionSummary:file:read', t('agent.summary.readingFile', { file }), { rawSummary, normalized, file })
  }
  if (file) {
    return debugAgentSummary('completionSummary:file:edit', t('agent.summary.editingFile', { file }), { rawSummary, normalized, file })
  }

  const fromCommand = summaryFromCommand(normalized)
  if (fromCommand) return debugAgentSummary('completionSummary:command', fromCommand, { rawSummary, normalized })

  return debugAgentSummary('completionSummary:fallback', taskFallbackSummary('success'), { rawSummary, normalized })
}

function debugAgentSummary(source: string, summary: string, detail: Record<string, unknown>): string {
  debugAgentText(source, { ...detail, summary })
  return summary
}

function debugAgentText(source: string, detail: Record<string, unknown>): void {
  console.debug('[petty-agent-text]', source, detail)
}

function toolDisplayName(toolName: string | undefined, rawSummary?: string): string | undefined {
  const normalized = normalizeSummary(rawSummary)
  if (isReadFileSummary(normalized)) return t('agent.tool.read')
  if (filePathFromSummary(normalized)) return t('agent.tool.edit')

  const tool = toolName?.trim()
  if (!tool) return undefined
  const lower = tool.toLowerCase()
  if (lower.includes('apply_patch')) return t('agent.tool.edit')
  if (lower.includes('exec') || lower.includes('bash') || lower.includes('shell')) return t('agent.tool.command')
  if (lower.includes('search') || lower.includes('grep')) return t('agent.tool.search')
  if (lower.includes('read') || lower.includes('open')) return t('agent.tool.read')
  if (lower.includes('browser')) return t('agent.tool.browser')
  return tool.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function normalizeSummary(value: string | undefined): string | undefined {
  const summary = value?.trim().replace(/\s+/g, ' ')
  if (!summary) return undefined
  return summary.replace(/^["'`]+|["'`]+$/g, '')
}

function humanizeSummary(value: string): string {
  if (value.length <= 72) return value
  return `${value.slice(0, 69).trimEnd()}...`
}

function looksLikeInternalId(value: string): boolean {
  return /^[a-z]+[-_][a-z0-9_-]{12,}$/i.test(value) || /^call_[a-z0-9_-]+$/i.test(value)
}

function filePathFromSummary(value: string | undefined): string | undefined {
  const path = rawFilePathFromSummary(value)
  if (!path) return undefined
  return compactPath(path)
}

function rawFilePathFromSummary(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (value.startsWith('file:')) return value.slice('file:'.length).trim()
  if (value.startsWith('read-file:')) return value.slice('read-file:'.length).trim()

  const editingMatch = value.match(/\b(?:Editing|Edited|Updating|Updated|Writing|Wrote)\s+([^\s,]+(?:\.[a-z0-9]+)?)/i)
  if (editingMatch?.[1]) return stripFileToken(editingMatch[1])

  const patchMatch = value.match(/\*\*\*\s+(?:Update|Add|Delete) File:\s+(.+?)(?:\s|$)/i)
  if (patchMatch?.[1]) return stripFileToken(patchMatch[1])

  return undefined
}

function isReadFileSummary(value: string | undefined): boolean {
  return value?.startsWith('read-file:') ?? false
}

function stripFileToken(value: string): string {
  return value
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[,:;.)\]]+$/g, '')
    .trim()
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return path
  return parts.slice(-2).join('/')
}

function summaryFromCommand(value: string | undefined): string | undefined {
  if (!value) return undefined
  const command = value.trim()
  const lower = command.toLowerCase()

  if (lower.includes('npm run build') || lower.includes('vite build') || lower.includes('tsc')) return t('agent.summary.build')
  if (lower.includes('npm run tauri:dev')) return t('agent.summary.tauriDev')
  if (lower.includes('npm run dev')) return t('agent.summary.devServer')
  if (lower.includes('cargo test')) return t('agent.summary.rustTests')
  if (lower.includes('go test') || lower.includes('pytest') || lower.includes('vitest')) return t('agent.summary.tests')
  if (lower.startsWith('git diff')) return t('agent.summary.gitDiff')
  if (lower.startsWith('git status')) return t('agent.summary.gitStatus')
  if (lower.startsWith('git ')) return t('agent.summary.git')
  if (lower.startsWith('rg ') || lower.includes(' ripgrep ')) return t('agent.summary.search')
  if (lower.startsWith('sed ') || lower.startsWith('nl ') || lower.startsWith('cat ')) return t('agent.summary.readFile')
  if (lower.startsWith('ls ') || lower === 'ls') return t('agent.summary.listFiles')

  if (/^(npm|pnpm|yarn|cargo|go|uv|npx)\b/.test(lower)) return t('agent.summary.projectCommand')
  if (/^(curl|stary-cli|gh)\b/.test(lower)) return t('agent.summary.externalTool')
  return undefined
}

function positionAgentTaskBubble(element: HTMLElement): void {
  if (!runtime) return
  const pet = runtime.visualBounds()
  const gap = 8
  const left = Math.max(12, Math.min(window.innerWidth - element.offsetWidth - 12, pet.x + pet.width / 2 - element.offsetWidth / 2))
  let top = pet.y - element.offsetHeight - gap
  const isBelow = top < 12
  if (isBelow) top = Math.min(window.innerHeight - element.offsetHeight - 12, pet.y + pet.height + gap)
  element.classList.toggle('is-below-pet', isBelow)
  element.style.left = `${left}px`
  element.style.top = `${Math.max(12, top)}px`
}

function approvalSummary(approval: ApprovalView, agent: string): string {
  const summary = taskSummary(approval.toolName, approval.summary ?? approval.reason, 'waiting')
  if (summary !== taskFallbackSummary('waiting')) return summary

  const tool = approval.toolName?.toLowerCase() ?? ''
  if (tool.includes('bash') || tool.includes('shell') || tool.includes('exec')) return t('agent.approval.command', { agent })
  if (tool.includes('apply_patch') || tool.includes('edit') || tool.includes('write')) return t('agent.approval.edit', { agent })
  return t('agent.approval.generic', { agent })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

// ── Folder import (shared with context menu) ──────────────────────────────────

async function importFolder(files: FileList | null): Promise<void> {
  if (!files || files.length === 0) return

  const fileArray = Array.from(files)
  const petJsonFile = findFileInList(fileArray, 'pet.json')
  const spritesheetFile = findFileInList(fileArray, 'spritesheet.webp')

  if (!petJsonFile || !spritesheetFile) {
    throw new Error(t('error.selectedFolderMissing'))
  }

  const petJson = JSON.parse(await petJsonFile.text()) as LegacyPetJson
  const spritesheetDataUrl = await fileToDataUrl(spritesheetFile)
  const folder = folderNameFromFile(petJsonFile) || t('model.importedPetName')
  const id = buildImportedModelId(petJson, folder)

  const meta: ImportedModelMeta = {
    id,
    name: petJson.displayName ?? petJson.name ?? petJson.id ?? folder,
    description: petJson.description ?? t('model.importedFrom', { folder }),
  }

  // Persist so settings window and future sessions can see it
  saveImportedModel(meta, petJson, spritesheetDataUrl)

  await switchModel(id)
}

// ── Click-through management (Tauri only) ────────────────────────────────────
// The pet window covers all monitors (transparent overlay). Transparent areas
// pass mouse events to underlying windows; only the pet sprite is interactive.
//
// Strategy:
//  - Default: ignoreMouseEvents = true (full click-through across all monitors)
//  - Poll cursor CSS position (works even when ignoring events — OS-level query)
//    and check against the pet sprite's rendered bounds via PixiJS hit-test.
//  - On hit: disable ignore → cursor events flow in, mousemove handles fine control.
//  - When cursor leaves pet sprite (and menu is closed): re-enable ignore + poll.

if ('__TAURI_INTERNALS__' in window) {
  // Rust setup already enables click-through before the page loads. Start in
  // sync with that state so we do not need an immediate startup invoke.
  let isClickThrough = true
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function enableClickThrough(): void {
    if (isClickThrough) return
    isClickThrough = true
    invoke('set_cursor_ignore', { ignore: true }).catch(console.error)
    startPolling()
  }

  function disableClickThrough(): void {
    if (!isClickThrough) return
    isClickThrough = false
    invoke('set_cursor_ignore', { ignore: false }).catch(console.error)
    stopPolling()
  }

  function startPolling(): void {
    if (pollTimer !== null) return
    pollTimer = setInterval(() => {
      if (!isClickThrough) { stopPolling(); return }
      // get_cursor_window_pos queries NSEvent.mouseLocation (macOS) directly;
      // returns [cssX, cssY] relative to window origin, or null if unavailable.
      invoke<[number, number] | null>('get_cursor_window_pos')
        .then((pos) => {
          if (pos && (runtime?.hitTest(pos[0], pos[1]) || agentTaskBubble.hitTest(pos[0], pos[1]))) {
            disableClickThrough()
          }
        })
        .catch(() => { /* ignore IPC errors during startup */ })
    }, 32)
  }

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  /** Returns true if cursor events should remain active at this CSS position. */
  function shouldKeepActive(cssX: number, cssY: number): boolean {
    if (!menu.element.hidden) return true   // context menu is open
    if (agentTaskBubble.hitTest(cssX, cssY)) return true
    if (runtime?.dragging) return true      // dragging (window may lag behind cursor)
    return runtime?.hitTest(cssX, cssY) ?? false
  }

  document.addEventListener('mousemove', (event) => {
    if (isClickThrough) return
    if (!shouldKeepActive(event.clientX, event.clientY)) {
      enableClickThrough()
    }
  })

  document.addEventListener('mouseleave', () => {
    if (!isClickThrough) enableClickThrough()
  })

  startDeferredClickThroughPolling = () => {
    isClickThrough = true
    invoke('set_cursor_ignore', { ignore: true }).catch(console.error)
    startPolling()
  }
}
