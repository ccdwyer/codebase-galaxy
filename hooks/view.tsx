// The galaxy itself: a Client surface module that lays the repo out as stars,
// animates it on the surface's frame clock and takes keys and the pointer.
// It runs on the drawing thread with no `$`; it posts to the hooks module.

import type { ClientModule, ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'

import type { Attention, Graph } from '../types'
import { bounds, clearCanvas, colorOf, hash01, line, makeCanvas, plot, ring, scale, seedLayout, stepLayout, toRuns } from './galaxy'
import type { Canvas, Layout } from './galaxy'

export type ViewProps = { graph: Graph | null; events: Attention[] }

type Flare = { kind: Attention['kind']; age: number }

type View = {
  graph: Graph | null
  layout: Layout | null
  canvas: Canvas | null
  cam: { cx: number; cy: number; zoom: number; auto: boolean; follow: boolean }
  comet: { x: number; y: number; target: number; trail: number[] }
  flares: Map<number, Flare>
  lastSeq: number
  t: number
  hover: number
  drag: { x: number; y: number; moved: boolean } | null
  stop: (() => void) | null
}

const FRAME_MS = 33
const MIN_ZOOM = 0.05
const MAX_ZOOM = 40
const FLARE_FRAMES = 45
const TRAIL = 28
const KIND_COLOR: Record<Attention['kind'], number> = { edit: 0xffb84d, read: 0x5ef1ff, run: 0x6bff8f }

// Canvas pixel for a world point under the current camera.
function toPixel(v: View, c: Canvas, wx: number, wy: number): [number, number] {
  return [(wx - v.cam.cx) * v.cam.zoom + c.cols, (wy - v.cam.cy) * v.cam.zoom + c.rows * 2]
}

function nearestStar(v: View, c: Canvas, px: number, py: number, radius: number): number {
  if (v.layout === null) return -1
  let best = -1
  let bestD = radius * radius
  for (let i = 0; i < v.layout.x.length; i += 1) {
    const [sx, sy] = toPixel(v, c, v.layout.x[i] as number, v.layout.y[i] as number)
    const d = (sx - px) * (sx - px) + (sy - py) * (sy - py)
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

function absorb(v: View, props: ViewProps): void {
  const next = props.graph
  if ((next?.rev ?? -1) !== (v.graph?.rev ?? -1) || (next?.root ?? '') !== (v.graph?.root ?? '')) {
    const sameRoot = next !== null && v.graph !== null && next.root === v.graph.root
    v.layout = next === null ? null : seedLayout(next, sameRoot ? v.layout ?? undefined : undefined, sameRoot ? v.graph?.files : undefined)
    // Indices mean different files now: keep the comet on the same file by name.
    const cometFile = v.graph !== null && v.comet.target >= 0 ? v.graph.files[v.comet.target] : undefined
    v.comet.target = cometFile !== undefined && next !== null ? next.files.indexOf(cometFile) : -1
    if (v.comet.target < 0) v.comet.trail = []
    v.flares.clear()
    v.hover = -1
    v.lastSeq = 0
    v.graph = next
  }
  const g = v.graph
  if (g === null) return
  for (const ev of props.events ?? []) {
    // An event about another revision may point at a different file: skip it without moving the cursor,
    // so a later event of this revision is never mistaken for an old one.
    if (ev.rev !== g.rev || ev.file < 0 || ev.file >= g.files.length) continue
    if (ev.seq <= v.lastSeq) continue
    v.lastSeq = ev.seq
    v.flares.set(ev.file, { kind: ev.kind, age: 0 })
    v.comet.target = ev.file
  }
}

function tick(v: View): void {
  v.t += 1
  const g = v.graph
  const l = v.layout
  if (g === null || l === null) return
  stepLayout(g, l)
  // The comet eases toward the file Claude last touched, leaving a trail.
  if (v.comet.target >= 0 && v.comet.target < l.x.length) {
    const tx = l.x[v.comet.target] as number
    const ty = l.y[v.comet.target] as number
    if (v.comet.trail.length === 0) {
      v.comet.x = tx
      v.comet.y = ty
    }
    v.comet.x += (tx - v.comet.x) * 0.16
    v.comet.y += (ty - v.comet.y) * 0.16
    v.comet.trail.push(v.comet.x, v.comet.y)
    if (v.comet.trail.length > TRAIL * 2) v.comet.trail.splice(0, v.comet.trail.length - TRAIL * 2)
  }
  for (const [i, f] of v.flares) {
    f.age += 1
    if (f.age > FLARE_FRAMES) v.flares.delete(i)
  }
}

function frameCamera(v: View, c: Canvas): void {
  if (v.layout === null) return
  if (v.cam.follow && v.comet.trail.length > 0) {
    v.cam.cx += (v.comet.x - v.cam.cx) * 0.12
    v.cam.cy += (v.comet.y - v.cam.cy) * 0.12
    return
  }
  if (!v.cam.auto) return
  const [x0, y0, x1, y1] = bounds(v.layout)
  const w = Math.max(10, x1 - x0) + 16
  const hgt = Math.max(10, y1 - y0) + 16
  const zoom = Math.min((c.cols * 2) / w, (c.rows * 4) / hgt)
  v.cam.cx += ((x0 + x1) / 2 - v.cam.cx) * 0.2
  v.cam.cy += ((y0 + y1) / 2 - v.cam.cy) * 0.2
  v.cam.zoom += (Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) - v.cam.zoom) * 0.2
}

function paint(v: View, c: Canvas): void {
  clearCanvas(c)
  const g = v.graph
  const l = v.layout
  const w = c.cols * 2
  const hgt = c.rows * 4
  // Dust: a faint, slowly drifting field behind everything.
  const dust = Math.floor((w * hgt) / 140)
  for (let k = 0; k < dust; k += 1) {
    const dx = (hash01(`d${k}x`) * w + v.t * 0.05 * (1 + (k % 3))) % w
    const dy = hash01(`d${k}y`) * hgt
    const tw = 0.08 + 0.06 * Math.sin(v.t * 0.05 + k)
    plot(c, dx, dy, 0x6f7fa8, tw)
  }
  if (g === null || l === null) return
  const n = l.x.length
  const px = new Float32Array(n)
  const py = new Float32Array(n)
  for (let i = 0; i < n; i += 1) {
    const [sx, sy] = toPixel(v, c, l.x[i] as number, l.y[i] as number)
    px[i] = sx
    py[i] = sy
  }
  // Links first, so stars sit on top of them.
  const lit = v.hover >= 0 ? v.hover : v.comet.target
  for (let k = 0; k + 1 < g.edges.length; k += 2) {
    const i = g.edges[k] as number
    const j = g.edges[k + 1] as number
    if (i >= n || j >= n) continue
    const hot = i === lit || j === lit
    const col = scale(colorOf(g.lang[i] ?? 0), hot ? 0.9 : 0.4)
    line(c, px[i] as number, py[i] as number, px[j] as number, py[j] as number, col, hot ? 0.55 : 0.16)
  }
  for (let i = 0; i < n; i += 1) {
    const m = g.mass[i] ?? 0.3
    const twinkle = 0.85 + 0.15 * Math.sin(v.t * 0.07 + i * 1.7)
    const flare = v.flares.get(i)
    const boost = flare ? 1 - flare.age / FLARE_FRAMES : 0
    const col = boost > 0.5 ? 0xffffff : colorOf(g.lang[i] ?? 0)
    const light = Math.min(1, (0.45 + 0.55 * m) * twinkle + boost)
    const x = px[i] as number
    const y = py[i] as number
    plot(c, x, y, col, light)
    if (m > 0.7 || boost > 0) {
      plot(c, x + 1, y, col, light * 0.6)
      plot(c, x - 1, y, col, light * 0.6)
      plot(c, x, y + 1, col, light * 0.6)
      plot(c, x, y - 1, col, light * 0.6)
    }
    if (flare) ring(c, x, y, 2 + (flare.age / FLARE_FRAMES) * 9, KIND_COLOR[flare.kind], 0.9 * (1 - flare.age / FLARE_FRAMES))
  }
  // The comet and its fading tail.
  const tr = v.comet.trail
  for (let k = 0; k + 1 < tr.length; k += 2) {
    const [sx, sy] = toPixel(v, c, tr[k] as number, tr[k + 1] as number)
    plot(c, sx, sy, 0xbfefff, 0.1 + 0.8 * (k / tr.length))
  }
  if (tr.length > 0) {
    const [hx, hy] = toPixel(v, c, v.comet.x, v.comet.y)
    plot(c, hx, hy, 0xffffff, 1)
    plot(c, hx + 1, hy, 0xffffff, 0.8)
    plot(c, hx, hy + 1, 0xffffff, 0.8)
  }
  if (v.hover >= 0 && v.hover < n) ring(c, px[v.hover] as number, py[v.hover] as number, 3, 0xffffff, 0.7)
}

// Terminal text can't carry control characters (a newline or ESC in a file name would refuse the tree).
const printable = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')

function status(v: View): string {
  const g = v.graph
  if (g === null) return ' no galaxy yet: /galaxy scans the repo'
  const links = g.edges.length / 2
  const capped = g.total > g.files.length ? ` of ${g.total}` : ''
  const focus = v.hover >= 0 ? g.files[v.hover] : v.comet.target >= 0 ? `→ ${g.files[v.comet.target]}` : ''
  const mode = v.cam.follow ? 'follow' : v.cam.auto ? 'fit' : 'free'
  return printable(` ★ ${g.files.length}${capped} stars · ${links} links · ${g.dirs.length} systems · ${v.cam.zoom.toFixed(1)}x ${mode}  ${focus ?? ''}`)
}

function onPointer(v: View, s: ClientSurface<View>, e: ClientPointerEvent): void {
  const c = v.canvas
  if (c === null || v.graph === null) return
  const fx = (e.fine?.x ?? e.x + 0.5) * 2
  const fy = (e.fine?.y ?? e.y + 0.5) * 4
  if (e.type === 'down' && e.button === 'left') {
    v.drag = { x: fx, y: fy, moved: false }
  } else if (e.type === 'move' && v.drag !== null) {
    const dx = fx - v.drag.x
    const dy = fy - v.drag.y
    if (Math.abs(dx) + Math.abs(dy) > 1) {
      v.cam.cx -= dx / v.cam.zoom
      v.cam.cy -= dy / v.cam.zoom
      v.cam.auto = false
      v.cam.follow = false
      v.drag = { x: fx, y: fy, moved: true }
    }
  } else if (e.type === 'move') {
    v.hover = nearestStar(v, c, fx, fy, 4)
  } else if (e.type === 'up') {
    if (v.drag !== null && !v.drag.moved) {
      const hit = nearestStar(v, c, fx, fy, 4)
      v.hover = hit
      const path = hit >= 0 ? v.graph.files[hit] : undefined
      if (path !== undefined) s.post({ copy: path })
    }
    v.drag = null
  } else if (e.type === 'leave') {
    // A release outside the region may never arrive: end the drag here.
    v.hover = -1
    v.drag = null
  }
  s.setState(v)
}

function onKey(v: View, s: ClientSurface<View>, key: string): void {
  const span = (v.canvas ? v.canvas.cols * 2 : 80) / Math.max(0.01, v.cam.zoom)
  const pan = span * 0.15
  if (key === 'left') v.cam.cx -= pan
  else if (key === 'right') v.cam.cx += pan
  else if (key === 'up') v.cam.cy -= pan
  else if (key === 'down') v.cam.cy += pan
  else if (key === '+' || key === '=') v.cam.zoom = Math.min(MAX_ZOOM, v.cam.zoom * 1.25)
  else if (key === '-' || key === '_') v.cam.zoom = Math.max(MIN_ZOOM, v.cam.zoom / 1.25)
  else if (key === '0') {
    v.cam.auto = true
    v.cam.follow = false
  } else if (key === 'f') v.cam.follow = !v.cam.follow
  else if (key === 'r' && v.layout !== null) v.layout.alpha = 1
  else return
  if (key !== '0' && key !== 'f' && key !== 'r') {
    v.cam.auto = false
    if (key.length > 1) v.cam.follow = false
  }
  s.setState(v)
}

const Galaxy: ClientModule<ViewProps, View> = (props, s) => {
  const { Box, Text } = s.elements
  let v = s.state
  if (v === undefined) {
    v = {
      graph: null,
      layout: null,
      canvas: null,
      cam: { cx: 0, cy: 0, zoom: 1, auto: true, follow: false },
      comet: { x: 0, y: 0, target: -1, trail: [] },
      flares: new Map(),
      lastSeq: 0,
      t: 0,
      hover: -1,
      drag: null,
      stop: null,
    }
    const view = v
    view.stop = s.every(FRAME_MS, () => {
      tick(view)
      s.setState(view)
    })
    s.onPointer(e => onPointer(view, s, e))
    s.onKey(e => onKey(view, s, e.key))
  }
  absorb(v, props)
  const cols = Math.max(0, s.columns)
  const rows = Math.max(0, s.rows - 1)
  if (cols < 4 || rows < 2) {
    return Text({ color: '#5ef1ff', children: status(v) }) as RenderElement
  }
  if (v.canvas === null || v.canvas.cols !== cols || v.canvas.rows !== rows) v.canvas = makeCanvas(cols, rows)
  frameCamera(v, v.canvas)
  paint(v, v.canvas)
  const lines = toRuns(v.canvas).map((runs, r) =>
    Box({
      key: `r${r}`,
      flexDirection: 'row',
      children: runs.map(run =>
        run.color === null ? Text({ children: run.text }) : Text({ color: run.color, children: run.text }),
      ),
    }),
  )
  lines.push(
    Box({
      key: 'status',
      flexDirection: 'row',
      children: [
        Text({ color: '#5ef1ff', wrap: 'truncate-end', children: status(v) }),
        Text({ dimColor: true, wrap: 'truncate-end', children: '  ←↑↓→ pan · +/- zoom · 0 fit · f follow · click copies path' }),
      ],
    }),
  )
  return Box({ flexDirection: 'column', children: lines }) as RenderElement
}

export default Galaxy
