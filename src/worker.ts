/// <reference lib="webworker" />
import { analyze, siteRingsOf, type AnalysisOutput } from './engine/analyze'
import { importFile } from './engine/importer'
import { sortDrawings } from './engine/intake'
import type { Condition, Drawing, LayerInfo, Role, Settings } from './engine/types'

export type WorkerIn =
  | { type: 'intake'; id: number; files: { name: string; text: string }[] }
  | { type: 'load'; id: number; condition: Condition; files: { name: string; text: string }[] }
  | { type: 'run'; id: number; condition: Condition; roles: Record<string, Role>; settings: Settings }
  | { type: 'clear'; id: number; condition: Condition }

export type WorkerOut =
  | { type: 'loaded'; id: number; condition: Condition; layers: LayerInfo[]; files: string[]; units: string; hasTin: boolean }
  | { type: 'result'; id: number; condition: Condition; result: Omit<AnalysisOutput, 'z'> }
  | { type: 'progress'; id: number; condition: Condition; msg: string }
  | { type: 'error'; id: number; condition: Condition; message: string }
  | { type: 'cleared'; id: number; condition: Condition }
  | { type: 'sorted'; id: number; condition: Condition; notes: string[]; has: { pre: boolean; post: boolean } }

const drawings: Partial<Record<Condition, Drawing>> = {}
let lastPre: AnalysisOutput | null = null

function merge(ds: Drawing[]): Drawing {
  if (ds.length === 1) return ds[0]
  const layers = new Map<string, LayerInfo>()
  for (const d of ds)
    for (const l of d.layers) {
      const e = layers.get(l.name)
      if (e) { e.count += l.count; e.closed += l.closed; e.withZ += l.withZ; e.faces += l.faces; e.points += l.points; e.polys = (e.polys ?? 0) + (l.polys ?? 0); e.polysZ = (e.polysZ ?? 0) + (l.polysZ ?? 0) }
      else layers.set(l.name, { ...l })
    }
  return {
    fileName: ds.map((d) => d.fileName).join(' + '),
    source: ds.some((d) => d.source === 'landxml') ? 'landxml' : 'dxf',
    units: ds[0].units,
    toFt: ds[0].toFt,
    ents: ds.flatMap((d) => d.ents),
    layers: [...layers.values()],
    tin: ds.find((d) => d.tin)?.tin,
  }
}

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const m = ev.data
  const post = (o: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(o, transfer)
  try {
    if (m.type === 'intake') {
      const ds = m.files.map((f) => importFile(f.name, f.text, 'pre'))
      const sorted = sortDrawings(ds)
      lastPre = null
      delete drawings.pre
      delete drawings.post
      post({ type: 'sorted', id: m.id, condition: 'pre', notes: sorted.notes, has: { pre: !!sorted.pre.length, post: !!sorted.post.length } })
      for (const c of ['pre', 'post'] as Condition[]) {
        const list = sorted[c]
        if (!list.length) continue
        const d = merge(list)
        drawings[c] = d
        post({ type: 'loaded', id: m.id, condition: c, layers: d.layers, files: list.map((x) => x.fileName), units: d.units, hasTin: !!d.tin })
      }
      return
    }
    if (m.type === 'clear') {
      delete drawings[m.condition]
      if (m.condition === 'pre') lastPre = null
      post({ type: 'cleared', id: m.id, condition: m.condition })
      return
    }
    if (m.type === 'load') {
      const ds = m.files.map((f) => importFile(f.name, f.text, m.condition))
      const d = merge(ds)
      drawings[m.condition] = d
      post({ type: 'loaded', id: m.id, condition: m.condition, layers: d.layers, files: m.files.map((f) => f.name), units: d.units, hasTin: !!d.tin })
      return
    }
    if (m.type === 'run') {
      const d = drawings[m.condition]
      if (!d) throw new Error('Drop a drawing first.')
      d.layers = d.layers.map((l) => ({ ...l, role: m.roles[l.name] ?? l.role }))
      const onProgress = (msg: string) => post({ type: 'progress', id: m.id, condition: m.condition, msg })
      let r: AnalysisOutput
      if (m.condition === 'pre') {
        // the limit of disturbance usually lives on the proposed plan; use it for existing too
        const siteRings = !siteRingsOf(d).length && drawings.post ? siteRingsOf(drawings.post) : undefined
        r = analyze(d, 'pre', m.settings, { onProgress, siteRings })
        lastPre = r
      } else {
        const base = lastPre
        r = analyze(d, 'post', m.settings, {
          onProgress,
          forcedDPs: base?.dps.map((p) => ({ id: p.id, name: p.name, x: p.x, y: p.y })),
          base: base ? { grid: base.grid, coverGrid: base.coverGrid, hsgGrid: base.hsgGrid, z: base.z, labels: base.labels } : undefined,
          prePeaks: base ? Object.fromEntries(base.dps.map((p) => [p.id, p.storms.map((s) => s.peak)])) : undefined,
          siteRings: !siteRingsOf(d).length && drawings.pre ? siteRingsOf(drawings.pre) : undefined,
        })
      }
      const { z: _z, ...rest } = r
      // copy the typed arrays we transfer so the cached pre result stays usable
      const result = { ...rest, shade: rest.shade.slice(), labels: rest.labels.slice() }
      post({ type: 'result', id: m.id, condition: m.condition, result }, [result.shade.buffer, result.labels.buffer])
    }
  } catch (e: any) {
    post({ type: 'error', id: m.id, condition: m.type === 'intake' ? 'pre' : m.condition, message: e?.message ?? String(e) })
  }
}
