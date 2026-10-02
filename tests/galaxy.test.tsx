import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildGraph, clip, clusterCenter, importsOf, indexFiles, line, makeCanvas, pickFiles, plot, repoPath, resolveImport, seedLayout, stepLayout, toRuns } from '../hooks/galaxy'
import { commandPaths } from '../hooks/register'

const ROOT = '/Users/me/app'

// A small repo the fs mock serves: a few TS files that import each other, a
// Python package, and folders the walk must skip.
const TREE: Record<string, { name: string; kind: 'file' | 'dir' | 'other'; size: number }[]> = {
  [ROOT]: [
    { name: 'src', kind: 'dir', size: 0 },
    { name: 'py', kind: 'dir', size: 0 },
    { name: 'node_modules', kind: 'dir', size: 0 },
    { name: '.git', kind: 'dir', size: 0 },
    { name: 'README.md', kind: 'file', size: 900 },
    { name: 'package-lock.json', kind: 'file', size: 90000 },
  ],
  [`${ROOT}/src`]: [
    { name: 'a.ts', kind: 'file', size: 4000 },
    { name: 'b.ts', kind: 'file', size: 1200 },
    { name: 'logo.png', kind: 'file', size: 5000 },
    { name: 'ui', kind: 'dir', size: 0 },
  ],
  [`${ROOT}/src/ui`]: [{ name: 'index.tsx', kind: 'file', size: 2000 }],
  [`${ROOT}/py`]: [
    { name: '__init__.py', kind: 'file', size: 10 },
    { name: 'core.py', kind: 'file', size: 800 },
    { name: 'util.py', kind: 'file', size: 300 },
  ],
}
const TEXT: Record<string, string> = {
  [`${ROOT}/src/a.ts`]: "import { b } from './b'\nimport View from './ui'\nconst x = require('lodash')\n",
  [`${ROOT}/src/b.ts`]: "export * from './ui/index'\n",
  [`${ROOT}/src/ui/index.tsx`]: 'export default 1\n',
  [`${ROOT}/py/core.py`]: 'from .util import helper\nimport os\n',
  [`${ROOT}/py/util.py`]: 'def helper(): pass\n',
}

const PANE_PROPS = {
  title: 'Codebase Galaxy',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 24 },
  view: {},
}

function repo(on: On, sizes: Record<string, number> = {}, real: Record<string, string> = {}) {
  const listed: string[] = []
  const copied: string[] = []
  const reads: string[] = []
  on('fs.stat', (_$, e) => ({ value: { mtimeMs: 0, size: sizes[e.path] ?? 100, kind: 'file' as const, isLink: false, realPath: real[e.path] ?? e.path } }))
  on('session.cwd', () => ({ value: `${ROOT}/src` }))
  on('fs.exists', (_$, e) => ({ value: e.path === `${ROOT}/.git` }))
  on('fs.list', (_$, e) => {
    listed.push(e.path)
    const entries = TREE[e.path]
    if (entries === undefined) throw new Error('ENOENT')
    return { value: entries.map(x => ({ ...x, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    return { value: TEXT[e.path] ?? '' }
  })
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('command.run', () => ({ text: 'fallback' }))
  return { listed, copied, reads }
}

async function open($: Engine) {
  return $.command.run({ command: 'galaxy', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
}

test('imports are found per language and resolved to the repo files they name', () => {
  expect(importsOf('src/a.ts', TEXT[`${ROOT}/src/a.ts`] as string).map(i => i.spec)).toEqual(['./b', './ui', 'lodash'])
  expect(importsOf('py/core.py', TEXT[`${ROOT}/py/core.py`] as string).map(i => i.spec)).toEqual(['.util', 'os'])
  const picked = ['src/a.ts', 'src/b.ts', 'src/ui/index.tsx', 'py/core.py', 'py/util.py'].map(path => ({ path, size: 100 }))
  const texts = new Map(Object.entries(TEXT).map(([k, v]) => [k.slice(ROOT.length + 1), v] as const))
  const g = buildGraph(ROOT, picked, texts, picked.length)
  const pairs: string[] = []
  for (let k = 0; k < g.edges.length; k += 2) pairs.push(`${g.files[g.edges[k] as number]}>${g.files[g.edges[k + 1] as number]}`)
  expect(pairs.sort()).toEqual(['py/core.py>py/util.py', 'src/a.ts>src/b.ts', 'src/a.ts>src/ui/index.tsx', 'src/b.ts>src/ui/index.tsx'])
  expect(g.dirs).toEqual(['src', 'src/ui', 'py'])
})

test('the star cap keeps every top-level directory represented', () => {
  const files = [
    ...Array.from({ length: 50 }, (_, i) => ({ path: `big/f${i}.ts`, size: 1 })),
    { path: 'small/one.ts', size: 1 },
    { path: 'tiny/two.py', size: 1 },
  ]
  const picked = pickFiles(files, 10).map(f => f.path)
  expect(picked).toHaveLength(10)
  expect(picked).toContain('small/one.ts')
  expect(picked).toContain('tiny/two.py')
})

test('the layout cools and keeps every star at a finite position', () => {
  const picked = Array.from({ length: 40 }, (_, i) => ({ path: `${i % 4}/f${i}.ts`, size: i * 10 }))
  const g = buildGraph(ROOT, picked, new Map(), 40)
  const l = seedLayout(g)
  for (let i = 0; i < 300; i += 1) stepLayout(g, l)
  expect(l.alpha).toBeLessThan(0.05)
  for (let i = 0; i < 40; i += 1) expect(Number.isFinite(l.x[i] as number) && Number.isFinite(l.y[i] as number)).toBe(true)
})

test('the canvas collapses to braille cells in coloured runs', () => {
  const c = makeCanvas(3, 1)
  plot(c, 0, 0, 0xff0000, 1)
  plot(c, 1, 3, 0xff0000, 1)
  plot(c, 4, 1, 0x00ff00, 1)
  const runs = toRuns(c)
  expect(runs).toHaveLength(1)
  const text = (runs[0] ?? []).map(r => r.text).join('')
  expect(text).toHaveLength(3)
  expect(text.charCodeAt(0)).toBe(0x2800 + 0x01 + 0x80)
  expect(text[1]).toBe(' ')
  expect(text.charCodeAt(2)).toBe(0x2800 + 0x02)
  expect((runs[0] ?? []).map(r => r.color)).toEqual(['#ff0000', '#00ff00'])
})

test('/galaxy scans the repo through $.fs, skipping dependencies, and draws the galaxy', async ($, on) => {
  const { listed } = repo(on)
  const ran = await open($)
  expect(String((ran as { text?: string }).text)).toMatch(/7 stars, 4 links, 4 systems/)
  expect(listed).not.toContain(`${ROOT}/node_modules`)
  expect(listed).not.toContain(`${ROOT}/.git`)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'codebase-galaxy', surface, component: 'Pane', requestId: 'codebase-galaxy', props: PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: /CODEBASE GALAXY/ })).toBeDefined()
    await pane.resize({ columns: 80, rows: 20 })
    await pane.advance(330)
    expect(await pane.find({ type: 'Text', text: /★ 7 stars · 4 links · 4 systems/, in: 'galaxy' })).toBeDefined()
    const drawn = JSON.stringify(await pane.drawn({ in: 'galaxy' }))
    expect(/[⠁-⣿]/.test(drawn)).toBe(true)
    await pane.unmount()
  }
})

test("Claude's reads and edits steer the comet, and shell commands naming a file count too", async ($, on) => {
  repo(on)
  on('tool.call', () => ({ result: { ok: true } }))
  await open($)
  const pane = await $.ui.mount({ plugin: 'codebase-galaxy', surface: 'terminal', component: 'Pane', requestId: 'codebase-galaxy', props: PANE_PROPS })
  await pane.resize({ columns: 80, rows: 20 })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/b.ts` } as never)
  await pane.advance(100)
  expect(await pane.find({ type: 'Text', text: /→ src\/b\.ts/, in: 'galaxy' })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run ../py/core.py' } as never)
  await pane.advance(100)
  expect(await pane.find({ type: 'Text', text: /→ py\/core\.py/, in: 'galaxy' })).toBeDefined()
  await pane.unmount()
})

test('a file Claude writes becomes a new star', async ($, on) => {
  repo(on)
  on('tool.call', () => ({ result: { ok: true } }))
  await open($)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/new.ts`, content: 'x' } as never)
  const pane = await $.ui.mount({ plugin: 'codebase-galaxy', surface: 'terminal', component: 'Pane', requestId: 'codebase-galaxy', props: PANE_PROPS })
  await pane.resize({ columns: 80, rows: 20 })
  await pane.advance(100)
  expect(await pane.find({ type: 'Text', text: /★ 8 stars/, in: 'galaxy' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /→ src\/new\.ts/, in: 'galaxy' })).toBeDefined()
  await pane.unmount()
})

test('keys zoom and refit, and a click on a star copies its path', async ($, on) => {
  const { copied } = repo(on)
  await open($)
  const pane = await $.ui.mount({ plugin: 'codebase-galaxy', surface: 'terminal', component: 'Pane', requestId: 'codebase-galaxy', props: PANE_PROPS })
  await pane.resize({ columns: 80, rows: 20 })
  await pane.advance(2000)
  const before = String((await pane.find({ type: 'Text', text: /x fit/, in: 'galaxy' }))?.text)
  await pane.key({ key: '+', in: 'galaxy' })
  const after = String((await pane.find({ type: 'Text', text: /x free/, in: 'galaxy' }))?.text)
  expect(after).not.toBe(before)
  await pane.key({ key: '0', in: 'galaxy' })
  expect(await pane.find({ type: 'Text', text: /x fit/, in: 'galaxy' })).toBeDefined()
  // A copy request from the view only goes through for a real star.
  await pane.post({ copy: 'src/a.ts' }, { in: 'galaxy' })
  await pane.post({ copy: '/etc/passwd' }, { in: 'galaxy' })
  expect(copied).toEqual(['src/a.ts'])
  await pane.unmount()
})

test('surfaces without a Client get a text chart of the systems', async ($, on) => {
  repo(on)
  await open($)
  const pane = await $.ui.mount({ plugin: 'codebase-galaxy', surface: 'mobile', component: 'Pane', requestId: 'codebase-galaxy', props: PANE_PROPS })
  expect(await pane.find({ type: 'Text', text: /src\s+★+ 2/ })).toBeDefined()
  await pane.unmount()
})

test('a whitespace-heavy file parses in linear time', () => {
  const evil = `import ${' '.repeat(150_000)}x\nfrom ${' '.repeat(50_000)}`
  const t0 = Date.now()
  importsOf('src/evil.ts', evil)
  expect(Date.now() - t0).toBeLessThan(250)
})

test('JS imports prefer the file over a folder index; JVM imports need the package path', () => {
  const files = ['src/button.ts', 'src/button/index.ts', 'app/src/main/java/com/acme/View.java', 'lib/List.kt', 'com/acme/util/Strings.kt']
  const idx = indexFiles(files)
  expect(resolveImport('src/app.ts', { spec: './button' }, idx, files)).toEqual([0])
  const jvm = 'app/src/main/java/com/acme/Main.java'
  expect(resolveImport(jvm, { spec: 'com.acme.View' }, idx, files)).toEqual([2])
  expect(resolveImport(jvm, { spec: 'android.view.View' }, idx, files)).toEqual([])
  expect(resolveImport(jvm, { spec: 'java.util.List' }, idx, files)).toEqual([])
  expect(resolveImport(jvm, { spec: 'com.acme.util.Strings.pad' }, idx, files)).toEqual([4])
})

test('Python: multi-name imports and from-dot imports resolve', () => {
  const files = ['pkg/__init__.py', 'pkg/a.py', 'pkg/b.py', 'pkg/sub/c.py']
  const idx = indexFiles(files)
  const imps = importsOf('pkg/sub/c.py', 'from .. import a, b\nimport pkg.a, pkg.b\n')
  const hits = imps.flatMap(i => resolveImport('pkg/sub/c.py', i, idx, files)).sort()
  expect(hits).toEqual([0, 1, 1, 2, 2])
})

test('tool paths resolve against cwd, drop :line, and stay inside the repo', () => {
  expect(repoPath(ROOT, `${ROOT}/src`, 'b.ts')).toBe('src/b.ts')
  expect(repoPath(ROOT, `${ROOT}/src`, 'a.ts:40:2')).toBe('src/a.ts')
  expect(repoPath(ROOT, ROOT, 'src/../src/a.ts')).toBe('src/a.ts')
  expect(repoPath(ROOT, ROOT, `${ROOT}/./py/core.py`)).toBe('py/core.py')
  expect(repoPath(ROOT, `${ROOT}/src`, '../../etc/passwd')).toBeNull()
})

test('a line far outside the canvas is clipped, not walked', () => {
  const c = makeCanvas(40, 10)
  const seg = clip(-1e6, 5, 1e6, 5, 79, 39) ?? []
  ;[0, 5, 79, 5].forEach((v, k) => expect(Math.abs((seg[k] as number) - v) < 1e-6).toBe(true))
  expect(clip(-10, -10, -5, -5, 79, 39)).toBeNull()
  const t0 = Date.now()
  for (let i = 0; i < 1600; i += 1) line(c, -1e6, i % 40, 1e6, (i * 7) % 40, 0xffffff, 0.5)
  expect(Date.now() - t0).toBeLessThan(250)
  expect(c.light.some(v => v > 0)).toBe(true)
})

test('600 stars with 1600 links step well inside a 33ms frame', () => {
  const picked = Array.from({ length: 600 }, (_, i) => ({ path: `src/f${i}.ts`, size: i }))
  const g = buildGraph(ROOT, picked, new Map(), 600)
  for (let i = 0; i < 1600; i += 1) g.edges.push(i % 600, (i * 7 + 3) % 600)
  const l = seedLayout(g)
  const t0 = Date.now()
  for (let i = 0; i < 10; i += 1) stepLayout(g, l)
  expect((Date.now() - t0) / 10).toBeLessThan(15)
})

test('one huge folder does not starve the rest of the repo, and symlinked folders are skipped', async ($, on) => {
  const big = Array.from({ length: 61_000 }, (_, i) => ({ name: `t${i}.json`, kind: 'file' as const, size: 10, mtimeMs: 0, isLink: false }))
  const listed: string[] = []
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.exists', (_$, e) => ({ value: e.path === `${ROOT}/.git` }))
  on('fs.list', (_$, e) => {
    listed.push(e.path)
    const tree: Record<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }[]> = {
      [ROOT]: [
        { name: 'fixtures', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
        { name: 'linked', kind: 'dir', size: 0, mtimeMs: 0, isLink: true },
        { name: 'src', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      ],
      [`${ROOT}/fixtures`]: big,
      [`${ROOT}/src`]: [{ name: 'main.ts', kind: 'file', size: 10, mtimeMs: 0, isLink: false }],
    }
    return { value: tree[e.path] ?? [] }
  })
  on('fs.read', () => ({ value: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  const ran = await open($)
  expect(String((ran as { text?: string }).text)).toMatch(/of 61001\+\)/)
  expect(listed).toContain(`${ROOT}/src`)
  expect(listed).not.toContain(`${ROOT}/linked`)
})

test('a rescan with the same counts still reaches the view, and old attention is dropped', async ($, on) => {
  repo(on)
  on('tool.call', () => ({ result: { ok: true } }))
  await open($)
  const pane = await $.ui.mount({ plugin: 'codebase-galaxy', surface: 'terminal', component: 'Pane', requestId: 'codebase-galaxy', props: PANE_PROPS })
  await pane.resize({ columns: 80, rows: 20 })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/b.ts` } as never)
  await pane.advance(100)
  expect(await pane.find({ type: 'Text', text: /→ src\/b\.ts/, in: 'galaxy' })).toBeDefined()
  // Rename b.ts to c.ts: same counts, different files.
  const src = TREE[`${ROOT}/src`] as { name: string }[]
  const b = src.find(x => x.name === 'b.ts') as { name: string }
  b.name = 'c.ts'
  try {
    await $.command.run({ command: 'galaxy', args: 'rescan', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    await pane.advance(100)
    expect(await pane.find({ type: 'Text', text: /→ src\/b\.ts/, in: 'galaxy' })).toBeUndefined()
    await pane.post({ copy: 'src/c.ts' }, { in: 'galaxy' })
  } finally {
    b.name = 'b.ts'
  }
  await pane.unmount()
})

test('reading a file the scan left out gives it a star and moves the comet there', async ($, on) => {
  repo(on)
  on('tool.call', () => ({ result: { ok: true } }))
  await open($)
  await $.tool.call({ tool: 'Read', file_path: 'ui/extra.ts' } as never)
  const pane = await $.ui.mount({ plugin: 'codebase-galaxy', surface: 'terminal', component: 'Pane', requestId: 'codebase-galaxy', props: PANE_PROPS })
  await pane.resize({ columns: 80, rows: 20 })
  await pane.advance(100)
  expect(await pane.find({ type: 'Text', text: /→ src\/ui\/extra\.ts/, in: 'galaxy' })).toBeDefined()
  await pane.unmount()
})

test('a file read through a link that leaves the repo, or too big to parse, is never read', async ($, on) => {
  const r = repo(on, { [`${ROOT}/src/huge.ts`]: 1_000_000 }, { [`${ROOT}/src/notes.ts`]: '/etc/secret.ts' })
  on('tool.call', () => ({ result: { ok: true } }))
  await open($)
  const before = r.reads.length
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/huge.ts` } as never)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/notes.ts` } as never)
  expect(r.reads.slice(before)).toEqual([])
})

test('many systems: one found late still gets stars', async ($, on) => {
  const tree: Record<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }[]> = {
    [ROOT]: Array.from({ length: 50 }, (_, i) => ({ name: `pkg${String(i).padStart(2, '0')}`, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
  }
  for (let i = 0; i < 50; i += 1) {
    tree[`${ROOT}/pkg${String(i).padStart(2, '0')}`] = Array.from({ length: 300 }, (_, j) => ({ name: `f${j}.ts`, kind: 'file' as const, size: 10, mtimeMs: 0, isLink: false }))
  }
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.exists', (_$, e) => ({ value: e.path === `${ROOT}/.git` }))
  on('fs.list', (_$, e) => ({ value: tree[e.path] ?? [] }))
  on('fs.read', () => ({ value: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  const ran = await open($)
  expect(String((ran as { text?: string }).text)).toMatch(/ 50 systems/)
})

test('formatter-style Python imports become links', () => {
  const text = 'from . import (\n    util,  # helpers\n    core,\n)\nimport os\n'
  const specs = importsOf('py/app.py', text)
  expect(specs.some(s => s.spec === '.' && (s.names ?? []).includes('util') && (s.names ?? []).includes('core'))).toBe(true)
  const files = ['py/app.py', 'py/util.py', 'py/core.py', 'src/os.py']
  const idx = indexFiles(files)
  const all = specs.flatMap(sp => resolveImport('py/app.py', sp, idx, files))
  expect(all.sort()).toEqual([1, 2])
})

test('a system keeps its place whatever other systems appear', () => {
  expect(clusterCenter('src', 5)).toEqual(clusterCenter('src', 9))
})

test('shell paths follow cd and keep quoted names whole', () => {
  expect(commandPaths('cd src && cat a.ts', ROOT)).toEqual([`${ROOT}/src/a.ts`])
  expect(commandPaths('cat "src/my file.ts"', ROOT)).toEqual([`${ROOT}/src/my file.ts`])
  expect(commandPaths('cat $(ls src/*.ts)', ROOT)).toEqual([])
})

test('attention after a rescan still moves the comet', async ($, on) => {
  repo(on)
  on('tool.call', () => ({ result: { ok: true } }))
  await open($)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/b.ts` } as never)
  await $.command.run({ command: 'galaxy', args: 'rescan', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
  const pane = await $.ui.mount({ plugin: 'codebase-galaxy', surface: 'terminal', component: 'Pane', requestId: 'codebase-galaxy', props: PANE_PROPS })
  await pane.resize({ columns: 80, rows: 20 })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/a.ts` } as never)
  await pane.advance(100)
  expect(await pane.find({ type: 'Text', text: /→ src\/a\.ts/, in: 'galaxy' })).toBeDefined()
  await pane.unmount()
})

test('inline, the pane fits header plus galaxy inside the window it opens, on tall and short surfaces', async ($, on) => {
  repo(on)
  await open($)
  for (const [vpRows, body] of [[60, 28], [16, 8]] as const) {
    const inline = { ...PANE_PROPS, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 3 } }
    const pane = await $.ui.mount({
      plugin: 'codebase-galaxy', surface: 'terminal', component: 'Pane', requestId: 'codebase-galaxy',
      props: inline, viewport: { columns: 100, rows: vpRows },
    })
    const client = (await pane.findAll({ type: 'Client' }))[0] as { props?: { height?: number } } | undefined
    expect(client?.props?.height).toBe(body - 1)
    await pane.resize({ columns: 100, rows: body - 1 })
    await pane.advance(330)
    expect(await pane.find({ type: 'Text', text: /★ 7 stars/, in: 'galaxy' })).toBeDefined()
    await pane.unmount()
  }
})
