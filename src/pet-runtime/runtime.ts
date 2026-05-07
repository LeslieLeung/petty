import { Application, Assets, Container, Rectangle, Sprite, Text, Texture, loadTextures } from 'pixi.js'
import type { RuntimeManifest, SurfaceKind } from './resource/runtime-manifest'
import { ClipPlayer } from './render/clip-player'
import { PetStateMachine } from './state/pet-state-machine'
import { InactivityTracker } from './behavior/inactivity-tracker'
import { BehaviorScheduler } from './behavior/scheduler'
import {
  clampBoundsToMonitors,
  clampBoundsToWorkarea,
  defaultPetSpawnPoint,
  snapToMonitors,
  snapToScreenEdge,
  viewportWorkarea,
  type PetBounds,
  type Point,
  type Rect,
} from './surface/screen-surface'

interface PetTransform {
  x: number
  y: number
  scale: number
  facing: 'left' | 'right'
}

type MovementDirection = 'left' | 'right' | 'generic'

export interface PetRuntimeOptions {
  onContextMenu?: (event: { x: number; y: number }) => void
  /** CSS-pixel work-area rects of each monitor, relative to the window origin (Tauri full-screen mode). */
  monitors?: Rect[]
  /** After a real drag ends, ask the host to refetch monitors (needed when moving across displays without a resize event). */
  refreshHostMonitorLayout?: () => void
  /** During a native drag, move the host window to the cursor's display and return cursor-local coords. */
  trackHostCursorScreen?: () => Promise<{ x: number; y: number; monitors?: Rect[] } | null>
  /** Keep the pet's physical visual size stable across displays with different scale factors. */
  keepVisualSizeAcrossDisplays?: boolean
}

type TextureLoadTarget = string | { src: string; loadParser: 'loadTextures' }

async function loadTexture(loadTarget: TextureLoadTarget): Promise<Texture> {
  const isTauri = '__TAURI_INTERNALS__' in window
  const textureConfig = loadTextures.config
  if (!textureConfig) return Assets.load<Texture>(loadTarget)

  const previousPreferCreateImageBitmap = textureConfig.preferCreateImageBitmap
  const previousPreferWorkers = textureConfig.preferWorkers
  let objectUrl: string | null = null

  if (isTauri) {
    // Tauri's packaged asset URLs can fetch correctly but fail when WebKit hands
    // the fetched blob to createImageBitmap. They can also fail as direct <img>
    // URLs, so load packaged assets through a blob URL and use the Image path.
    textureConfig.preferCreateImageBitmap = false
    textureConfig.preferWorkers = false
  }

  try {
    const pixiTarget = isTauri ? await toTauriCompatibleTextureTarget(loadTarget) : loadTarget
    if (typeof pixiTarget !== 'string' && pixiTarget.src.startsWith('blob:')) objectUrl = pixiTarget.src
    return await Assets.load<Texture>(pixiTarget)
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    textureConfig.preferCreateImageBitmap = previousPreferCreateImageBitmap
    textureConfig.preferWorkers = previousPreferWorkers
  }
}

async function toTauriCompatibleTextureTarget(loadTarget: TextureLoadTarget): Promise<TextureLoadTarget> {
  const src = typeof loadTarget === 'string' ? loadTarget : loadTarget.src
  if (src.startsWith('blob:') || src.startsWith('data:')) return loadTarget

  const response = await fetch(src)
  if (!response.ok) {
    throw new Error(`[Loader.load] Failed to fetch ${src}: ${response.status} ${response.statusText}`)
  }

  return {
    src: URL.createObjectURL(await response.blob()),
    loadParser: 'loadTextures',
  }
}

export class PetRuntime {
  private app?: Application
  private petContainer = new Container()
  private sprite?: Sprite
  private debugText?: Text
  private player?: ClipPlayer
  private stateMachine: PetStateMachine
  private inactivity = new InactivityTracker()
  private scheduler: BehaviorScheduler
  /** Keeps snap/hit-test in sync when the overlay window moves or monitors change (see main.ts). */
  private monitors?: Rect[]
  private surface: SurfaceKind = 'none'
  private lastSchedulerTick = 0
  private isDragging = false
  /** Last native client coords during drag; used when movementX/Y are zero (coalesced events). */
  private lastDragClient: { x: number; y: number } | null = null
  private dragPointerOffset: { x: number; y: number } | null = null
  private hostDragPollTimer: ReturnType<typeof setInterval> | null = null
  private hostDragPollInFlight = false
  private pointerDownAt = 0
  private lastClickAt = 0
  private userScale: number
  private referenceMmPerCssPx?: number
  private keepVisualSizeAcrossDisplays = true
  private transform: PetTransform
  private _destroyed = false
  // Native canvas handlers attached on pointerdown and removed on pointerup/cancel.
  // Using pointer capture on the canvas ensures move events arrive even when the
  // cursor travels outside the sprite's hit area during a drag.
  private canvasDragMove: ((e: PointerEvent) => void) | null = null
  private canvasDragEnd: ((e: PointerEvent) => void) | null = null
  private autonomousMove: { clipKey: string; remainingPx: number } | null = null
  private currentClipDirection: MovementDirection | undefined

  constructor(
    private readonly manifest: RuntimeManifest,
    private readonly options: PetRuntimeOptions = {},
  ) {
    this.monitors = options.monitors
    this.keepVisualSizeAcrossDisplays = options.keepVisualSizeAcrossDisplays ?? true
    this.referenceMmPerCssPx = this.currentMonitorMmPerCssPx()
    this.stateMachine = new PetStateMachine(manifest)
    this.scheduler = new BehaviorScheduler(manifest, this.stateMachine, this.inactivity)

    // In multi-monitor mode (Tauri full-screen), start inside the primary monitor's
    // OS work area so the pet is not hidden by the Dock/taskbar on first launch.
    const primary = this.monitors?.find((m) => (m as Rect & { isPrimary?: boolean }).isPrimary)
      ?? this.monitors?.[0]
    this.userScale = manifest.meta.defaultScale
    const scale = this.actualDisplayScale()
    const spawnPoint = defaultPetSpawnPoint(primary ?? viewportWorkarea(), {
      width: manifest.atlas.cellWidth * scale,
      height: manifest.atlas.cellHeight * scale,
    })
    this.transform = {
      x: spawnPoint.x,
      y: spawnPoint.y,
      scale,
      facing: 'right',
    }
  }

  async mount(root: HTMLElement): Promise<void> {
    const tag = `[PetRuntime:${this.manifest.meta.name}]`
    console.log(`${tag} app.init() started`)
    this.app = new Application()
    await this.app.init({
      backgroundAlpha: 0,
      resizeTo: window,
      antialias: false,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })
    console.log(`${tag} app.init() done`)

    if (this._destroyed) {
      console.warn(`${tag} destroyed during app.init() — aborting mount`)
      this.app.destroy(true)
      return
    }

    root.appendChild(this.app.canvas)

    const imagePath = this.manifest.atlas.imagePath
    console.log(`${tag} Assets.load("${imagePath}") started`)
    // Blob URLs have no file extension, so PixiJS cannot infer the parser from the URL.
    // Pass an explicit loadParser to ensure the texture loader is used.
    const loadTarget: TextureLoadTarget = imagePath.startsWith('blob:')
      ? { src: imagePath, loadParser: 'loadTextures' }
      : imagePath
    const texture = await loadTexture(loadTarget)
    console.log(`${tag} Assets.load() done, texture=${texture ? 'ok' : 'null'}`)

    if (this._destroyed) {
      console.warn(`${tag} destroyed during Assets.load() — aborting mount`)
      this.app.destroy(true)
      return
    }
    this.player = new ClipPlayer(texture, this.manifest.atlas, {
      onClipEnd: () => this.playClip(this.stateMachine.completeClip()),
    })
    this.sprite = new Sprite(this.player.play(this.stateMachine.currentClip))
    this.sprite.anchor.set(0.5, 1)

    this.petContainer.eventMode = 'static'
    this.petContainer.cursor = 'grab'
    this.petContainer.addChild(this.sprite)
    this.petContainer.hitArea = new Rectangle(
      -this.manifest.atlas.cellWidth / 2,
      -this.manifest.atlas.cellHeight,
      this.manifest.atlas.cellWidth,
      this.manifest.atlas.cellHeight,
    )

    this.debugText = new Text({
      text: '',
      style: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        fill: 0x111827,
        stroke: { color: 0xffffff, width: 3 },
      },
    })
    this.positionDebugText()

    this.app.stage.addChild(this.petContainer)
    this.app.stage.addChild(this.debugText)
    this.attachInteraction()
    this.playClip(this.stateMachine.setReady())
    this.applyTransform()

    this.app.ticker.add((ticker) => this.update(ticker.deltaMS))
    window.addEventListener('resize', this.handleResize)
    console.log(`[PetRuntime:${this.manifest.meta.name}] mount() complete`)
  }

  destroy(): void {
    console.log(`[PetRuntime:${this.manifest.meta.name}] destroy()`)
    this._destroyed = true
    this.isDragging = false
    this.dragPointerOffset = null
    this.stopHostDragPolling()
    window.removeEventListener('resize', this.handleResize)
    this.app?.destroy(true)
  }

  setDebugVisible(visible: boolean): void {
    if (this.debugText) this.debugText.visible = visible
  }

  setScale(scale: number): void {
    this.userScale = scale
    this.applyDisplayScale()
  }

  setKeepVisualSizeAcrossDisplays(enabled: boolean): void {
    this.keepVisualSizeAcrossDisplays = enabled
    this.applyDisplayScale()
  }

  /** Replace monitor work areas (window-relative CSS px); re-snaps the pet to valid work areas. */
  setMonitors(monitors: Rect[] | undefined): void {
    this.monitors = monitors
    this.captureReferencePhysicalScale()
    this.refreshDisplayScale()
    if (this.isDragging) {
      this.positionDebugText()
      return
    }
    this.snapAfterDrag()
    this.applyTransform()
    this.positionDebugText()
  }

  get dragging(): boolean {
    return this.isDragging
  }

  /** Returns true if the given CSS-pixel point is within the pet sprite's rendered bounds. */
  hitTest(cssX: number, cssY: number): boolean {
    if (!this.app || !this.petContainer) return false
    const bounds = this.petContainer.getBounds()
    return (
      cssX >= bounds.x &&
      cssX <= bounds.x + bounds.width &&
      cssY >= bounds.y &&
      cssY <= bounds.y + bounds.height
    )
  }

  private update(deltaMs: number): void {
    if (!this.player || !this.sprite) return

    this.sprite.texture = this.player.update(deltaMs)
    this.stepAutonomousMovement(deltaMs)

    const now = performance.now()
    if (now - this.lastSchedulerTick >= 300) {
      this.lastSchedulerTick = now
      const decision = this.scheduler.tick()
      if (decision.clipKey) this.playClip(decision.clipKey)
    }

    this.applyTransform()
    this.updateDebug()
  }

  private playClip(clipKey: string): void {
    const clip = this.manifest.clips[clipKey] ?? this.manifest.clips[this.manifest.meta.defaultState]
    this.player?.play(clip)
    this.currentClipDirection = this.movementDirectionForClip(clip.key)
    if (this.currentClipDirection === 'left') this.transform.facing = 'left'
    if (this.currentClipDirection === 'right') this.transform.facing = 'right'
  }

  private attachInteraction(): void {
    this.petContainer.on('pointerdown', (event) => {
      if (event.button === 2) {
        this.openContextMenu(event.global.x, event.global.y)
        return
      }
      this.inactivity.markInteraction()
      this.pointerDownAt = performance.now()
      this.isDragging = true
      this.dragPointerOffset = {
        x: event.global.x - this.transform.x,
        y: event.global.y - this.transform.y,
      }
      this.petContainer.cursor = 'grabbing'
      this.playClip(this.stateMachine.startDrag())
      this.startHostDragPolling()

      // Capture the pointer on the canvas so pointermove/pointerup fire everywhere,
      // even when the cursor leaves the sprite's hit area during a fast drag.
      if (this.app) {
        const canvas = this.app.canvas as HTMLCanvasElement
        const nativeEvent = event.nativeEvent as PointerEvent
        canvas.setPointerCapture(nativeEvent.pointerId)
        // Delta-based drag: on macOS WKWebView, absolute `clientX` across displays can be wrong
        // or stall near the bezel while the cursor is already on another screen; movementX/Y stay
        // consistent with physical pointer motion (see pet drag / multi-monitor).
        this.lastDragClient = { x: nativeEvent.clientX, y: nativeEvent.clientY }

        this.canvasDragMove = (e: PointerEvent) => {
          if (!this.isDragging || !this.lastDragClient) return
          if (this.options.trackHostCursorScreen) {
            this.lastDragClient = { x: e.clientX, y: e.clientY }
            return
          }
          let dx = e.clientX - this.lastDragClient.x
          let dy = e.clientY - this.lastDragClient.y
          // Coalesced moves report 0 delta; movementX/Y still carry the step.
          if (dx === 0 && dy === 0) {
            dx = e.movementX
            dy = e.movementY
          }
          this.lastDragClient = { x: e.clientX, y: e.clientY }
          this.transform.x += dx
          this.transform.y += dy
          if (!this.options.trackHostCursorScreen) {
            this.reboundFromNegativeCoordinates()
          }
        }
        this.canvasDragEnd = () => this.releasePointer(0, 0)

        canvas.addEventListener('pointermove', this.canvasDragMove)
        canvas.addEventListener('pointerup', this.canvasDragEnd)
        canvas.addEventListener('pointercancel', this.canvasDragEnd)
      }
    })

    // PixiJS container listeners are kept for non-capture fallback and right-click.
    this.petContainer.on('pointerup', (event) => this.releasePointer(event.global.x, event.global.y))
    this.petContainer.on('pointerupoutside', (event) => this.releasePointer(event.global.x, event.global.y))
    this.petContainer.on('rightclick', (event) => this.openContextMenu(event.global.x, event.global.y))
  }

  private releasePointer(_x: number, _y: number): void {
    if (!this.isDragging) return
    this.isDragging = false
    this.petContainer.cursor = 'grab'
    this.inactivity.markInteraction()

    if (this.app && this.canvasDragMove) {
      const canvas = this.app.canvas as HTMLCanvasElement
      canvas.removeEventListener('pointermove', this.canvasDragMove)
      canvas.removeEventListener('pointerup', this.canvasDragEnd!)
      canvas.removeEventListener('pointercancel', this.canvasDragEnd!)
      this.canvasDragMove = null
      this.canvasDragEnd = null
    }
    this.lastDragClient = null
    this.dragPointerOffset = null
    this.stopHostDragPolling()

    const movedForMs = performance.now() - this.pointerDownAt
    this.snapAfterDrag()
    if (movedForMs >= 180) {
      this.options.refreshHostMonitorLayout?.()
    }

    if (movedForMs < 180) {
      const now = performance.now()
      const isDoubleClick = now - this.lastClickAt < 320
      this.lastClickAt = now
      const interaction = isDoubleClick ? this.manifest.interactions.doubleClick : this.manifest.interactions.click
      this.playClip(this.stateMachine.requestInteraction(interaction ?? ['idle'], isDoubleClick ? 'double-click' : 'click'))
    } else {
      this.playClip(this.stateMachine.recover())
    }
  }

  private startHostDragPolling(): void {
    if (!this.options.trackHostCursorScreen || this.hostDragPollTimer !== null) return
    this.hostDragPollTimer = setInterval(() => {
      void this.pollHostDragCursor()
    }, 32)
    void this.pollHostDragCursor()
  }

  private stopHostDragPolling(): void {
    if (this.hostDragPollTimer !== null) {
      clearInterval(this.hostDragPollTimer)
      this.hostDragPollTimer = null
    }
    this.hostDragPollInFlight = false
  }

  private async pollHostDragCursor(): Promise<void> {
    if (!this.isDragging || this.hostDragPollInFlight || !this.dragPointerOffset) return
    const track = this.options.trackHostCursorScreen
    if (!track) return

    this.hostDragPollInFlight = true
    try {
      const snapshot = await track()
      if (!snapshot || !this.isDragging || !this.dragPointerOffset) return
      if (snapshot.monitors && snapshot.monitors.length > 0) {
        this.monitors = snapshot.monitors
        this.captureReferencePhysicalScale()
        this.refreshDisplayScale()
        this.positionDebugText()
      }
      this.transform.x = snapshot.x - this.dragPointerOffset.x
      this.transform.y = snapshot.y - this.dragPointerOffset.y
      this.reboundFromNegativeCoordinates({ x: snapshot.x, y: snapshot.y })
      this.applyTransform()
    } catch {
      // Drag should stay usable even if the native coordinate query races app shutdown.
    } finally {
      this.hostDragPollInFlight = false
    }
  }

  private snapAfterDrag(): void {
    const bounds = this.currentPetBounds()
    const monitors = this.monitors
    const result = monitors && monitors.length > 0
      ? snapToMonitors(bounds, monitors, this.manifest.surfacePolicy.snapDistancePx)
      : snapToScreenEdge(bounds, viewportWorkarea(), this.manifest.surfacePolicy.snapDistancePx)
    this.surface = result.surface
    this.setTransformFromBounds({ ...bounds, x: result.x, y: result.y })
  }

  private clampToSingleWorkarea(anchor?: Point): void {
    const bounds = this.currentPetBounds()
    const monitors = this.monitors
    const clamped = monitors && monitors.length > 0
      ? clampBoundsToMonitors(bounds, monitors, anchor)
      : clampBoundsToWorkarea(bounds, viewportWorkarea())
    this.setTransformFromBounds(clamped)
  }

  private reboundFromNegativeCoordinates(anchor?: Point): void {
    const bounds = this.currentPetBounds()
    const workarea = this.monitors?.[0] ?? viewportWorkarea()
    if (bounds.x < workarea.x || bounds.y < workarea.y) {
      this.clampToSingleWorkarea(anchor)
    }
  }

  private currentPetBounds(): PetBounds {
    const scale = this.transform.scale
    return {
      x: this.transform.x - (this.manifest.atlas.cellWidth * scale) / 2,
      y: this.transform.y - this.manifest.atlas.cellHeight * scale,
      width: this.manifest.atlas.cellWidth * scale,
      height: this.manifest.atlas.cellHeight * scale,
    }
  }

  private setTransformFromBounds(bounds: PetBounds): void {
    this.transform.x = bounds.x + bounds.width / 2
    this.transform.y = bounds.y + bounds.height
  }

  private stepAutonomousMovement(deltaMs: number): void {
    const snapshot = this.stateMachine.snapshot
    const direction = snapshot.controlState === 'autonomous'
      ? this.movementDirectionForClip(snapshot.clipKey)
      : undefined
    if (!direction) {
      this.autonomousMove = null
      return
    }

    if (this.autonomousMove?.clipKey !== snapshot.clipKey) {
      this.autonomousMove = {
        clipKey: snapshot.clipKey,
        remainingPx: 24 + Math.random() * 36,
      }
    }

    const speed = 0.018 * deltaMs
    const step = Math.min(speed, this.autonomousMove.remainingPx)
    let sign = this.transform.facing === 'right' ? 1 : -1
    if (direction === 'right') sign = 1
    if (direction === 'left') sign = -1

    this.transform.x += sign * step
    this.autonomousMove.remainingPx -= step

    this.snapAfterDrag()

    if (this.autonomousMove.remainingPx <= 0) {
      this.autonomousMove = null
      this.playClip(this.stateMachine.settle())
    }
  }

  private movementDirectionForClip(clipKey: string): MovementDirection | undefined {
    const roles = this.manifest.semanticRoles
    if (roles.idle?.includes(clipKey) || clipKey === this.manifest.meta.defaultState) return undefined
    if (clipKey.includes('left')) return 'left'
    if (clipKey.includes('right')) return 'right'
    if (roles.moveLeft?.includes(clipKey)) return 'left'
    if (roles.moveRight?.includes(clipKey)) return 'right'
    if (roles.moveGeneric?.includes(clipKey) || clipKey === 'running') return 'generic'
    return undefined
  }

  private applyTransform(): void {
    this.petContainer.x = this.transform.x
    this.petContainer.y = this.transform.y
    this.petContainer.scale.x = this.shouldMirrorCurrentClip() ? -this.transform.scale : this.transform.scale
    this.petContainer.scale.y = this.transform.scale
  }

  private shouldMirrorCurrentClip(): boolean {
    // Directional clips already contain the correct left/right artwork. Only
    // generic and non-directional clips need runtime mirroring to preserve facing.
    if (this.currentClipDirection === 'left' || this.currentClipDirection === 'right') return false
    return this.transform.facing === 'left'
  }

  private actualDisplayScale(): number {
    if (!this.keepVisualSizeAcrossDisplays) return this.userScale
    const currentMmPerCssPx = this.currentMonitorMmPerCssPx()
    if (!currentMmPerCssPx || !this.referenceMmPerCssPx) return this.userScale
    return this.userScale * (this.referenceMmPerCssPx / currentMmPerCssPx)
  }

  private refreshDisplayScale(): void {
    this.transform.scale = this.actualDisplayScale()
  }

  private applyDisplayScale(): void {
    this.refreshDisplayScale()
    this.clampToSingleWorkarea()
    this.applyTransform()
  }

  private captureReferencePhysicalScale(): void {
    if (this.referenceMmPerCssPx) return
    this.referenceMmPerCssPx = this.currentMonitorMmPerCssPx()
  }

  private currentMonitorMmPerCssPx(): number | undefined {
    const monitor = this.monitors?.find((m) => (m as Rect & { isPrimary?: boolean }).isPrimary)
      ?? this.monitors?.[0]
    const value = monitor?.mmPerCssPx
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
  }

  private updateDebug(): void {
    const snapshot = this.stateMachine.snapshot
    const monitors = this.monitors
    const monitorLines = monitors && monitors.length > 0
      ? monitors.flatMap((m, i) => {
          const primary = (m as Rect & { isPrimary?: boolean }).isPrimary ? '*' : ' '
          return [
            `mon[${i}]${primary} pos=${Math.round(m.x)},${Math.round(m.y)} size=${Math.round(m.width)}x${Math.round(m.height)}`,
          ]
        })
      : ['monitors: none (viewport-only)']
    const lines = [
      `${this.manifest.meta.name} (${this.manifest.compatibility.sourceFormat})`,
      `control: ${snapshot.controlState}  clip: ${snapshot.clipKey}`,
      `surface: ${this.surface}  reason: ${snapshot.reason}`,
      `pet: x=${Math.round(this.transform.x)} y=${Math.round(this.transform.y)} ${this.isDragging ? '[DRAG]' : ''}`,
      `scale: user=${this.userScale.toFixed(2)} render=${this.transform.scale.toFixed(2)} lock=${this.keepVisualSizeAcrossDisplays ? 'on' : 'off'}`,
      `win: ${window.innerWidth}x${window.innerHeight}  dpr=${window.devicePixelRatio}`,
      `mm/px: cur=${this.currentMonitorMmPerCssPx()?.toFixed(3) ?? 'n/a'} ref=${this.referenceMmPerCssPx?.toFixed(3) ?? 'n/a'}`,
      ...monitorLines,
    ]
    if (this.debugText && this.debugText.visible) this.debugText.text = lines.join('\n')
    this.positionDebugText()
  }

  /**
   * Anchor transparent debug text inside the primary monitor's visible work area.
   */
  private positionDebugText(): void {
    if (!this.debugText) return
    const primary = this.monitors?.find((m) => (m as Rect & { isPrimary?: boolean }).isPrimary)
      ?? this.monitors?.[0]
    const left = primary ? Math.max(0, primary.x) + 12 : 12
    const top = primary ? Math.max(0, primary.y) + 12 : 12
    this.debugText.x = left
    this.debugText.y = top
  }

  private openContextMenu(x: number, y: number): void {
    this.options.onContextMenu?.({ x, y })
  }

  private handleResize = (): void => {
    this.refreshDisplayScale()
    // When Tauri provides per-monitor rects, snapping here uses stale data until main.ts
    // refetches `get_monitors` — skip to avoid pushing the pet off-screen for one frame.
    if (!this.monitors?.length) {
      this.snapAfterDrag()
    }
    this.applyTransform()
    this.positionDebugText()
  }
}
