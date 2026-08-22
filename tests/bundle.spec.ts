import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

describe('DSH bundle patch', () => {
  it('disables the official consumer and inserts SkillFlux under a unique loader id', async () => {
    const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
    const patches = parseYaml(await readFile(patchPath, 'utf8')) as unknown
    expect(patches).toEqual([
      { id: 'tool-skill', disabled: true },
      { insert: [{ id: 'skillflux', name: 'dsh-skillflux' }] },
    ])
  })
})
