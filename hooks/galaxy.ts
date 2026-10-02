// The galaxy's pure core: languages, paths, import parsing, graph building, the
// force layout and the braille renderer. No `$` here, so the hooks module, the
// Client surface module and the tests all share it.

import type { Graph } from '../types'

// ---------------------------------------------------------------- languages

export type Lang = { name: string; color: number; exts: string[] }

export const LANGS: Lang[] = [
  { name: 'TypeScript', color: 0x3fb7ff, exts: ['ts', 'tsx', 'mts', 'cts'] },
  { name: 'JavaScript', color: 0xffd93f, exts: ['js', 'jsx', 'mjs', 'cjs'] },
  { name: 'Python', color: 0x6bff8f, exts: ['py', 'pyi'] },
  { name: 'Swift', color: 0xff7a3d, exts: ['swift', 'm', 'mm'] },
  { name: 'Kotlin/Java', color: 0xc77dff, exts: ['kt', 'kts', 'java'] },
  { name: 'Go', color: 0x5ef1ff, exts: ['go'] },
  { name: 'Rust', color: 0xff5d5d, exts: ['rs'] },
  { name: 'Styles', color: 0xff6ad5, exts: ['css', 'scss', 'sass', 'less'] },
  { name: 'C/C++', color: 0x8ab4ff, exts: ['c', 'h', 'cc', 'cpp', 'hpp'] },
  { name: 'Ruby', color: 0xff4f81, exts: ['rb'] },
  { name: 'Shell', color: 0xa3e635, exts: ['sh', 'bash', 'zsh'] },
  { name: 'Data', color: 0x9ee6d6, exts: ['json', 'yaml', 'yml', 'toml', 'xml', 'plist', 'gradle', 'ipynb'] },
  { name: 'Docs', color: 0x9aa0a6, exts: ['md', 'mdx', 'txt', 'rst'] },
]
const OTHER = LANGS.length
const BY_EXT = new Map<string, number>()
LANGS.forEach((l, i) => l.exts.forEach(x => BY_EXT.set(x, i)))

// Languages whose imports become links.
export const PARSED = new Set(['TypeScript', 'JavaScript', 'Python', 'Kotlin/Java'])

export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

export function langOf(path: string): number {
  return BY_EXT.get(extOf(path)) ?? OTHER
}

export function langName(path: string): string {
  return LANGS[langOf(path)]?.name ?? ''
}

export function colorOf(lang: number): number {
  return LANGS[lang]?.color ?? 0x7f8c8d
}

// Directories never worth drawing: dependencies, build output, caches, VCS.
export const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.expo', '.turbo', '.cache', 'coverage',
  'Pods', 'DerivedData', '.gradle', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
  '.claude-plugin', '.svelte-kit', 'bower_components', '.parcel-cache', '.serverless', 'tmp', '.tox',
])

// Files that are noise as stars.
export function isDrawable(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1)
  if (base.startsWith('.')) return false
  if (/\.(lock|map|min\.js|snap|png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|mp4|mov|ttf|otf|woff2?|jar|class|o|a|so|dylib)$/i.test(base)) return false
  if (base === 'package-lock.json' || base === 'yarn.lock' || base === 'pnpm-lock.yaml') return false
  return langOf(path) !== OTHER
}

// A repo-relative path whose folders are all ones the walk would enter.
export function inDrawnTree(rel: string): boolean {
  const segs = rel.split('/')
  for (let i = 0; i < segs.length - 1; i += 1) {
    const s = segs[i] as string
    if (s === '' || s.startsWith('.') || SKIP_DIRS.has(s)) return false
  }
  return isDrawable(rel)
}

// ---------------------------------------------------------------- paths

// Lexical normalisation: `.`, `..` and repeated slashes; null when `..` climbs
// past the start of a relative path.
export function normalize(path: string): string | null {
  const abs = path.startsWith('/')
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) {
        if (abs) continue
        return null
      }
      out.pop()
    } else out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

// The repo-relative path a tool or a shell token means, or null when it is
// outside the repo. Relative paths are taken from `cwd`; a trailing
// `:line` or `:line:col` (as in `src/a.ts:40`) is dropped.
export function repoPath(root: string, cwd: string, raw: string): string | null {
  if (raw === '') return null
  const bare = raw.replace(/:\d+(?::\d+)?$/, '')
  const abs = bare.startsWith('/') ? bare : `${cwd}/${bare}`
  const norm = normalize(abs)
  if (norm === null || !norm.startsWith(`${root}/`)) return null
  return norm.slice(root.length + 1)
}

// The cluster a file belongs to: its first two folders (`src/ui`), or the top
// folder for files directly inside it, or `.` for files at the root.
export function clusterKey(path: string): string {
  const segs = path.split('/')
  if (segs.length <= 1) return '.'
  if (segs.length === 2) return segs[0] as string
  return `${segs[0]}/${segs[1]}`
}

export function topDir(path: string): string {
  const slash = path.indexOf('/')
  return slash === -1 ? '.' : path.slice(0, slash)
}

// ---------------------------------------------------------------- graph

export type ScannedFile = { path: string; size: number }

// Pick at most `cap` files, round-robin across clusters so every system
// survives the cap on a big repo.
export function pickFiles(files: ScannedFile[], cap: number): ScannedFile[] {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (sorted.length <= cap) return sorted
  const groups = new Map<string, ScannedFile[]>()
  for (const f of sorted) {
    const key = clusterKey(f.path)
    const g = groups.get(key)
    if (g) g.push(f)
    else groups.set(key, [f])
  }
  const lists = [...groups.values()]
  const out: ScannedFile[] = []
  for (let round = 0; out.length < cap; round += 1) {
    let any = false
    for (const list of lists) {
      const f = list[round]
      if (f === undefined) continue
      any = true
      out.push(f)
      if (out.length >= cap) break
    }
    if (!any) break
  }
  return out
}

// Imports sit at the top of a file; parsing more is wasted work.
const PARSE_HEAD = 64_000

// Linear by construction: no two adjacent repeats can both match the same
// characters, so a run of whitespace never backtracks quadratically.
const JS_SPEC = /\b(?:from|import|require)\s*(?:\(\s*)?['"]([^'"\n]{1,300})['"]/g
const PY_FROM = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+([\w., \t]+)/gm
// `from . import (\n    util,\n    core,  # comment\n)`: one bounded run up to the closing paren.
const PY_FROM_PAREN = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]*\(([^)]{0,4000})\)/gm
const PY_IMPORT = /^[ \t]*import[ \t]+([\w., \t]+)/gm
const JVM_IMPORT = /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+)/gm

export type ImportSpec = { spec: string; names?: string[] }

// Import specifiers a file names, by language. Cheap regexes, not parsers.
export function importsOf(path: string, text: string): ImportSpec[] {
  const lang = langName(path)
  const head = text.length > PARSE_HEAD ? text.slice(0, PARSE_HEAD) : text
  const out: ImportSpec[] = []
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    re.lastIndex = 0
    for (let m = re.exec(head); m !== null; m = re.exec(head)) fn(m)
  }
  if (lang === 'TypeScript' || lang === 'JavaScript') {
    each(JS_SPEC, m => {
      if (m[1]) out.push({ spec: m[1] })
    })
  } else if (lang === 'Python') {
    each(PY_FROM, m => {
      if (!m[1]) return
      const names = (m[2] ?? '').split(',').map(s => s.trim().split(/\s+/)[0] ?? '').filter(Boolean)
      out.push({ spec: m[1], names })
    })
    each(PY_FROM_PAREN, m => {
      if (!m[1]) return
      const body = (m[2] ?? '').split('\n').map(line => line.replace(/#.*$/, '')).join(' ')
      const names = body.split(',').map(s => s.trim().split(/\s+/)[0] ?? '').filter(n => /^\w+$/.test(n))
      out.push({ spec: m[1], names })
    })
    each(PY_IMPORT, m => {
      for (const part of (m[1] ?? '').split(',')) {
        const name = part.trim().split(/\s+/)[0]
        if (name) out.push({ spec: name })
      }
    })
  } else if (lang === 'Kotlin/Java') {
    each(JVM_IMPORT, m => {
      if (m[1]) out.push({ spec: m[1] })
    })
  }
  return out
}

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const JVM_EXTS = ['.kt', '.kts', '.java']

export type FileIndex = {
  byPath: Map<string, number>
  // Path without extension → files, for JVM package-suffix lookups.
  byStem: Map<string, number[]>
}

export function indexFiles(files: string[]): FileIndex {
  const byPath = new Map<string, number>()
  const byStem = new Map<string, number[]>()
  files.forEach((p, i) => {
    byPath.set(p, i)
    if (langName(p) !== 'Kotlin/Java') return
    const stem = p.slice(p.lastIndexOf('/') + 1).replace(/\.(kt|kts|java)$/, '')
    const list = byStem.get(stem)
    if (list) list.push(i)
    else byStem.set(stem, [i])
  })
  return { byPath, byStem }
}

// Where a Python module lives: beside the importer's root, or in a src-layout package. A bare `src/<name>.py`
// is not a candidate for a top-level name, so `import os` never links to a file that happens to be src/os.py.
function pyCandidates(rel: string): string[] {
  if (rel === '') return []
  const out = [`${rel}.py`, `${rel}/__init__.py`, `src/${rel}/__init__.py`]
  if (rel.includes('/')) out.push(`src/${rel}.py`)
  return out
}

// The files an import points at, if they are ours.
export function resolveImport(from: string, imp: ImportSpec, idx: FileIndex, files: string[]): number[] {
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  const lang = langName(from)
  const spec = imp.spec
  const hit = (p: string) => idx.byPath.get(p)
  if (lang === 'TypeScript' || lang === 'JavaScript') {
    let base: string | null = null
    if (spec.startsWith('.')) base = normalize(dir === '' ? spec : `${dir}/${spec}`)
    else if (spec.startsWith('@/') || spec.startsWith('~/')) base = normalize(`src/${spec.slice(2)}`)
    if (base === null || base === '') return []
    const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
    // The file itself first, then a folder's index, as Node and bundlers do.
    for (const b of [base, stem]) {
      const exact = hit(b)
      if (exact !== undefined && b === base) return [exact]
      for (const x of JS_EXTS) {
        const f = hit(b + x)
        if (f !== undefined) return [f]
      }
    }
    for (const x of JS_EXTS) {
      const f = hit(`${stem}/index${x}`)
      if (f !== undefined) return [f]
    }
    return []
  }
  if (lang === 'Python') {
    let base: string | null
    let leading = 0
    if (spec.startsWith('.')) {
      leading = spec.length - spec.replace(/^\.+/, '').length
      let d: string | null = dir
      for (let i = 1; i < leading && d !== null; i += 1) d = d === '' ? null : normalize(`${d}/..`)
      base = d
    } else base = ''
    if (base === null) return []
    const rest = spec.slice(leading).replace(/\./g, '/')
    const mod = rest === '' ? base : base === '' ? rest : `${base}/${rest}`
    const found: number[] = []
    for (const p of pyCandidates(mod)) {
      const f = hit(p)
      if (f !== undefined) {
        found.push(f)
        break
      }
    }
    // `from . import util` or `from pkg import mod`: each name may be a module.
    for (const name of imp.names ?? []) {
      for (const p of pyCandidates(mod === '' ? name : `${mod}/${name}`)) {
        const f = hit(p)
        if (f !== undefined) {
          found.push(f)
          break
        }
      }
    }
    return found
  }
  if (lang === 'Kotlin/Java') {
    const parts = spec.split('.')
    // `import static a.b.Bar.baz`: the class is the last capitalised segment.
    while (parts.length > 1 && /^[a-z_]/.test(parts[parts.length - 1] as string)) parts.pop()
    const cls = parts[parts.length - 1]
    if (cls === undefined) return []
    const suffix = parts.join('/')
    for (const i of idx.byStem.get(cls) ?? []) {
      const p = files[i] as string
      if (JVM_EXTS.some(x => p === `${suffix}${x}` || p.endsWith(`/${suffix}${x}`))) return [i]
    }
    return []
  }
  return []
}

// Links found in one file's text, capped per file so a barrel file that
// re-exports everything can't take the whole edge budget.
export function linksOf(path: string, text: string, from: number, idx: FileIndex, files: string[], perFile = 24): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const imp of importsOf(path, text)) {
    for (const to of resolveImport(path, imp, idx, files)) {
      if (to === from || seen.has(to)) continue
      seen.add(to)
      out.push(from, to)
      if (out.length >= perFile * 2) return out
    }
  }
  return out
}

// Assemble the graph from picked files and the text of the ones we parsed.
export function buildGraph(root: string, picked: ScannedFile[], texts: Map<string, string>, total: number, truncated = false, rev = 1, maxEdges = 1600): Graph {
  const files = picked.map(f => f.path)
  const idx = indexFiles(files)
  const dirs: string[] = []
  const dirIndex = new Map<string, number>()
  const cluster = files.map(p => {
    const key = clusterKey(p)
    let i = dirIndex.get(key)
    if (i === undefined) {
      i = dirs.length
      dirs.push(key)
      dirIndex.set(key, i)
    }
    return i
  })
  const maxSize = Math.max(1, ...picked.map(f => f.size))
  const mass = picked.map(f => Math.round((Math.log1p(f.size) / Math.log1p(maxSize)) * 100) / 100)
  // Round-robin one link per file per pass, so the budget spreads across files.
  const perFile: number[][] = []
  for (const [path, text] of texts) {
    const from = idx.byPath.get(path)
    if (from === undefined) continue
    const links = linksOf(path, text, from, idx, files)
    if (links.length > 0) perFile.push(links)
  }
  const edges: number[] = []
  for (let k = 0; edges.length < maxEdges * 2; k += 2) {
    let any = false
    for (const links of perFile) {
      if (k + 1 >= links.length) continue
      any = true
      edges.push(links[k] as number, links[k + 1] as number)
      if (edges.length >= maxEdges * 2) break
    }
    if (!any) break
  }
  return { rev, root, files, lang: files.map(langOf), mass, cluster, dirs, edges, total, truncated }
}

// A file Claude touched that the scan left out becomes a star, its imports
// becoming links when we have its text. Returns the graph unchanged when full.
export function addStar(g: Graph, rel: string, text: string | null, cap: number): Graph {
  if (g.files.includes(rel) || g.files.length >= cap || !inDrawnTree(rel)) return g
  const key = clusterKey(rel)
  let c = g.dirs.indexOf(key)
  const dirs = c === -1 ? [...g.dirs, key] : g.dirs
  if (c === -1) c = dirs.length - 1
  const files = [...g.files, rel]
  const at = files.length - 1
  let edges = g.edges
  if (text !== null && PARSED.has(langName(rel))) edges = [...g.edges, ...linksOf(rel, text, at, indexFiles(files), files, 12)]
  return {
    ...g,
    rev: g.rev + 1,
    files,
    lang: [...g.lang, langOf(rel)],
    mass: [...g.mass, 0.3],
    cluster: [...g.cluster, c],
    dirs,
    edges,
    total: g.total + 1,
  }
}

// ---------------------------------------------------------------- layout

export type Layout = {
  x: Float32Array
  y: Float32Array
  vx: Float32Array
  vy: Float32Array
  alpha: number
}

// A stable 0..1 hash of a string, so a repo always opens in the same shape.
export function hash01(s: string): number {
  let h0 = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h0 ^= s.charCodeAt(i)
    h0 = Math.imul(h0, 16777619)
  }
  return ((h0 >>> 0) % 100000) / 100000
}

// A system's place in the sky comes from its own name, never its index or how many systems there are, so a
// new folder on a rescan doesn't pull every other system to a new spot.
export function clusterCenter(key: string, count: number): [number, number] {
  if (count <= 1) return [0, 0]
  const a = hash01(key) * Math.PI * 2
  const r = 40 + 110 * Math.sqrt(hash01(`${key}#orbit`))
  return [Math.cos(a) * r, Math.sin(a) * r]
}

// Positions for a graph, carrying stars over by file name from `prev` (whose
// files were `prevFiles`), so a rescan or a new star doesn't scramble the sky.
export function seedLayout(g: Graph, prev?: Layout, prevFiles?: string[]): Layout {
  const n = g.files.length
  const l: Layout = { x: new Float32Array(n), y: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n), alpha: 1 }
  const old = new Map<string, number>()
  if (prev && prevFiles) prevFiles.forEach((p, i) => old.set(p, i))
  let kept = 0
  for (let i = 0; i < n; i += 1) {
    const name = g.files[i] ?? ''
    const j = old.get(name)
    if (prev && j !== undefined && j < prev.x.length) {
      l.x[i] = prev.x[j] as number
      l.y[i] = prev.y[j] as number
      kept += 1
      continue
    }
    const [cx, cy] = clusterCenter(g.dirs[g.cluster[i] ?? 0] ?? '.', g.dirs.length)
    const a = hash01(name) * Math.PI * 2
    const r = 4 + hash01(`${name}#r`) * 14
    l.x[i] = cx + Math.cos(a) * r
    l.y[i] = cy + Math.sin(a) * r
  }
  // Mostly the same stars: a gentle reheat instead of a full re-cooling.
  if (prev && kept > 0) l.alpha = kept === n ? prev.alpha : Math.max(prev.alpha, 0.3)
  return l
}

const CUTOFF = 20
const CELL = CUTOFF

// One cooling step of the force layout: repulsion between nearby stars (on a
// uniform grid, so it stays linear), springs along imports, and a pull toward
// each system's centre. Returns whether anything moved.
export function stepLayout(g: Graph, l: Layout): boolean {
  if (l.alpha < 0.015) return false
  const n = Math.min(g.files.length, l.x.length)
  const { x, y, vx, vy } = l
  const a = l.alpha
  const grid = new Map<number, number[]>()
  const keyOf = (gx: number, gy: number) => gx * 73856093 + gy * 19349663
  for (let i = 0; i < n; i += 1) {
    const k = keyOf(Math.floor((x[i] as number) / CELL), Math.floor((y[i] as number) / CELL))
    const bucket = grid.get(k)
    if (bucket) bucket.push(i)
    else grid.set(k, [i])
  }
  for (let i = 0; i < n; i += 1) {
    const xi = x[i] as number
    const yi = y[i] as number
    const gx = Math.floor(xi / CELL)
    const gy = Math.floor(yi / CELL)
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        const bucket = grid.get(keyOf(gx + ox, gy + oy))
        if (bucket === undefined) continue
        for (const j of bucket) {
          if (j <= i) continue
          let dx = xi - (x[j] as number)
          let dy = yi - (y[j] as number)
          let d2 = dx * dx + dy * dy
          if (d2 > CUTOFF * CUTOFF) continue
          if (d2 < 0.01) {
            dx = 0.1 * ((i % 3) - 1) + 0.05
            dy = 0.1 * ((j % 3) - 1) + 0.05
            d2 = dx * dx + dy * dy
          }
          const f = ((g.cluster[i] === g.cluster[j] ? 10 : 30) * a) / d2
          vx[i] = (vx[i] as number) + dx * f
          vy[i] = (vy[i] as number) + dy * f
          vx[j] = (vx[j] as number) - dx * f
          vy[j] = (vy[j] as number) - dy * f
        }
      }
    }
  }
  const e = g.edges
  for (let k = 0; k + 1 < e.length; k += 2) {
    const i = e[k] as number
    const j = e[k + 1] as number
    if (i >= n || j >= n) continue
    const dx = (x[j] as number) - (x[i] as number)
    const dy = (y[j] as number) - (y[i] as number)
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01
    const f = ((d - 10) / d) * 0.02 * a
    vx[i] = (vx[i] as number) + dx * f
    vy[i] = (vy[i] as number) + dy * f
    vx[j] = (vx[j] as number) - dx * f
    vy[j] = (vy[j] as number) - dy * f
  }
  let moved = 0
  for (let i = 0; i < n; i += 1) {
    const [cx, cy] = clusterCenter(g.dirs[g.cluster[i] ?? 0] ?? '.', g.dirs.length)
    vx[i] = ((vx[i] as number) + (cx - (x[i] as number)) * 0.04 * a) * 0.82
    vy[i] = ((vy[i] as number) + (cy - (y[i] as number)) * 0.04 * a) * 0.82
    x[i] = (x[i] as number) + (vx[i] as number)
    y[i] = (y[i] as number) + (vy[i] as number)
    moved += Math.abs(vx[i] as number) + Math.abs(vy[i] as number)
  }
  l.alpha *= 0.985
  return moved > 0.001
}

export function bounds(l: Layout): [number, number, number, number] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < l.x.length; i += 1) {
    const px = l.x[i] as number
    const py = l.y[i] as number
    if (px < x0) x0 = px
    if (px > x1) x1 = px
    if (py < y0) y0 = py
    if (py > y1) y1 = py
  }
  if (!Number.isFinite(x0)) return [-1, -1, 1, 1]
  return [x0, y0, x1, y1]
}

// ---------------------------------------------------------------- braille canvas

// Bits of a braille cell, indexed [row 0..3][col 0..1].
const DOTS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

export type Canvas = {
  cols: number
  rows: number
  // Per pixel (2 per cell across, 4 down): packed colour and brightness 0..1.
  color: Uint32Array
  light: Float32Array
}

export function makeCanvas(cols: number, rows: number): Canvas {
  const n = Math.max(0, cols * 2) * Math.max(0, rows * 4)
  return { cols, rows, color: new Uint32Array(n), light: new Float32Array(n) }
}

export function clearCanvas(c: Canvas): void {
  c.color.fill(0)
  c.light.fill(0)
}

export function plot(c: Canvas, px: number, py: number, color: number, light: number): void {
  const x = Math.round(px)
  const y = Math.round(py)
  const w = c.cols * 2
  if (!(x >= 0 && y >= 0 && x < w && y < c.rows * 4)) return
  const i = y * w + x
  if (light > (c.light[i] as number)) {
    c.light[i] = light
    c.color[i] = color
  }
}

// Clip a segment to the box [0,w]x[0,h] (Liang–Barsky); null when it misses.
export function clip(x0: number, y0: number, x1: number, y1: number, w: number, h: number): [number, number, number, number] | null {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null
  const dx = x1 - x0
  const dy = y1 - y0
  let t0 = 0
  let t1 = 1
  const p = [-dx, dx, -dy, dy]
  const q = [x0, w - x0, y0, h - y0]
  for (let k = 0; k < 4; k += 1) {
    const pk = p[k] as number
    const qk = q[k] as number
    if (pk === 0) {
      if (qk < 0) return null
      continue
    }
    const r = qk / pk
    if (pk < 0) {
      if (r > t1) return null
      if (r > t0) t0 = r
    } else {
      if (r < t0) return null
      if (r < t1) t1 = r
    }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy]
}

export function line(c: Canvas, x0: number, y0: number, x1: number, y1: number, color: number, light: number): void {
  const w = c.cols * 2
  const hgt = c.rows * 4
  const seg = clip(x0, y0, x1, y1, w - 1, hgt - 1)
  if (seg === null) return
  let ax = Math.round(seg[0])
  let ay = Math.round(seg[1])
  const bx = Math.round(seg[2])
  const by = Math.round(seg[3])
  const dx = Math.abs(bx - ax)
  const dy = -Math.abs(by - ay)
  const sx = ax < bx ? 1 : -1
  const sy = ay < by ? 1 : -1
  let err = dx + dy
  // A clipped segment is at most the canvas diagonal long.
  for (let guard = w + hgt + 4; guard > 0; guard -= 1) {
    // Every other pixel, so links read as faint dotted threads.
    if ((ax + ay) % 2 === 0) plot(c, ax, ay, color, light)
    if (ax === bx && ay === by) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      ax += sx
    }
    if (e2 <= dx) {
      err += dx
      ay += sy
    }
  }
}

// Braille pixels are square (a cell is twice as tall as wide, with four rows
// of dots to two columns), so a circle needs no aspect correction.
export function ring(c: Canvas, cx: number, cy: number, r: number, color: number, light: number): void {
  const steps = Math.max(8, Math.round(r * 6))
  for (let k = 0; k < steps; k += 1) {
    const t = (k / steps) * Math.PI * 2
    plot(c, cx + Math.cos(t) * r, cy + Math.sin(t) * r, color, light)
  }
}

export function scale(color: number, k: number): number {
  const f = Math.max(0, Math.min(1, k))
  const r = Math.round(((color >> 16) & 0xff) * f)
  const g = Math.round(((color >> 8) & 0xff) * f)
  const b = Math.round((color & 0xff) * f)
  return (r << 16) | (g << 8) | b
}

export type Run = { text: string; color: string | null }

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

// Four brightness levels, so neighbouring cells share a colour and merge into
// one run instead of one element per cell.
const LEVELS = [0.4, 0.6, 0.8, 1]
function level(light: number): number {
  return LEVELS[Math.min(LEVELS.length - 1, Math.floor(light * LEVELS.length))] as number
}

// Collapse the pixel canvas to braille cells, one row at a time, as runs of
// same-coloured text.
export function toRuns(c: Canvas): Run[][] {
  const w = c.cols * 2
  const out: Run[][] = []
  for (let row = 0; row < c.rows; row += 1) {
    const runs: Run[] = []
    let text = ''
    let color: string | null = null
    for (let col = 0; col < c.cols; col += 1) {
      let bits = 0
      let best = 0
      let bestColor = 0
      for (let dy = 0; dy < 4; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const i = (row * 4 + dy) * w + col * 2 + dx
          const l = c.light[i] as number
          if (l <= 0.02) continue
          bits |= (DOTS[dy] as number[])[dx] as number
          if (l > best) {
            best = l
            bestColor = c.color[i] as number
          }
        }
      }
      const ch = bits === 0 ? ' ' : String.fromCharCode(0x2800 + bits)
      const cc: string | null = bits === 0 ? color : hex(scale(bestColor, level(best)))
      if (cc !== color && text !== '') {
        runs.push({ text, color })
        text = ''
      }
      color = cc
      text += ch
    }
    if (text !== '') runs.push({ text, color })
    out.push(runs)
  }
  return out
}
