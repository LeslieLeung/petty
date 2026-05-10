import './settings.css'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { petModels } from './pet-models'
import {
  applyLanguageMetadata,
  getLanguagePreference,
  setLanguagePreference,
  t,
  translateModelDescription,
  translateUserVisibleError,
  type LanguagePreference,
} from './i18n'
import {
  getImportedModelMetas,
  saveImportedModel,
  removeImportedModel,
  fileToDataUrl,
  buildImportedModelId,
  folderNameFromFile,
  findFileInList,
  type ImportedModelMeta,
} from './model-store'
import type { LegacyPetJson } from './pet-runtime/resource/legacy-adapter'

const root = document.getElementById('settings-root')!

const SCALE_OPTIONS: Array<{ value: number; nameKey: 'settings.appearance.scale.normal' | 'settings.appearance.scale.large' | 'settings.appearance.scale.xlarge' }> = [
  { value: 0.5, nameKey: 'settings.appearance.scale.normal' },
  { value: 0.75, nameKey: 'settings.appearance.scale.large' },
  { value: 1, nameKey: 'settings.appearance.scale.xlarge' },
]
const LANGUAGE_OPTIONS: Array<{ value: LanguagePreference; labelKey: 'settings.appearance.language.system' | 'settings.appearance.language.english' | 'settings.appearance.language.chinese' }> = [
  { value: 'system', labelKey: 'settings.appearance.language.system' },
  { value: 'en', labelKey: 'settings.appearance.language.english' },
  { value: 'zh', labelKey: 'settings.appearance.language.chinese' },
]
const ACTIVE_MODEL_KEY = 'petty.active-model'
const ZOOM_KEY = 'petty.zoom'
const KEEP_VISUAL_SIZE_KEY = 'petty.keep-visual-size-across-displays'

let activeModelId = localStorage.getItem(ACTIVE_MODEL_KEY) ?? 'hana'
let activeScale: number = Number.parseFloat(localStorage.getItem(ZOOM_KEY) ?? '0.5')
let keepVisualSizeAcrossDisplays = getInitialKeepVisualSizeAcrossDisplays()
let activeLanguagePreference = getLanguagePreference()
let activeTab: 'models' | 'appearance' | 'integrations' | 'about' = 'models'
let codexStatus: CodexIntegrationStatus | null = null
let codexStatusMessage = ''
let codexStatusLoading = false

interface CodexIntegrationStatus {
  enabled: boolean
  configPath: string
  hookBinaryPath: string
  hasFeatureFlag: boolean
  hasPettyBlock: boolean
  message: string
}

function getInitialKeepVisualSizeAcrossDisplays(): boolean {
  const stored = localStorage.getItem(KEEP_VISUAL_SIZE_KEY)
  return stored === null ? true : stored === 'true'
}

// ── Render ────────────────────────────────────────────────────────────────────

function render(): void {
  applyLanguageMetadata(t('settings.title'))
  root.innerHTML = `
    <div class="layout">
      <nav class="sidebar">
        <div class="sidebar-title">${t('settings.sidebarTitle')}</div>
        <button class="nav-item ${activeTab === 'models' ? 'is-active' : ''}" data-tab="models">
          <svg class="nav-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"/>
          </svg>
          ${t('settings.nav.models')}
        </button>
        <button class="nav-item ${activeTab === 'appearance' ? 'is-active' : ''}" data-tab="appearance">
          <svg class="nav-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M4 2a2 2 0 00-2 2v11a3 3 0 106 0V4a2 2 0 00-2-2H4zm1 14a1 1 0 100-2 1 1 0 000 2zm5-1.757l4.9-4.9a2 2 0 000-2.828L13.485 5.1a2 2 0 00-2.828 0L10 5.757v8.486zM16 18H9.071l6-6H16a2 2 0 012 2v2a2 2 0 01-2 2z" clip-rule="evenodd"/>
          </svg>
          ${t('settings.nav.appearance')}
        </button>
        <button class="nav-item ${activeTab === 'integrations' ? 'is-active' : ''}" data-tab="integrations">
          <svg class="nav-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M4.75 3A2.75 2.75 0 002 5.75v1.5A2.75 2.75 0 004.75 10h1.5A2.75 2.75 0 009 7.25v-.5h2v.5A2.75 2.75 0 0013.75 10h1.5A2.75 2.75 0 0018 7.25v-1.5A2.75 2.75 0 0015.25 3h-1.5A2.75 2.75 0 0011 5.75v.5H9v-.5A2.75 2.75 0 006.25 3h-1.5zM4 5.75C4 5.336 4.336 5 4.75 5h1.5c.414 0 .75.336.75.75v1.5c0 .414-.336.75-.75.75h-1.5A.75.75 0 014 7.25v-1.5zM13 5.75c0-.414.336-.75.75-.75h1.5c.414 0 .75.336.75.75v1.5c0 .414-.336.75-.75.75h-1.5a.75.75 0 01-.75-.75v-1.5zM4.75 11A2.75 2.75 0 002 13.75v.5A2.75 2.75 0 004.75 17h10.5A2.75 2.75 0 0018 14.25v-.5A2.75 2.75 0 0015.25 11H4.75zM4 13.75c0-.414.336-.75.75-.75h10.5c.414 0 .75.336.75.75v.5c0 .414-.336.75-.75.75H4.75a.75.75 0 01-.75-.75v-.5z" clip-rule="evenodd"/>
          </svg>
          ${t('settings.nav.integrations')}
        </button>
        <button class="nav-item ${activeTab === 'about' ? 'is-active' : ''}" data-tab="about">
          <svg class="nav-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
          </svg>
          ${t('settings.nav.about')}
        </button>
      </nav>
      <main class="content" id="tab-content"></main>
    </div>
  `

  root.querySelector('.sidebar')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')
    if (!btn) return
    activeTab = btn.dataset.tab as 'models' | 'appearance' | 'integrations' | 'about'
    render()
  })

  const content = document.getElementById('tab-content')!
  if (activeTab === 'models') renderModels(content)
  else if (activeTab === 'appearance') renderAppearance(content)
  else if (activeTab === 'integrations') renderIntegrations(content)
  else renderAbout(content)
}

// ── Models tab ────────────────────────────────────────────────────────────────

function renderModels(container: HTMLElement): void {
  const importedMetas = getImportedModelMetas()
  const allModels: Array<{ id: string; name: string; description: string; imported: boolean }> = [
    ...petModels.map((m) => ({ id: m.id, name: m.name, description: translateModelDescription(m.id, m.description), imported: false })),
    ...importedMetas.map((m) => ({ id: m.id, name: m.name, description: m.description, imported: true })),
  ]

  container.innerHTML = `
    <div class="panel-header">
      <div>
        <h2>${t('settings.models.title')}</h2>
        <p>${t('settings.models.description')}</p>
      </div>
      <button class="load-btn" id="load-folder-btn" type="button">${t('settings.models.loadFolder')}</button>
    </div>
    <div class="model-list">
      ${allModels
        .map(
          (m) => `
        <div class="model-card ${m.id === activeModelId ? 'is-active' : ''}" data-model-id="${m.id}" role="button" tabindex="0">
          <div class="model-card-info">
            <span class="model-card-name">${m.name}</span>
            <span class="model-card-desc">${m.description}</span>
          </div>
          <div class="model-card-actions">
            ${m.id === activeModelId ? `<span class="active-badge">${t('settings.models.active')}</span>` : ''}
            ${m.imported ? `<button class="remove-btn" data-remove-id="${m.id}" title="${t('settings.models.remove', { name: m.name })}" type="button" aria-label="${t('settings.models.remove', { name: m.name })}">×</button>` : ''}
          </div>
        </div>
      `,
        )
        .join('')}
    </div>
    <p class="hint">${t('settings.models.hint')}</p>
  `

  // Hidden folder picker
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.multiple = true
  fileInput.hidden = true
  fileInput.setAttribute('webkitdirectory', '')
  fileInput.setAttribute('directory', '')
  container.appendChild(fileInput)

  document.getElementById('load-folder-btn')!.addEventListener('click', () => fileInput.click())

  fileInput.addEventListener('change', () => {
    handleFolderImport(fileInput.files).catch((err: unknown) => {
      window.alert(translateUserVisibleError(err))
    })
    fileInput.value = ''
  })

  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement

    // Remove button — stop event so the card click below doesn't fire
    const removeBtn = target.closest<HTMLElement>('[data-remove-id]')
    if (removeBtn) {
      e.stopPropagation()
      const id = removeBtn.dataset.removeId!
      removeImportedModel(id)
      if (id === activeModelId) {
        // Fall back to first built-in
        activateModel(petModels[0].id)
      } else {
        renderModels(container)
      }
      return
    }

    // Model card
    const card = target.closest<HTMLElement>('[data-model-id]')
    if (card) {
      activateModel(card.dataset.modelId!)
    }
  })

  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-model-id]')
    if (card) {
      e.preventDefault()
      activateModel(card.dataset.modelId!)
    }
  })
}

function activateModel(id: string): void {
  if (id === activeModelId) return
  activeModelId = id
  localStorage.setItem(ACTIVE_MODEL_KEY, id)
  emit('switch-model', id).catch(console.error)
  const container = document.getElementById('tab-content')
  if (container) renderModels(container)
}

async function handleFolderImport(files: FileList | null): Promise<void> {
  if (!files || files.length === 0) return

  const fileArray = Array.from(files)
  const petJsonFile = findFileInList(fileArray, 'pet.json')
  const spritesheetFile = findFileInList(fileArray, 'spritesheet.webp')

  if (!petJsonFile || !spritesheetFile) {
    throw new Error(t('error.importFolderMissing'))
  }

  const petJson = JSON.parse(await petJsonFile.text()) as LegacyPetJson
  const spritesheetDataUrl = await fileToDataUrl(spritesheetFile)
  const folderName = folderNameFromFile(petJsonFile) || t('model.importedPetName')
  const id = buildImportedModelId(petJson, folderName)

  const meta: ImportedModelMeta = {
    id,
    name: petJson.displayName ?? petJson.name ?? petJson.id ?? folderName,
    description: petJson.description ?? t('model.importedFrom', { folder: folderName }),
  }

  saveImportedModel(meta, petJson, spritesheetDataUrl)
  activeModelId = id
  localStorage.setItem(ACTIVE_MODEL_KEY, id)
  emit('switch-model', { id, meta, petJson, spritesheetDataUrl }).catch(console.error)
  const container = document.getElementById('tab-content')
  if (container) renderModels(container)
}

// ── Appearance tab ────────────────────────────────────────────────────────────

function renderAppearance(container: HTMLElement): void {
  container.innerHTML = `
    <div class="panel-header no-action">
      <div>
        <h2>${t('settings.appearance.title')}</h2>
        <p>${t('settings.appearance.description')}</p>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-row-label">
        <span class="setting-label">${t('settings.appearance.size.label')}</span>
        <span class="setting-desc">${t('settings.appearance.size.description')}</span>
      </div>
      <div class="scale-options">
        ${SCALE_OPTIONS.map(
          (opt) => `
          <button
            type="button"
            class="scale-option ${activeScale === opt.value ? 'is-active' : ''}"
            data-scale="${opt.value}"
          >
            <span class="scale-option-label">${t(opt.nameKey)}</span>
          </button>
        `,
        ).join('')}
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-row-label">
        <span class="setting-label">${t('settings.appearance.language.label')}</span>
        <span class="setting-desc">${t('settings.appearance.language.description')}</span>
      </div>
      <div class="language-options">
        ${LANGUAGE_OPTIONS.map(
          (opt) => `
          <button
            type="button"
            class="language-option ${activeLanguagePreference === opt.value ? 'is-active' : ''}"
            data-language="${opt.value}"
          >
            ${t(opt.labelKey)}
          </button>
        `,
        ).join('')}
      </div>
    </div>
    <div class="setting-row setting-row-inline">
      <div class="setting-row-label">
        <span class="setting-label">${t('settings.appearance.visualSizeLock.label')}</span>
        <span class="setting-desc">${t('settings.appearance.visualSizeLock.description')}</span>
      </div>
      <button
        type="button"
        class="toggle-switch ${keepVisualSizeAcrossDisplays ? 'is-on' : ''}"
        data-visual-size-lock
        role="switch"
        aria-checked="${keepVisualSizeAcrossDisplays}"
        aria-label="${t('settings.appearance.visualSizeLock.label')}"
      >
        <span class="toggle-switch-thumb"></span>
      </button>
    </div>
  `

  container.addEventListener('click', (e) => {
    const scaleBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-scale]')
    if (scaleBtn) {
      const scale = Number.parseFloat(scaleBtn.dataset.scale!)
      if (!Number.isNaN(scale)) setDisplayScale(scale)
      return
    }

    const languageBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-language]')
    if (languageBtn) {
      setLanguage(languageBtn.dataset.language as LanguagePreference)
      return
    }

    const visualSizeLockBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-visual-size-lock]')
    if (visualSizeLockBtn) setVisualSizeLock(!keepVisualSizeAcrossDisplays)
  })
}

function setDisplayScale(scale: number): void {
  if (scale === activeScale) return
  activeScale = scale
  localStorage.setItem(ZOOM_KEY, String(scale))
  emit('change-scale', scale).catch(console.error)
  const container = document.getElementById('tab-content')
  if (container && activeTab === 'appearance') renderAppearance(container)
}

function setLanguage(preference: LanguagePreference): void {
  if (preference === activeLanguagePreference) return
  activeLanguagePreference = preference
  setLanguagePreference(preference)
  emit('language-changed', preference).catch(console.error)
  render()
}

function setVisualSizeLock(enabled: boolean): void {
  if (enabled === keepVisualSizeAcrossDisplays) return
  keepVisualSizeAcrossDisplays = enabled
  localStorage.setItem(KEEP_VISUAL_SIZE_KEY, String(enabled))
  emit('change-visual-size-lock', enabled).catch(console.error)
  const container = document.getElementById('tab-content')
  if (container && activeTab === 'appearance') renderAppearance(container)
}

// ── Integrations tab ──────────────────────────────────────────────────────────

function renderIntegrations(container: HTMLElement): void {
  const status = codexStatus
  const codexStatusText = status
    ? status.enabled
      ? t('settings.integrations.codex.connected')
      : t('settings.integrations.codex.disconnected')
    : t('settings.integrations.codex.checking')
  container.innerHTML = `
    <div class="panel-header no-action">
      <div>
        <h2>${t('settings.integrations.title')}</h2>
        <p>${t('settings.integrations.description')}</p>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-row-label">
        <span class="setting-label">${t('settings.integrations.codex.label')}</span>
        <span class="setting-desc">${codexStatusText}</span>
      </div>
      <div class="integration-actions">
        <button class="load-btn" type="button" data-codex-action="install">${status?.enabled ? t('settings.integrations.codex.repair') : t('settings.integrations.codex.connect')}</button>
        <button class="secondary-btn" type="button" data-codex-action="uninstall" ${status?.hasPettyBlock ? '' : 'disabled'}>${t('settings.integrations.codex.disconnect')}</button>
        <button class="secondary-btn" type="button" data-codex-action="refresh">${t('settings.integrations.codex.refresh')}</button>
      </div>
      ${status ? `
        <div class="integration-details">
          <div><span>${t('settings.integrations.detail.codexSettings')}</span><code>${escapeHtml(status.configPath)}</code></div>
          <div><span>${t('settings.integrations.detail.pettyHelper')}</span><code>${escapeHtml(status.hookBinaryPath)}</code></div>
          <div><span>${t('settings.integrations.detail.codexHooks')}</span><strong>${status.hasFeatureFlag ? t('settings.integrations.detail.enabled') : t('settings.integrations.detail.off')}</strong></div>
          <div><span>${t('settings.integrations.detail.pettyConnection')}</span><strong>${status.hasPettyBlock ? t('settings.integrations.detail.installed') : t('settings.integrations.detail.missing')}</strong></div>
        </div>
      ` : ''}
      ${codexStatusMessage ? `<p class="hint">${escapeHtml(codexStatusMessage)}</p>` : ''}
    </div>
    <div class="setting-row">
      <div class="setting-row-label">
        <span class="setting-label">${t('settings.integrations.moreAgents.label')}</span>
        <span class="setting-desc">${t('settings.integrations.moreAgents.description')}</span>
      </div>
    </div>
  `

  if (!codexStatus && !codexStatusLoading) refreshCodexStatus()
}

function handleCodexActionClick(e: MouseEvent): void {
  if (activeTab !== 'integrations') return
  const target = e.target
  if (!(target instanceof Element)) return
  const button = target.closest<HTMLElement>('[data-codex-action]')
  if (!button || (button instanceof HTMLButtonElement && button.disabled)) return
  const action = button.dataset.codexAction
  if (action === 'install') updateCodexIntegration('install_codex_integration')
  if (action === 'uninstall') updateCodexIntegration('uninstall_codex_integration')
  if (action === 'refresh') refreshCodexStatus()
}

function refreshCodexStatus(): void {
  codexStatusLoading = true
  invoke<CodexIntegrationStatus>('get_codex_integration_status')
    .then((status) => {
      codexStatus = status
      codexStatusMessage = ''
      codexStatusLoading = false
      const container = document.getElementById('tab-content')
      if (container && activeTab === 'integrations') renderIntegrations(container)
    })
    .catch((error) => {
      codexStatusMessage = translateUserVisibleError(error)
      codexStatusLoading = false
      const container = document.getElementById('tab-content')
      if (container && activeTab === 'integrations') renderIntegrations(container)
    })
}

function updateCodexIntegration(command: 'install_codex_integration' | 'uninstall_codex_integration'): void {
  codexStatusLoading = true
  codexStatusMessage = t('settings.integrations.codex.updating')
  const container = document.getElementById('tab-content')
  if (container && activeTab === 'integrations') renderIntegrations(container)
  invoke<CodexIntegrationStatus>(command)
    .then((status) => {
      codexStatus = status
      codexStatusMessage = status.enabled
        ? t('settings.integrations.codex.connected')
        : t('settings.integrations.codex.disconnected')
      codexStatusLoading = false
      const nextContainer = document.getElementById('tab-content')
      if (nextContainer && activeTab === 'integrations') renderIntegrations(nextContainer)
    })
    .catch((error) => {
      codexStatusMessage = translateUserVisibleError(error)
      codexStatusLoading = false
      const nextContainer = document.getElementById('tab-content')
      if (nextContainer && activeTab === 'integrations') renderIntegrations(nextContainer)
    })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

// ── About tab ─────────────────────────────────────────────────────────────────

function renderAbout(container: HTMLElement): void {
  container.innerHTML = `
    <div class="panel-header no-action">
      <div>
        <h2>${t('settings.about.title')}</h2>
        <p>${t('settings.about.description')}</p>
      </div>
    </div>
    <div class="about-card">
      <div class="about-row">
        <span class="about-label">${t('settings.about.version')}</span>
        <span class="about-value">0.1.0</span>
      </div>
    </div>
  `
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function main(): void {
  root.addEventListener('click', handleCodexActionClick)
  render()

  // Reflect active-model changes that come from the pet window
  listen<string>('model-changed', (event) => {
    activeModelId = event.payload
    render()
  }).catch(console.warn)

  // Reflect scale changes that come from the pet window (e.g. context menu)
  listen<number>('scale-changed', (event) => {
    activeScale = event.payload
    localStorage.setItem(ZOOM_KEY, String(event.payload))
    const container = document.getElementById('tab-content')
    if (container && activeTab === 'appearance') renderAppearance(container)
  }).catch(console.warn)

  listen<LanguagePreference>('language-changed', (event) => {
    activeLanguagePreference = event.payload
    render()
  }).catch(console.warn)

  listen<boolean>('visual-size-lock-changed', (event) => {
    keepVisualSizeAcrossDisplays = event.payload
    localStorage.setItem(KEEP_VISUAL_SIZE_KEY, String(event.payload))
    const container = document.getElementById('tab-content')
    if (container && activeTab === 'appearance') renderAppearance(container)
  }).catch(console.warn)
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    getCurrentWindow().close().catch(console.error)
  }
})

main()
