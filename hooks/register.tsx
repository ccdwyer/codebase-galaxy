import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Attention, Graph } from '../types'
import { addStar, buildGraph, clusterKey, inDrawnTree, isDrawable, langName, normalize, PARSED, pickFiles, repoPath, SKIP_DIRS } from './galaxy'
import type { ScannedFile } from './galaxy'

const PANE = 'codebase-galaxy'
const graph = atom({ plugin: 'codebase-galaxy', key: 'graph' } as const, null)
const events = atom({ plugin: 'codebase-galaxy', key: 'events' } as const, [])
const status = atom({ plugin: 'codebase-galaxy', key: 'status' } as const, '')
const seqNo = atom({ plugin: 'codebase-galaxy', key: 'seq' } as const, 0)

// Bounds that keep a scan quick on a huge repo.
const MAX_STARS = 600
// Stars Claude's own reads and edits may add past the scan's cap.
const MAX_ATTENTION_STARS = 700
const MAX_DIRS = 3000
const MAX_QUEUE = 6000
const MAX_CANDIDATES = 12_000
const MAX_PER_DIR = 300
const MAX_PARSE = 450
const MAX_PARSE_BYTES = 200_000
const MAX_EVENTS = 24

async function findRoot($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  let dir = cwd
  for (let up = 0; up < 25; up += 1) {
    if (await $.fs.exists(`${dir}/.git`)) return dir
    const parent = dir.slice(0, dir.lastIndexOf('/'))
    if (parent === '' || parent === dir) break
    dir = parent
  }
  return cwd
}

type Walk = { files: ScannedFile[]; total: number; truncated: boolean }

// Walk the repo through $.fs, breadth first. Skips dependency and build folders and symlinked folders (which
// can leave the repo or loop). Every subfolder of a listing is queued whatever its size, so one huge folder
// can't keep the walk from the rest; each folder adds at most MAX_PER_DIR files; and candidates are kept per
// system, the fullest giving way, so a system found late still gets its first stars.
async function walk($: EngineInterface, root: string): Promise<Walk> {
  const buckets = new Map<string, ScannedFile[]>()
  const queue: string[] = ['']
  let count = 0
  let dirs = 0
  let total = 0
  let truncated = false
  const add = (f: ScannedFile) => {
    const key = clusterKey(f.path)
    const mine = buckets.get(key) ?? []
    if (count >= MAX_CANDIDATES) {
      let fullest: ScannedFile[] = mine
      for (const b of buckets.values()) if (b.length > fullest.length) fullest = b
      // Only take room from a system with more than this one would have.
      if (fullest.length <= mine.length + 1) return false
      fullest.pop()
      count -= 1
    }
    mine.push(f)
    buckets.set(key, mine)
    count += 1
    return true
  }
  while (queue.length > 0) {
    if (dirs >= MAX_DIRS) {
      truncated = true
      break
    }
    const rel = queue.shift() as string
    dirs += 1
    let entries: { name: string; kind: string; size: number; isLink?: boolean }[] = []
    try {
      entries = await $.fs.list(rel === '' ? root : `${root}/${rel}`)
    } catch {
      continue
    }
    let here = 0
    for (const entry of entries) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.kind === 'dir') {
        if (entry.isLink === true || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        if (queue.length >= MAX_QUEUE) truncated = true
        else queue.push(path)
      } else if (entry.kind === 'file' && isDrawable(path)) {
        total += 1
        if (here >= MAX_PER_DIR || !add({ path, size: entry.size })) {
          truncated = true
          continue
        }
        here += 1
      }
    }
  }
  return { files: [...buckets.values()].flat(), total, truncated }
}

async function readSource($: EngineInterface, root: string, rel: string, size: number): Promise<string | null> {
  if (size > MAX_PARSE_BYTES || !PARSED.has(langName(rel))) return null
  try {
    return await $.fs.read(`${root}/${rel}`)
  } catch {
    return null
  }
}

async function scan($: EngineInterface, rev: number): Promise<Graph> {
  const root = await findRoot($)
  const found = await walk($, root)
  const picked = pickFiles(found.files, MAX_STARS)
  const texts = new Map<string, string>()
  for (const f of picked) {
    if (texts.size >= MAX_PARSE) break
    const text = await readSource($, root, f.path, f.size)
    if (text !== null) texts.set(f.path, text)
  }
  return buildGraph(root, picked, texts, found.total, found.truncated, rev)
}

async function rescan($: EngineInterface): Promise<Graph | null> {
  const prev = await read($, graph)
  await update($, status, () => 'scanning the repo…')
  try {
    const scanned = await scan($, 0)
    // The scan took a while: build on the graph as it is now. Its revision moves past anything the view
    // has seen, and stars Claude's reads added during the scan are kept.
    const g = await update($, graph, cur => {
      let merged: Graph = { ...scanned, rev: Math.max(cur?.rev ?? 0, prev?.rev ?? 0) + 1 }
      if (cur !== null && cur.root === scanned.root) {
        const before = new Set(prev?.files ?? [])
        for (const f of cur.files) {
          if (!before.has(f) && !merged.files.includes(f)) merged = { ...addStar(merged, f, null, MAX_ATTENTION_STARS), rev: merged.rev }
        }
      }
      return merged
    })
    await update($, events, () => [])
    await update($, status, () => '')
    return g
  } catch {
    await update($, status, () => (prev === null ? 'scan failed: try /galaxy rescan' : 'rescan failed: showing the last scan'))
    return null
  }
}

// The repo root with symlinks resolved, so a file read through a link that leaves the repo is never read.
let realRoot: { root: string; real: string } | null = null

async function resolvedRoot($: EngineInterface, root: string): Promise<string> {
  if (realRoot?.root === root) return realRoot.real
  let real = root
  try {
    real = (await $.fs.stat(root, { resolve: true })).realPath ?? root
  } catch {
    // Keep the lexical root.
  }
  realRoot = { root, real }
  return real
}

// The text of a file Claude touched that the scan left out, for its import links: only when it can still
// become a star, it really lives inside the repo, and it is small enough to parse. `ok` is false when the
// file must not become a star at all (it leaves the repo, or the sky is full).
async function attentionSource($: EngineInterface, g: Graph, rel: string): Promise<{ ok: boolean; text: string | null }> {
  if (g.files.length >= MAX_ATTENTION_STARS) return { ok: false, text: null }
  const real = await resolvedRoot($, g.root)
  try {
    const stat = await $.fs.stat(`${g.root}/${rel}`, { resolve: true })
    const where = stat.realPath ?? `${g.root}/${rel}`
    if (!where.startsWith(`${real}/`)) return { ok: false, text: null }
    return { ok: true, text: await readSource($, g.root, rel, stat.size) }
  } catch {
    return { ok: false, text: null }
  }
}

// Paths a shell command names, quote-aware, each resolved from the folder it runs in: simple `cd`/`pushd`
// steps earlier in the same command are followed. A command with substitutions or subshells names nothing,
// since a wrong guess is worse than a miss.
export function commandPaths(command: string, cwd: string): string[] {
  if (/\$\(|`|(^|[;&|]\s*)\(/.test(command)) return []
  const out: string[] = []
  let dir = cwd
  for (const seg of command.split(/&&|\|\||;|\||\n/)) {
    const words = seg.match(/"[^"]*"|'[^']*'|[^\s'"]+/g) ?? []
    const plain = words.map(w => w.replace(/^["']|["']$/g, ''))
    if ((plain[0] === 'cd' || plain[0] === 'pushd') && plain.length === 2) {
      const target = plain[1] as string
      const next = normalize(target.startsWith('/') ? target : `${dir}/${target}`)
      if (next !== null) dir = next
      continue
    }
    for (const w of plain.slice(1)) {
      if (w === '' || w.startsWith('-') || w.includes('=') || !/[./]/.test(w)) continue
      out.push(w.startsWith('/') ? w : `${dir}/${w}`)
      if (out.length >= 40) return out
    }
  }
  return out
}

// The shell's own folder: Claude Code's Bash keeps a `cd` between calls, which the session's cwd doesn't follow.
let shellDir: string | null = null

// Record attention on files. Sequence numbers come from their own counter, which never restarts.
async function attend($: EngineInterface, rev: number, hits: number[], kind: Attention['kind']): Promise<void> {
  if (hits.length === 0) return
  const last = await update($, seqNo, n => n + hits.length)
  const first = last - hits.length + 1
  const fresh = hits.map((file, i) => ({ seq: first + i, rev, file, kind }))
  await update($, events, list => [...list, ...fresh].sort((a, b) => a.seq - b.seq).slice(-MAX_EVENTS))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    shellDir = null
    await $.command.register({
      name: 'galaxy',
      description: 'Codebase Galaxy: your repo as a live starfield; Claude is the comet',
      argumentHint: '[rescan]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'galaxy' }, async ($, e) => {
    const current = await read($, graph)
    const root = await findRoot($)
    const fresh = e.args.trim() === 'rescan' || current === null || current.root !== root
    await $.ui.open({ id: PANE, title: 'Codebase Galaxy' })
    const g = fresh ? await rescan($) : current
    if (g === null) return { text: 'Codebase Galaxy: the scan failed; try /galaxy rescan.' }
    const capped = g.total > g.files.length || g.truncated ? ` (of ${g.total}${g.truncated ? '+' : ''})` : ''
    return { text: `Codebase Galaxy: ${g.files.length}${capped} stars, ${g.edges.length / 2} links, ${g.dirs.length} systems.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    try {
      const g0 = await read($, graph)
      if (g0 === null) return ran
      const call = e as { tool: string; [k: string]: unknown }
      const cwd = await $.session.cwd()
      if (call.tool === 'Read' || call.tool === 'Edit' || call.tool === 'Write' || call.tool === 'NotebookEdit') {
        const raw = call.file_path ?? call.notebook_path
        const rel = typeof raw === 'string' ? repoPath(g0.root, cwd, raw) : null
        if (rel === null) return ran
        let hit = g0.files.indexOf(rel)
        let g = g0
        // A file the scan left out (past the cap, or new) gets a star of its own.
        if (hit === -1 && inDrawnTree(rel)) {
          const source = await attentionSource($, g0, rel)
          if (source.ok) {
            g = (await update($, graph, cur => (cur === null || cur.root !== g0.root ? cur : addStar(cur, rel, source.text, MAX_ATTENTION_STARS)))) ?? g0
            hit = g.files.indexOf(rel)
          }
        }
        if (hit !== -1) await attend($, g.rev, [hit], call.tool === 'Read' ? 'read' : 'edit')
      } else if (call.tool === 'Bash' && typeof call.command === 'string') {
        const here = shellDir ?? cwd
        const hits: number[] = []
        const note = (abs: string) => {
          const rel = repoPath(g0.root, here, abs)
          const i = rel === null ? -1 : g0.files.indexOf(rel)
          if (i !== -1 && !hits.includes(i)) hits.push(i)
        }
        // Files the command actually changed come first; then the paths it names.
        const result = ran.result as { bashEditDiff?: { changedFiles?: string[] } } | undefined
        for (const f of result?.bashEditDiff?.changedFiles ?? []) if (hits.length < 3) note(f)
        for (const p of commandPaths(call.command, here)) if (hits.length < 3) note(p)
        await attend($, g0.rev, hits, 'run')
        // A plain `cd` that succeeded moves the shell for the next command.
        const only = call.command.trim().match(/^cd\s+("[^"]+"|'[^']+'|\S+)$/)
        if (only !== null) {
          const target = (only[1] as string).replace(/^["']|["']$/g, '')
          shellDir = normalize(target.startsWith('/') ? target : `${here}/${target}`) ?? shellDir
        }
      }
    } catch {
      // Drawing is never worth failing a tool call over.
    }
    return ran
  })

  on('ui.message', async ($, e, next) => {
    const data = e.data as { copy?: unknown } | null
    const g = await read($, graph)
    if (g !== null && data !== null && typeof data === 'object' && typeof data.copy === 'string' && g.files.includes(data.copy)) {
      await $.ui.copy({ text: data.copy, surface: e.surface })
      $.ui.toast(`Copied ${data.copy}`)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const g = await read($, graph)
    const evs = await read($, events)
    const note = await read($, status)
    const name = g === null ? '' : g.root.slice(g.root.lastIndexOf('/') + 1)
    const header = (
      <Box key="hdr" flexDirection="row">
        <Text color="#ff3df0" bold>
          ◉ CODEBASE GALAXY{' '}
        </Text>
        <Text color="#5ef1ff">{name}</Text>
        <Text dimColor> {note}</Text>
      </Box>
    )
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      // Surfaces without a Client get a text chart of the systems instead.
      const systems = g === null ? [] : g.dirs.map((d, i) => ({ d: d.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?'), n: g.cluster.filter(c => c === i).length }))
      return (
        <Box flexDirection="column">
          {header}
          {g === null && <Text dimColor>No galaxy yet: run /galaxy to scan the repo.</Text>}
          {systems.slice(0, 20).map(s => (
            <Text key={`sys-${s.d}`}>
              {s.d.padEnd(24)} {'★'.repeat(Math.min(40, Math.ceil(s.n / 3)))} {s.n}
            </Text>
          ))}
        </Box>
      )
    }
    const { Client } = $.ui.resolve(e)
    const rows = Math.max(6, (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30) - 1)
    return (
      <Box flexDirection="column">
        {header}
        <Client key="galaxy" module="./view.tsx" props={{ graph: g, events: evs }} width="100%" height={rows} />
      </Box>
    )
  })
}
