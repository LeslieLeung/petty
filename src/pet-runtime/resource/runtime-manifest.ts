export interface RuntimeManifest {
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

export interface RuntimePetMeta {
  id: string
  name: string
  version: string
  description?: string
  defaultScale: number
  defaultState: string
}

export interface RuntimeAtlas {
  imagePath: string
  cellWidth: number
  cellHeight: number
  sheetWidth: number
  sheetHeight: number
  columns: number
  rows: number
}

export interface RuntimeClip {
  key: string
  frames: RuntimeFrameRef[]
  fps: number
  frameDurationsMs?: readonly number[]
  loop: boolean
  interruptible: boolean
  nextState?: string
  tags: string[]
  minDurationMs?: number
  cooldownSeconds?: number
}

export interface RuntimeFrameRef {
  row: number
  col: number
}

export interface RuntimeSemanticRoles {
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

export type RuntimeInteractionName = 'click' | 'doubleClick' | 'dragStart' | 'dragEnd' | 'hover'

export type RuntimeInteractionMap = Partial<Record<RuntimeInteractionName, string[]>>

export interface RuntimeBehaviorPolicy {
  inactivityThresholds: {
    mildIdleMs: number
    autonomousMs: number
  }
  actions: RuntimeBehaviorAction[]
}

export interface RuntimeBehaviorAction {
  key: string
  candidateClips: string[]
  weight: number
  cooldownSeconds: number
  minDurationMs: number
  interruptOnUserInput: boolean
  requiresGround?: boolean
}

export interface RuntimeSurfacePolicy {
  enabled: boolean
  supportedSurfaces: SurfaceKind[]
  snapDistancePx: number
  fallbackMode: 'idle' | 'move' | 'teleport-to-ground'
}

export type SurfaceKind = 'screen-bottom' | 'screen-left' | 'screen-right' | 'screen-top' | 'none'

export interface RuntimeCapabilities {
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

export interface RuntimeCompatibilityInfo {
  sourceFormat: 'legacy' | 'v2'
  warnings: string[]
}
