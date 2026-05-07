import type { RuntimeManifest } from './runtime-manifest'

export interface LegacyPetJson {
  id?: string
  displayName?: string
  name?: string
  description?: string
  spritesheetPath?: string
}

const columns = 8
const rows = 9
const cellWidth = 192
const cellHeight = 208

const legacyRows = [
  { key: 'idle', role: 'idle', loop: true, durations: [280, 110, 110, 140, 140, 320] },
  { key: 'running-right', role: 'moveRight', loop: true, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { key: 'running-left', role: 'moveLeft', loop: true, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { key: 'waving', role: 'greet', loop: false, durations: [140, 140, 140, 280] },
  { key: 'jumping', role: 'jump', loop: false, durations: [140, 140, 140, 140, 280] },
  { key: 'failed', role: 'failed', loop: false, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  { key: 'waiting', role: 'doze', loop: true, durations: [150, 150, 150, 150, 150, 260] },
  { key: 'running', role: 'busy', loop: true, durations: [120, 120, 120, 120, 120, 220] },
  { key: 'review', role: 'observe', loop: true, durations: [150, 150, 150, 150, 150, 280] },
] as const

export function createLegacyRuntimeManifest(
  pet: LegacyPetJson,
  spritesheetUrl: string,
): RuntimeManifest {
  const clips = Object.fromEntries(
    legacyRows.map((row, rowIndex) => [
      row.key,
      {
        key: row.key,
        frames: Array.from({ length: row.durations.length }, (_, col) => ({ row: rowIndex, col })),
        fps: 1000 / average(row.durations),
        frameDurationsMs: row.durations,
        loop: row.loop,
        interruptible: row.key !== 'failed',
        nextState: row.loop ? undefined : 'idle',
        tags: [row.role],
        minDurationMs: row.loop ? 1200 : undefined,
        cooldownSeconds: row.loop ? undefined : 2,
      },
    ]),
  )

  return {
    meta: {
      id: pet.id ?? 'legacy-pet',
      name: pet.displayName ?? pet.name ?? pet.id ?? 'Petty',
      version: 'legacy',
      description: pet.description,
      defaultScale: 1,
      defaultState: 'idle',
    },
    atlas: {
      imagePath: spritesheetUrl,
      cellWidth,
      cellHeight,
      sheetWidth: cellWidth * columns,
      sheetHeight: cellHeight * rows,
      columns,
      rows,
    },
    clips,
    semanticRoles: {
      idle: ['idle'],
      greet: ['waving', 'idle'],
      jump: ['jumping', 'waving', 'idle'],
      moveLeft: ['running-left'],
      moveRight: ['running-right'],
      moveGeneric: ['running'],
      busy: ['running', 'review', 'waiting', 'idle'],
      failed: ['failed', 'idle'],
      sleep: ['waiting', 'idle'],
      doze: ['waiting', 'review', 'idle'],
      eat: ['review', 'idle'],
      groom: ['idle'],
      observe: ['review', 'idle'],
      edgeStand: ['idle'],
      edgeWalk: ['running-left', 'running-right', 'running', 'idle'],
      fall: ['jumping', 'idle'],
      land: ['idle'],
    },
    interactions: {
      click: ['waving', 'idle'],
      doubleClick: ['jumping', 'waving', 'idle'],
      dragStart: ['idle'],
      dragEnd: ['jumping', 'idle'],
      hover: ['idle'],
    },
    behaviorPolicy: {
      inactivityThresholds: {
        mildIdleMs: 15_000,
        autonomousMs: 45_000,
      },
      actions: [
        {
          key: 'attention_shift',
          candidateClips: ['review', 'waiting', 'idle'],
          weight: 3,
          cooldownSeconds: 8,
          minDurationMs: 2400,
          interruptOnUserInput: true,
        },
        {
          key: 'short_move',
          candidateClips: ['running-left', 'running-right'],
          weight: 2,
          cooldownSeconds: 10,
          minDurationMs: 1800,
          interruptOnUserInput: true,
          requiresGround: true,
        },
        {
          key: 'greet_variant',
          candidateClips: ['waving', 'idle'],
          weight: 1,
          cooldownSeconds: 12,
          minDurationMs: 1200,
          interruptOnUserInput: true,
        },
        {
          key: 'calm_idle',
          candidateClips: ['waiting', 'idle'],
          weight: 1,
          cooldownSeconds: 18,
          minDurationMs: 4000,
          interruptOnUserInput: true,
          requiresGround: true,
        },
      ],
    },
    surfacePolicy: {
      enabled: true,
      supportedSurfaces: ['screen-bottom', 'screen-left', 'screen-right', 'screen-top'],
      snapDistancePx: 24,
      fallbackMode: 'teleport-to-ground',
    },
    capabilities: {
      basicAnimation: true,
      interaction: true,
      autonomousBehavior: true,
      surfaceAware: false,
      windowAware: false,
      chat: false,
      asr: false,
      tts: false,
      memory: false,
      soul: false,
    },
    compatibility: {
      sourceFormat: 'legacy',
      warnings: ['Loaded legacy hatch-pet package with default runtime policy.'],
    },
  }
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
