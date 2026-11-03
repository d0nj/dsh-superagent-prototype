import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NUMBERED = /^(\d{3})-[a-z0-9-]+\.md$/
const numbered = readdirSync(join(ROOT, 'docs')).filter(name => NUMBERED.test(name)).sort()
const entries = ['README.md', 'SETUP.md']
const documents = [...entries, ...readdirSync(join(ROOT, 'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`)]
/** Reads a document given relative to the repository, or by its absolute path. */
const read = (path: string): string => readFileSync(isAbsolute(path) ? path : join(ROOT, path), 'utf8')
/** A document's lines, whatever line ends the checkout that wrote it gives them. */
const lines = (path: string): string[] => read(path).split(/\r?\n/)
function links(file: string): string[] {
  return [...read(file).matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]!.split('#')[0]!).filter(target => target && !/^[a-z]+:/.test(target))
}
const files = (directory: string): string[] => readdirSync(join(ROOT, directory), { recursive: true, withFileTypes: true })
  // Documents and tables spell paths with `/`, and a Windows separator would keep every row from matching.
  .filter(entry => entry.isFile()).map(entry => relative(ROOT, join(entry.parentPath, entry.name)).replaceAll(sep, '/'))
/**
 * Extract repo-relative file paths from the first column of a table under `## <heading>` in `docs/007-architecture.md`.
 * Bare filenames inherit the directory of the preceding path in the same cell.
 */
function listed(heading: string): string[] {
  const document = lines('docs/007-architecture.md')
  const start = document.indexOf(`## ${heading}`)
  const end = document.findIndex((line, index) => index > start && line.startsWith('## '))
  // The first two rows are the header and its separator.
  const rows = document.slice(start, end < 0 ? undefined : end).filter(line => line.startsWith('| ')).slice(2)
  return rows.flatMap(row => {
    let directory = ''
    return [...row.split('|')[1]!.matchAll(/`([^`]+)`/g)].map(([, name]) => {
      if (!name!.includes('/')) return `${directory}/${name!}`
      directory = name!.slice(0, name!.lastIndexOf('/'))
      return name!
    })
  })
}

describe('documentation', () => {
  it('numbers documents consecutively from 000', () => {
    expect(numbered.map(name => name.slice(0, 3))).toEqual(numbered.map((_, index) => String(index).padStart(3, '0')))
  })
  it('links numbered documents only to earlier numbered documents', () => {
    // Paths are compared as the repository spells them, so a linked document is never taken for a foreign one.
    const slash = (path: string): string => path.replaceAll(sep, '/')
    const violations = numbered.flatMap(name => links(join(ROOT, 'docs', name)).flatMap(target => {
      const linked = slash(resolve(ROOT, 'docs', target))
      if (!linked.endsWith('.md')) return []
      const number = NUMBERED.exec(linked.slice(linked.lastIndexOf('/') + 1))?.[1]
      return linked.slice(0, linked.lastIndexOf('/')) === slash(join(ROOT, 'docs')) && number !== undefined && number < name.slice(0, 3) ? [] : [`${name} → ${target}`]
    }))
    expect(violations).toEqual([])
  })
  it('resolves every local link', () => {
    const files = [...entries.map(name => join(ROOT, name)), ...numbered.map(name => join(ROOT, 'docs', name))]
    const missing = files.flatMap(file => links(file).filter(target => !existsSync(resolve(dirname(file), target))).map(target => `${file.slice(ROOT.length + 1)} → ${target}`))
    expect(missing).toEqual([])
  })
  it('leaves no merge conflict markers in any document', () => {
    expect(documents.filter(path => /^(<{7}|>{7}) /m.test(read(path)))).toEqual([])
  })
  it('lists every module of src in the module table of 007 Architecture, and only files that exist', () => {
    const modules = listed('Modules')
    expect(files('src').filter(path => !modules.includes(path))).toEqual([])
    expect(modules.filter(path => !existsSync(join(ROOT, path)))).toEqual([])
  })
  it('lists every test in the test table of 007 Architecture, and only files that exist', () => {
    const tests = listed('Tests')
    expect(files('tests').filter(path => /\.spec\.tsx?$/.test(path) && !tests.includes(path))).toEqual([])
    expect(tests.filter(path => !existsSync(join(ROOT, path)))).toEqual([])
  })
})
