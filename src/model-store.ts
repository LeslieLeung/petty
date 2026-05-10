/**
 * Persists imported (custom folder) pet models in localStorage so both the
 * pet window and the settings window can read and write them consistently.
 *
 * Storage keys:
 *   petty.imported-models              → JSON array of ImportedModelMeta
 *   petty.model.<id>.petjson           → serialised LegacyPetJson
 *   petty.model.<id>.spritesheet       → base64 data URL (data:image/webp;base64,…)
 */

import { createLegacyRuntimeManifest, type LegacyPetJson } from './pet-runtime/resource/legacy-adapter'
import type { PetModelDefinition } from './pet-models'

const METAS_KEY = 'petty.imported-models'

export interface ImportedModelMeta {
  id: string
  name: string
  description: string
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getImportedModelMetas(): ImportedModelMeta[] {
  try {
    return JSON.parse(localStorage.getItem(METAS_KEY) ?? '[]') as ImportedModelMeta[]
  } catch {
    return []
  }
}

/** Hydrate a stored model into a PetModelDefinition ready to hand to PetRuntime. */
export function loadStoredModelDefinition(id: string): PetModelDefinition | null {
  const metas = getImportedModelMetas()
  const meta = metas.find((m) => m.id === id)
  if (!meta) return null

  const petJsonStr = localStorage.getItem(`petty.model.${id}.petjson`)
  const spritesheetDataUrl = localStorage.getItem(`petty.model.${id}.spritesheet`)
  if (!petJsonStr || !spritesheetDataUrl) return null

  const petJson = JSON.parse(petJsonStr) as LegacyPetJson
  return createImportedModelDefinition(meta, petJson, spritesheetDataUrl)
}

export function createImportedModelDefinition(
  meta: ImportedModelMeta,
  petJson: LegacyPetJson,
  spritesheetDataUrl: string,
): PetModelDefinition {
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    format: 'legacy',
    createManifest: () => createLegacyRuntimeManifest(petJson, spritesheetDataUrl),
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────

export function saveImportedModel(
  meta: ImportedModelMeta,
  petJson: LegacyPetJson,
  spritesheetDataUrl: string,
): void {
  const metas = getImportedModelMetas().filter((m) => m.id !== meta.id)
  metas.push(meta)
  localStorage.setItem(METAS_KEY, JSON.stringify(metas))
  localStorage.setItem(`petty.model.${meta.id}.petjson`, JSON.stringify(petJson))
  localStorage.setItem(`petty.model.${meta.id}.spritesheet`, spritesheetDataUrl)
}

export function removeImportedModel(id: string): void {
  const metas = getImportedModelMetas().filter((m) => m.id !== id)
  localStorage.setItem(METAS_KEY, JSON.stringify(metas))
  localStorage.removeItem(`petty.model.${id}.petjson`)
  localStorage.removeItem(`petty.model.${id}.spritesheet`)
}

// ── File helpers ──────────────────────────────────────────────────────────────

/** Read a File as a base64 data URL (suitable for direct use in PixiJS Assets.load). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/** Build a unique, stable model ID from the folder name / pet.json id. */
export function buildImportedModelId(petJson: LegacyPetJson, folderName: string): string {
  return `imported:${petJson.id ?? folderName}:${Date.now()}`
}

export function folderNameFromFile(file: File): string {
  const rel = webkitRelativePath(file)
  return rel.split('/')[0] || ''
}

export function findFileInList(files: File[], filename: string): File | undefined {
  return files.find((f) => {
    const path = webkitRelativePath(f)
    return f.name === filename || path.endsWith(`/${filename}`)
  })
}

function webkitRelativePath(file: File): string {
  return 'webkitRelativePath' in file && typeof file.webkitRelativePath === 'string'
    ? file.webkitRelativePath
    : file.name
}
