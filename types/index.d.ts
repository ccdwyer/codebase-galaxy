// The repo as the galaxy draws it. Plain data, so it can travel as a Client's props.
export type Graph = {
  // Bumped on every change (a rescan, a new star), so the view notices it.
  rev: number
  root: string
  // Paths relative to root, one per star.
  files: string[]
  // Language index per file (see LANGS in hooks/galaxy.ts).
  lang: number[]
  // Rough size per file, 0..1, which sets a star's brightness.
  mass: number[]
  // Cluster index per file: the system it gravitates to.
  cluster: number[]
  dirs: string[]
  // Import links as flat pairs [from, to, from, to, ...].
  edges: number[]
  // Drawable files the scan saw, before the cap.
  total: number
  // True when the scan stopped at a budget, so `total` is a lower bound.
  truncated: boolean
}

// One moment of Claude's attention on a file of graph revision `rev`.
export type Attention = { seq: number; rev: number; file: number; kind: 'read' | 'edit' | 'run' }

declare module 'claude-code' {
  interface PluginState {
    'codebase-galaxy': {
      graph: Graph | null
      events: Attention[]
      // The last attention sequence number handed out: it only grows, even when a rescan clears the events.
      seq: number
      status: string
    }
  }
}
