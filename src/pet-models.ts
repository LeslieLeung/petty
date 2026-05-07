import hanaPet from '../resources/hana/pet.json'
import hanaSpritesheetUrl from '../resources/hana/spritesheet.webp?url'
import { createLegacyRuntimeManifest } from './pet-runtime/resource/legacy-adapter'
import type { RuntimeManifest } from './pet-runtime/resource/runtime-manifest'

export interface PetModelDefinition {
  id: string
  name: string
  description: string
  format: 'legacy' | 'v2'
  createManifest: () => RuntimeManifest
}

export const petModels: PetModelDefinition[] = [
  {
    id: 'hana',
    name: 'Hana',
    description: hanaPet.description,
    format: 'legacy',
    createManifest: () => createLegacyRuntimeManifest(hanaPet, hanaSpritesheetUrl),
  },
]

export function getPetModel(id: string): PetModelDefinition {
  return petModels.find((model) => model.id === id) ?? petModels[0]
}
