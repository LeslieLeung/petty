import './styles.css'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { PetRuntime } from './pet-runtime/runtime'
import { petModels, type PetModelDefinition } from './pet-models'
import { applyLanguageMetadata, t, type LanguagePreference } from './i18n'
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
      startDeferredClickThroughPolling?.()
    }, HOST_STARTUP_IPC_DELAY_MS)
  }
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
      window.alert(error instanceof Error ? error.message : String(error))
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
  const folder = folderNameFromFile(petJsonFile)
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
          if (pos && runtime?.hitTest(pos[0], pos[1])) {
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
