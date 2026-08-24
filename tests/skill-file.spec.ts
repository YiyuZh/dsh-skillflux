import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectSkillDirectory, parseSkillMarkdown } from '../src/skill-file.js'

const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skillflux-skill-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('skill file parsing', () => {
  it('parses canonical invocation metadata and keeps only the markdown body', () => {
    const definition = parseSkillMarkdown([
      '---',
      'name: pdf-reader',
      'description: Read PDF documents',
      'whenToUse: When the task contains a PDF',
      'disable-model-invocation: false',
      'user-invocable: true',
      'metadata:',
      '  category: documents',
      '---',
      '# Instructions',
      'Read the file safely.',
    ].join('\n'), '/cache/pdf-reader')
    expect(definition.name).toBe('pdf-reader')
    expect(definition.content).toBe('# Instructions\nRead the file safely.')
    expect(definition.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(definition.metadata).toEqual({ category: 'documents' })
  })

  it('rejects unsupported legacy invocation keys', () => {
    expect(() => parseSkillMarkdown([
      '---', 'name: unsafe', 'description: test', 'modelInvocable: true', '---', 'body',
    ].join('\n'), '/tmp/unsafe')).toThrow('unsupported legacy')
  })

  it('hashes a bounded directory and ignores only the cache manifest', async () => {
    const root = await fixture()
    await mkdir(join(root, 'scripts'))
    await writeFile(join(root, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\nDo work.\n')
    await writeFile(join(root, 'scripts', 'run.js'), 'console.log("demo")\n')
    const first = await inspectSkillDirectory(root, { maxFiles: 10, maxBytes: 10_000 })
    await writeFile(join(root, '.skillflux.json'), '{"ignored":true}\n')
    const second = await inspectSkillDirectory(root, { maxFiles: 10, maxBytes: 10_000 })
    expect(first.fileCount).toBe(2)
    expect(second.contentHash).toBe(first.contentHash)
  })

  it('rejects directories over the file limit', async () => {
    const root = await fixture()
    await writeFile(join(root, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\nBody\n')
    await writeFile(join(root, 'extra.txt'), 'extra')
    await expect(inspectSkillDirectory(root, { maxFiles: 1, maxBytes: 10_000 })).rejects.toThrow('exceeds 1 files')
  })
})
