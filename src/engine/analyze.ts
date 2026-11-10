import Delaunator from 'delaunator'
import {
  GridSpec, MinHeap, Ring, XY, centroid, pointInRing, polyArea, rasterizeRing, ringBBox, simplify, simplifyRing, traceLabels,
} from './geometry'
import {
  COVERS, COVER_KEYS, DT, NSTEP, Outlet, addInto, routeBasin, stats, subHydrograph, tr55StorageRatio,
} from './runoff'
import type {
  AnalysisResult, BasinResult, Condition, CoverKey, CoverRow, DesignPoint, Drawing, Ent, OutletDesign, Role, Settings, Structure,
  Subcatchment, TcSegment, V3,
} from './types'

export interface AnalyzeOptions {
  /** Design points carried over from the other condition so pre/post compare at the same locations. */
  forcedDPs?: { id: string; name: string; x: number; y: number }[]
  /** Existing-condition result, used to fill proposed surface gaps and carry forward undisturbed cover/soils. */
  base?: Pick<AnalysisResult, 'grid' | 'coverGrid' | 'hsgGrid'> & { z?: Float64Array }
  /** Existing peaks by DP id → per storm, for outlet design. */
  prePeaks?: Record<string, number[]>
  onProgress?: (msg: string) => void
}

export interface AnalysisOutput extends AnalysisResult { z: Float64Array }

const SQ2 = Math.SQRT2
const AC = 43560

export function analyze(d: Drawing, condition: Condition, S: Settings, opt: AnalyzeOptions = {}): AnalysisOutput {
  const T0 = performance.now()
  const timings: Record<string, number> = {}
  const mark = (k: string) => (timings[k] = Math.round(performance.now() - T0))
  const warnings: string[] = []
  const say = opt.onProgress ?? (() => {})
  const roleOf = new Map(d.layers.map((l) => [l.name, l.role]))
  const role = (e: Ent): Role => roleOf.get(e.layer) ?? 'reference'
  const byRole = (r: Role | ((r: Role) => boolean)) =>
    d.ents.filter((e) => (typeof r === 'function' ? r(role(e)) : role(e) === r))

  /* ---------------- surface sources ---------------- */
  say('Reading surface')
  const prim = collectSurface(d, byRole('surface'), true)
  const sec = collectSurface(d, byRole('surface-ex'), false)
  if (!prim.pts.length && !prim.faces.length && !sec.pts.length && !sec.faces.length && !opt.base?.z)
    throw new Error('No elevation data found. Assign your contour, TIN, or spot-elevation layers the "Surface" role.')

  const studyRings = byRole('study').filter((e) => e.kind === 'poly' && e.closed).map(toRing)
  let bb = extent([...prim.pts, ...sec.pts, ...prim.faces.flat()])
  if (!Number.isFinite(bb.x0) && opt.base) {
    const g = opt.base.grid
    bb = { x0: g.x0, y0: g.y0, x1: g.x0 + g.nx * g.cs, y1: g.y0 + g.ny * g.cs }
  } else if (opt.base && condition === 'post') {
    const g = opt.base.grid
    bb = { x0: Math.min(bb.x0, g.x0), y0: Math.min(bb.y0, g.y0), x1: Math.max(bb.x1, g.x0 + g.nx * g.cs), y1: Math.max(bb.y1, g.y0 + g.ny * g.cs) }
  }
  if (studyRings.length) {
    const sb = extent(studyRings.flat().map((p) => [p[0], p[1], 0] as V3))
    bb = { x0: Math.max(bb.x0, sb.x0), y0: Math.max(bb.y0, sb.y0), x1: Math.min(bb.x1, sb.x1), y1: Math.min(bb.y1, sb.y1) }
  }
  const area = (bb.x1 - bb.x0) * (bb.y1 - bb.y0)
  if (!(area > 0)) throw new Error('The surface has no extent.')
  const cs = niceCell(Math.sqrt(area / S.targetCells))
  const nx = Math.ceil((bb.x1 - bb.x0) / cs) + 2
  const ny = Math.ceil((bb.y1 - bb.y0) / cs) + 2
  const grid: GridSpec = { nx, ny, x0: bb.x0 - cs, y0: bb.y0 - cs, cs }
  const N = nx * ny
  const cellAc = (cs * cs) / AC
  const cx = (i: number) => grid.x0 + ((i % nx) + 0.5) * cs
  const cy = (i: number) => grid.y0 + (Math.floor(i / nx) + 0.5) * cs
  const cellAt = (x: number, y: number) => {
    const c = Math.floor((x - grid.x0) / cs), r = Math.floor((y - grid.y0) / cs)
    return c < 0 || r < 0 || c >= nx || r >= ny ? -1 : r * nx + c
  }

  say('Building surface')
  const z = new Float64Array(N).fill(NaN)
  buildDEM(prim, grid, z, warnings)
  if (sec.pts.length || sec.faces.length) {
    const z2 = new Float64Array(N).fill(NaN)
    buildDEM(sec, grid, z2, warnings)
    for (let i = 0; i < N; i++) if (Number.isNaN(z[i])) z[i] = z2[i]
  }
  if (opt.base?.z && condition === 'post') {
    const bg = opt.base.grid
    let filled = 0
    for (let i = 0; i < N; i++) {
      if (!Number.isNaN(z[i])) continue
      const c = Math.floor((cx(i) - bg.x0) / bg.cs), r = Math.floor((cy(i) - bg.y0) / bg.cs)
      if (c >= 0 && r >= 0 && c < bg.nx && r < bg.ny) {
        const v = opt.base.z[r * bg.nx + c]
        if (!Number.isNaN(v)) { z[i] = v; filled++ }
      }
    }
    if (filled > 0 && (prim.pts.length || prim.faces.length))
      warnings.push(`Proposed surface merged with the existing surface outside the graded area (${((filled * cs * cs) / AC).toFixed(2)} ac filled from existing).`)
  }
  mark('surface')

  // study mask
  const valid = new Uint8Array(N)
  if (studyRings.length) for (const r of studyRings) rasterizeRing(r, grid, (i) => { if (!Number.isNaN(z[i])) valid[i] = 1 })
  else for (let i = 0; i < N; i++) valid[i] = Number.isNaN(z[i]) ? 0 : 1
  let nValid = 0, zmin = Infinity, zmax = -Infinity
  for (let i = 0; i < N; i++) if (valid[i]) { nValid++; if (z[i] < zmin) zmin = z[i]; if (z[i] > zmax) zmax = z[i] }
  if (nValid < 50) throw new Error('The surface covers too little area to analyze.')
  if (zmax - zmin < 0.25) throw new Error('The surface is flat (relief under 0.25 ft). Check that the contour layers carry elevations.')
  const studyAc = nValid * cellAc

  /* ---------------- cover + soils ---------------- */
  say('Mapping land cover and soils')
  const cover = new Uint8Array(N).fill(255)
  const hsg = new Uint8Array(N).fill(255)
  const carry = S.defaultCover === 'carry' || (condition === 'post' && !!opt.base)
  if (carry && opt.base) {
    const bg = opt.base.grid
    for (let i = 0; i < N; i++) {
      if (!valid[i]) continue
      const c = Math.floor((cx(i) - bg.x0) / bg.cs), r = Math.floor((cy(i) - bg.y0) / bg.cs)
      if (c >= 0 && r >= 0 && c < bg.nx && r < bg.ny) {
        cover[i] = opt.base.coverGrid[r * bg.nx + c]
        hsg[i] = opt.base.hsgGrid[r * bg.nx + c]
      }
    }
  }
  const defCover = COVER_KEYS.indexOf(S.defaultCover === 'carry' ? 'woods' : S.defaultCover)
  const PRIORITY: CoverKey[] = ['woods', 'meadow', 'wetland', 'water', 'grass', 'gravel', 'pavement', 'roof']
  const coverPolys: { k: number; ring: Ring; area: number }[] = []
  for (const e of d.ents) {
    const r = role(e)
    if (!r.startsWith('cover:') || e.kind !== 'poly' || !e.closed) continue
    const key = r.slice(6) as CoverKey
    const ring = toRing(e)
    coverPolys.push({ k: COVER_KEYS.indexOf(key), ring, area: Math.abs(polyArea(ring)) })
  }
  // lower priority first, and larger first within a class so islands win
  coverPolys.sort((a, b) => PRIORITY.indexOf(COVER_KEYS[a.k]) - PRIORITY.indexOf(COVER_KEYS[b.k]) || b.area - a.area)
  for (const p of coverPolys) rasterizeRing(p.ring, grid, (i) => { if (valid[i]) cover[i] = p.k })
  for (let i = 0; i < N; i++) if (valid[i] && cover[i] === 255) cover[i] = defCover

  const soilEnts = byRole('soils')
  const soilPolys = soilEnts.filter((e) => e.kind === 'poly' && e.closed).map(toRing)
  const soilLabels = soilEnts.filter((e) => e.kind === 'text').map((e) => ({ x: e.pts[0][0], y: e.pts[0][1], g: parseHSG(e.text ?? '') })).filter((t) => t.g >= 0)
  let soilHits = 0
  for (const ring of soilPolys.sort((a, b) => Math.abs(polyArea(b)) - Math.abs(polyArea(a)))) {
    const lab = soilLabels.find((t) => pointInRing(t.x, t.y, ring))
    if (!lab) continue
    soilHits++
    rasterizeRing(ring, grid, (i) => { if (valid[i]) hsg[i] = lab.g })
  }
  if (soilPolys.length && !soilHits) warnings.push('Soil polygons found but no HSG labels (e.g. "HSG C") inside them; default HSG used.')
  const defH = 'ABCD'.indexOf(S.defaultHSG)
  for (let i = 0; i < N; i++) if (valid[i] && hsg[i] === 255) hsg[i] = defH
  mark('cover')

  /* ---------------- storm features ---------------- */
  say('Reading drainage structures')
  const basinsIn = byRole('basin').filter((e) => e.kind === 'poly' && e.closed).map(toRing).filter((r) => Math.abs(polyArea(r)) > 4 * cs * cs)
  const basinCell = new Int32Array(N).fill(-1)
  basinsIn.forEach((r, b) => rasterizeRing(r, grid, (i) => { if (valid[i]) basinCell[i] = b }))
  const inBasin = (x: number, y: number) => basinsIn.findIndex((r) => pointInRing(x, y, r))

  const storm = byRole('storm')
  const structures: (Structure & { cell: number; comp: number })[] = []
  const pipes: XY[][] = []
  for (const e of storm) {
    if (e.kind === 'poly') {
      const ring = e.pts.map((p) => [p[0], p[1]] as XY)
      const bbx = ringBBox(ring)
      const diag = Math.hypot(bbx.x1 - bbx.x0, bbx.y1 - bbx.y0)
      if (e.closed && diag < 12) structures.push(mkStruct(centroid(ring), e.layer, '', 0))
      else if (!e.closed) pipes.push(ring)
    } else if (e.kind === 'insert' || e.kind === 'circle' || e.kind === 'point') {
      if (e.kind === 'circle' && (e.r ?? 0) > 12) continue
      structures.push(mkStruct([e.pts[0][0], e.pts[0][1]], e.layer, e.name ?? '', 0))
    }
  }
  function mkStruct(p: XY, layer: string, name: string, _c: number) {
    const n = (name + ' ' + layer).toUpperCase()
    const kind: Structure['kind'] = /OCS|OUTLET.?CONTROL|RISER/.test(n)
      ? 'ocs'
      : /\bMH\b|MANHOLE|DMH|JUNCT|\bJB\b/.test(n)
      ? 'junction'
      : /FES|FLARED|HEADWALL|\bHW\b|OUTFALL|ENDWALL|\bRIP|SPLASH|LEVEL.?SPREAD/.test(n)
      ? 'outfall'
      : 'inlet'
    return { x: p[0], y: p[1], kind, label: name, cell: cellAt(p[0], p[1]), comp: -1 }
  }
  // dedupe structures drawn as block + circle at the same spot
  for (let i = structures.length - 1; i >= 0; i--)
    if (structures.some((s, j) => j < i && Math.hypot(s.x - structures[i].x, s.y - structures[i].y) < 2)) structures.splice(i, 1)

  // pipe network components
  const tol = Math.max(4, 1.5 * cs)
  const ends: { x: number; y: number; pipe: number; s: number }[] = []
  pipes.forEach((p, k) => {
    ends.push({ x: p[0][0], y: p[0][1], pipe: k, s: -1 })
    ends.push({ x: p[p.length - 1][0], y: p[p.length - 1][1], pipe: k, s: -1 })
  })
  const uf = new UF(ends.length + structures.length)
  for (let i = 0; i < ends.length; i += 2) uf.union(i, i + 1)
  for (let i = 0; i < ends.length; i++)
    for (let j = i + 1; j < ends.length; j++) if (Math.hypot(ends[i].x - ends[j].x, ends[i].y - ends[j].y) <= tol) uf.union(i, j)
  structures.forEach((s, k) => {
    let best = -1, bd = tol * 1.5
    for (let i = 0; i < ends.length; i++) {
      const dd = Math.hypot(ends[i].x - s.x, ends[i].y - s.y)
      if (dd <= bd) { bd = dd; best = i }
    }
    if (best >= 0) { uf.union(ends.length + k, best); ends[best].s = k }
    // structures sitting on a pipe vertex mid-run
    if (best < 0)
      pipes.forEach((p, pk) => { if (p.some((v) => Math.hypot(v[0] - s.x, v[1] - s.y) <= tol)) uf.union(ends.length + k, pk * 2) })
  })
  structures.forEach((s, k) => (s.comp = uf.find(ends.length + k)))
  const zAt = (x: number, y: number) => {
    const c = cellAt(x, y)
    if (c >= 0 && !Number.isNaN(z[c])) return z[c]
    // search nearby
    let best = NaN, bd = Infinity
    const c0 = Math.floor((x - grid.x0) / cs), r0 = Math.floor((y - grid.y0) / cs)
    for (let dr = -4; dr <= 4; dr++)
      for (let dc = -4; dc <= 4; dc++) {
        const cc = c0 + dc, rr = r0 + dr
        if (cc < 0 || rr < 0 || cc >= nx || rr >= ny) continue
        const v = z[rr * nx + cc]
        if (!Number.isNaN(v) && dc * dc + dr * dr < bd) { bd = dc * dc + dr * dr; best = v }
      }
    return best
  }
  interface Comp { id: number; points: { x: number; y: number; deg: number; s: number }[]; outfall?: { x: number; y: number }; basinsTouched: Set<number> }
  const comps = new Map<number, Comp>()
  for (let i = 0; i < ends.length; i++) {
    const id = uf.find(i)
    let c = comps.get(id)
    if (!c) comps.set(id, (c = { id, points: [], basinsTouched: new Set() }))
    const near = c.points.find((p) => Math.hypot(p.x - ends[i].x, p.y - ends[i].y) <= tol)
    if (near) { near.deg++; if (ends[i].s >= 0) near.s = ends[i].s }
    else c.points.push({ x: ends[i].x, y: ends[i].y, deg: 1, s: ends[i].s })
  }
  for (const c of comps.values()) {
    for (const p of c.points) { const b = inBasin(p.x, p.y); if (b >= 0) c.basinsTouched.add(b) }
    for (const s of structures) if (s.comp === c.id) { const b = inBasin(s.x, s.y); if (b >= 0) c.basinsTouched.add(b) }
    const cand = c.points.filter((p) => p.deg === 1)
    const pool = cand.length ? cand : c.points
    let best = pool[0], bz = Infinity
    for (const p of pool) {
      // a pipe end beyond the surface is where the pipe leaves the site: treat it as lowest
      const pc = cellAt(p.x, p.y)
      const zz = pc < 0 || Number.isNaN(z[pc]) ? -1e9 : z[pc]
      const bonus = p.s >= 0 && structures[p.s].kind === 'outfall' ? -0.01 : 0
      if (zz + bonus < bz) { bz = zz + bonus; best = p }
    }
    c.outfall = best ? { x: best.x, y: best.y } : undefined
  }

  // inlets = surface sinks
  interface Inlet { x: number; y: number; cell: number; name: string; comp: number; culvert: boolean }
  const inlets: Inlet[] = []
  let cbN = 0, cuN = 0
  for (const s of structures) {
    if (s.kind !== 'inlet') continue
    if (inBasin(s.x, s.y) >= 0) { s.kind = 'ocs'; continue }
    inlets.push({ x: s.x, y: s.y, cell: -1, name: s.label && !/^\*|^A\$|^[0-9A-F]{6,}$/.test(s.label) ? `CB-${++cbN}` : `CB-${++cbN}`, comp: s.comp, culvert: false })
  }
  for (const c of comps.values()) {
    for (const p of c.points) {
      if (p.deg !== 1) continue
      if (c.outfall && p.x === c.outfall.x && p.y === c.outfall.y) continue
      if (p.s >= 0 && (structures[p.s].kind === 'inlet' || structures[p.s].kind === 'junction' || structures[p.s].kind === 'ocs')) continue
      if (inBasin(p.x, p.y) >= 0) continue
      inlets.push({ x: p.x, y: p.y, cell: -1, name: `CULV-${++cuN}`, comp: c.id, culvert: true })
    }
  }
  // snap to lowest valid cell nearby
  for (const it of inlets) it.cell = snapLow(it.x, it.y, 1)
  for (let k = inlets.length - 1; k >= 0; k--) if (inlets[k].cell < 0) inlets.splice(k, 1)

  function snapLow(x: number, y: number, rad: number) {
    const c0 = Math.floor((x - grid.x0) / cs), r0 = Math.floor((y - grid.y0) / cs)
    let best = -1, bz = Infinity
    for (let dr = -rad; dr <= rad; dr++)
      for (let dc = -rad; dc <= rad; dc++) {
        const c = c0 + dc, r = r0 + dr
        if (c < 0 || r < 0 || c >= nx || r >= ny) continue
        const i = r * nx + c
        if (valid[i] && z[i] < bz) { bz = z[i]; best = i }
      }
    return best
  }
  mark('features')

  /* ---------------- flow routing ---------------- */
  say('Routing flow')
  const nb = [1, -1, nx, -nx, nx + 1, nx - 1, -nx + 1, -nx - 1]
  const nbd = [1, 1, 1, 1, SQ2, SQ2, SQ2, SQ2]
  const nbc = [1, -1, 0, 0, 1, -1, 1, -1]
  const nbr = [0, 0, 1, -1, 1, 1, -1, -1]
  const isEdge = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    if (!valid[i]) continue
    const c = i % nx, r = (i - c) / nx
    for (let k = 0; k < 8; k++) {
      const cc = c + nbc[k], rr = r + nbr[k]
      if (cc < 0 || rr < 0 || cc >= nx || rr >= ny || !valid[rr * nx + cc]) { isEdge[i] = 1; break }
    }
  }
  const sinkCells = new Set<number>(inlets.map((i) => i.cell))
  // Inlets are assumed to sit at low points: burn a shallow cone around each so flow on
  // nearly flat pavement reaches them (contours rarely resolve sub-foot sags).
  const zr = z.slice()
  const burnR = Math.max(12, 3 * cs)
  const rc = Math.ceil(burnR / cs)
  for (const it of inlets) {
    const c0 = it.cell % nx, r0 = (it.cell - c0) / nx
    for (let dr = -rc; dr <= rc; dr++)
      for (let dc = -rc; dc <= rc; dc++) {
        const c = c0 + dc, r = r0 + dr
        if (c < 0 || r < 0 || c >= nx || r >= ny) continue
        const dd = Math.hypot(dc, dr) * cs
        if (dd < burnR) zr[r * nx + c] -= 0.5 * (1 - dd / burnR)
      }
  }
  let route = flowRoute(zr, valid, isEdge, sinkCells, grid, nb, nbd, nbc, nbr)

  // design points: forced (from DXF + other condition), snapped onto the flow network
  const dpEnts = byRole('designpoint').filter((e) => e.kind !== 'poly' || e.closed)
  const forcedRaw: { id?: string; name: string; x: number; y: number }[] = []
  for (const e of dpEnts) {
    const p = e.kind === 'poly' ? centroid(toRing(e)) : [e.pts[0][0], e.pts[0][1]]
    if (e.kind === 'text') continue
    forcedRaw.push({ name: '', x: p[0], y: p[1] })
  }
  const dpTexts = byRole('designpoint').filter((e) => e.kind === 'text')
  for (const f of forcedRaw) {
    let best = '', bd = 60
    for (const t of dpTexts) { const dd = Math.hypot(t.pts[0][0] - f.x, t.pts[0][1] - f.y); if (dd < bd) { bd = dd; best = (t.text ?? '').trim() } }
    f.name = best
  }
  for (const f of opt.forcedDPs ?? []) if (!forcedRaw.some((g) => Math.hypot(g.x - f.x, g.y - f.y) < 3 * cs)) forcedRaw.push({ ...f })
  const snapR = Math.max(3, Math.ceil(20 / cs))
  const forced = forcedRaw
    .map((f) => ({ ...f, cell: snapHighAcc(f.x, f.y, snapR, route.acc) }))
    .filter((f) => f.cell >= 0)
  if (forced.length) {
    for (const f of forced) sinkCells.add(f.cell)
    route = flowRoute(zr, valid, isEdge, sinkCells, grid, nb, nbd, nbc, nbr)
  }
  const { dir, acc, filled, order } = route
  function snapHighAcc(x: number, y: number, rad: number, A: Float64Array) {
    const c0 = Math.floor((x - grid.x0) / cs), r0 = Math.floor((y - grid.y0) / cs)
    let best = -1, ba = -1
    for (let dr = -rad; dr <= rad; dr++)
      for (let dc = -rad; dc <= rad; dc++) {
        if (dc * dc + dr * dr > rad * rad) continue
        const c = c0 + dc, r = r0 + dr
        if (c < 0 || r < 0 || c >= nx || r >= ny) continue
        const i = r * nx + c
        if (valid[i] && A[i] > ba) { ba = A[i]; best = i }
      }
    return best
  }
  mark('routing')

  // terminal per cell (ascending order: downstream first)
  const term = new Int32Array(N).fill(-1)
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]
    term[i] = dir[i] < 0 ? i : term[dir[i]]
  }
  // first basin downstream of each cell
  const basinOf = new Int32Array(N).fill(-1)
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]
    basinOf[i] = basinCell[i] >= 0 ? basinCell[i] : dir[i] >= 0 ? basinOf[dir[i]] : -1
  }

  /* ---------------- design points ---------------- */
  const inletByCell = new Map(inlets.map((it, k) => [it.cell, k]))
  const forcedByCell = new Map(forced.map((f, k) => [f.cell, k]))
  const termArea = new Map<number, number>()
  for (let i = 0; i < N; i++) if (valid[i] && dir[i] < 0) termArea.set(i, acc[i] * cellAc)
  const diag = Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0)
  const R = 0.12 * diag
  interface DPw { id: string; name: string; cell: number; forced: boolean }
  const dpList: DPw[] = forced.map((f, k) => ({ id: f.id ?? `DP${k + 1}`, name: f.name || f.id || `DP-${k + 1}`, cell: f.cell, forced: true }))
  const naturals = [...termArea.entries()]
    .filter(([c]) => !inletByCell.has(c) && !forcedByCell.has(c))
    .sort((a, b) => b[1] - a[1])
  const minA = (S.minDPPercent / 100) * studyAc
  for (const [c, a] of naturals) {
    if (a < minA && dpList.length) break
    const near = dpList.some((p) => Math.hypot(cx(p.cell) - cx(c), cy(p.cell) - cy(c)) < R)
    if (near) continue
    dpList.push({ id: '', name: '', cell: c, forced: false })
    if (dpList.length >= 12) break
  }
  // number new DPs after any carried-over ids
  let nextNo = 1
  const usedIds = new Set(dpList.filter((p) => p.id).map((p) => p.id))
  for (const p of dpList) {
    if (p.id) continue
    while (usedIds.has(`DP${nextNo}`)) nextNo++
    p.id = `DP${nextNo}`
    p.name = `DP-${nextNo}`
    usedIds.add(p.id)
  }
  if (condition === 'post' && opt.forcedDPs?.length)
    for (const p of dpList) if (!opt.forcedDPs.some((f) => f.id === p.id)) warnings.push(`${p.name} is a new outfall in the proposed condition with no existing counterpart.`)

  const dpOfTerm = new Map<number, number>()
  for (const [c] of termArea) {
    if (inletByCell.has(c)) continue
    const fk = dpList.findIndex((p) => p.cell === c)
    if (fk >= 0) { dpOfTerm.set(c, fk); continue }
    let best = 0, bd = Infinity
    dpList.forEach((p, k) => { const dd = Math.hypot(cx(p.cell) - cx(c), cy(p.cell) - cy(c)); if (dd < bd) { bd = dd; best = k } })
    dpOfTerm.set(c, best)
  }

  /* ---------------- nodes + subcatchment labels ---------------- */
  // node ids: D<k> design point, I<k> inlet, B<k> basin
  const nodeOfCell = (i: number): string => {
    if (basinOf[i] >= 0) return `B${basinOf[i]}`
    const t = term[i]
    const ik = inletByCell.get(t)
    if (ik != null) return `I${ik}`
    return `D${dpOfTerm.get(t) ?? 0}`
  }
  const unitIndex = new Map<string, number>()
  const unitKeys: string[] = []
  const labels = new Int32Array(N).fill(-1)
  for (let i = 0; i < N; i++) {
    if (!valid[i]) continue
    const key = nodeOfCell(i)
    let u = unitIndex.get(key)
    if (u == null) { u = unitKeys.length; unitIndex.set(key, u); unitKeys.push(key) }
    labels[i] = u
  }
  const nearestDP = (x: number, y: number) => {
    let best = 0, bd = Infinity
    dpList.forEach((p, k) => { const dd = Math.hypot(cx(p.cell) - x, cy(p.cell) - y); if (dd < bd) { bd = dd; best = k } })
    return `D${best}`
  }
  const receiverAt = (x: number, y: number, exclude = -1): string => {
    const b = inBasin(x, y)
    if (b >= 0 && b !== exclude) return `B${b}`
    const c = snapLow(x, y, 1)
    if (c < 0) return nearestDP(x, y)
    if (basinOf[c] >= 0 && basinOf[c] !== exclude) return `B${basinOf[c]}`
    // walk downstream past the excluded basin
    let i = c, guard = 0
    while (basinCell[i] === exclude && exclude >= 0 && dir[i] >= 0 && guard++ < N) i = dir[i]
    if (basinOf[i] >= 0 && basinOf[i] !== exclude) return `B${basinOf[i]}`
    const t = term[i]
    const ik = inletByCell.get(t)
    if (ik != null) return `I${ik}`
    return `D${dpOfTerm.get(t) ?? 0}`
  }
  const receiver = new Map<string, string>()
  const pipedBasin = new Set<number>()
  inlets.forEach((it, k) => {
    const comp = comps.get(it.comp)
    if (comp?.outfall) receiver.set(`I${k}`, receiverAt(comp.outfall.x, comp.outfall.y))
    else {
      receiver.set(`I${k}`, nearestDP(it.x, it.y))
      warnings.push(`${it.name} has no pipe connected; assumed to discharge to the nearest design point.`)
    }
  })
  basinsIn.forEach((ring, b) => {
    const comp = [...comps.values()].find((c) => c.basinsTouched.has(b) && c.outfall && inBasin(c.outfall.x, c.outfall.y) !== b)
    if (comp?.outfall) {
      receiver.set(`B${b}`, receiverAt(comp.outfall.x, comp.outfall.y, b))
      pipedBasin.add(b)
      return
    }
    // overland spill: from the basin cell with the most accumulation
    let o = -1, ba = -1
    for (let i = 0; i < N; i++) if (basinCell[i] === b && acc[i] > ba) { ba = acc[i]; o = i }
    if (o < 0) { receiver.set(`B${b}`, nearestDP(...centroid(ring))); return }
    receiver.set(`B${b}`, receiverAt(cx(o), cy(o), b))
  })
  // break any cycles by sending the node to the nearest DP
  for (const [k] of receiver) {
    const seen = new Set<string>([k])
    let cur = receiver.get(k)
    while (cur && !cur.startsWith('D')) {
      if (seen.has(cur)) { const x = k.startsWith('I') ? inlets[+k.slice(1)] : null; receiver.set(k, x ? nearestDP(x.x, x.y) : 'D0'); break }
      seen.add(cur)
      cur = receiver.get(cur)
    }
  }
  const nodeName = (id: string) =>
    id.startsWith('D') ? dpList[+id.slice(1)]?.name ?? id : id.startsWith('I') ? inlets[+id.slice(1)]?.name ?? id : `Basin ${+id.slice(1) + 1}`
  mark('network')

  /* ---------------- per-unit stats: area, CN, cover table ---------------- */
  say('Computing curve numbers')
  const U = unitKeys.length
  const cnt = new Float64Array(U)
  const coverCount = new Map<string, number>() // `${u}|${cover}|${hsg}`
  for (let i = 0; i < N; i++) {
    const u = labels[i]
    if (u < 0) continue
    cnt[u]++
    const key = `${u}|${cover[i]}|${hsg[i]}`
    coverCount.set(key, (coverCount.get(key) ?? 0) + 1)
  }
  const unitCovers: CoverRow[][] = Array.from({ length: U }, () => [])
  for (const [key, n] of coverCount) {
    const [u, cvi, h] = key.split('|').map(Number)
    const ck = COVER_KEYS[cvi]
    const def = COVERS[ck]
    unitCovers[u].push({ cover: ck, hsg: 'ABCD'[h], areaAc: n * cellAc, cn: def.cn[h], desc: def.desc })
  }

  /* ---------------- time of concentration ---------------- */
  say('Tracing Tc paths')
  const P2 = Math.min(...S.storms.map((s) => s.P))
  const chanCells = S.channelAcres / cellAc
  const stopAt = (i: number) => dir[i] < 0 || (basinOf[i] >= 0 && basinCell[i] >= 0)
  const paved = (i: number) => COVERS[COVER_KEYS[cover[i]]]?.paved ?? false
  const stepT = new Float64Array(N) // concentrated time to unit outlet (s)
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]
    if (stopAt(i)) { stepT[i] = 0; continue }
    const j = dir[i]
    const L = dist(i, j)
    const s = Math.max(0.005, (z[i] - z[j]) / L)
    const V = acc[i] >= chanCells ? (1.49 / S.channelN) * Math.pow(S.channelR, 2 / 3) * Math.sqrt(s) : (paved(i) ? 20.3282 : 16.1345) * Math.sqrt(s)
    stepT[i] = stepT[j] + L / V
  }
  function dist(i: number, j: number) {
    const d = Math.abs(i - j)
    return d === 1 || d === nx ? cs : cs * SQ2
  }
  const sheetEnd = (i: number) => {
    let L = 0, cur = i
    while (!stopAt(cur) && L < S.sheetMax) {
      const j = dir[cur]
      const dl = dist(cur, j)
      if (L + dl > S.sheetMax + 1e-6) break
      L += dl
      cur = j
      if (acc[cur] >= chanCells) break
    }
    return { end: cur, L }
  }
  const sheetTime = (n: number, L: number, s: number) => (0.007 * Math.pow(n * L, 0.8)) / (Math.sqrt(P2) * Math.pow(Math.max(0.005, s), 0.4)) * 3600
  const cand: { i: number; t: number }[][] = Array.from({ length: U }, () => [])
  for (let i = 0; i < N; i++) {
    if (labels[i] < 0 || acc[i] > 1.5) continue
    const { end, L } = sheetEnd(i)
    const n = COVERS[COVER_KEYS[cover[i]]].sheetN
    const t = (L > 0 ? sheetTime(n, L, (z[i] - z[end]) / L) : 0) + stepT[end]
    const arr = cand[labels[i]]
    arr.push({ i, t })
    if (arr.length > 64) { arr.sort((a, b) => b.t - a.t); arr.length = 24 }
  }
  const tcOf: { tc: number; segs: TcSegment[] }[] = []
  for (let u = 0; u < U; u++) {
    const arr = cand[u].sort((a, b) => b.t - a.t).slice(0, 12)
    let best: { tc: number; segs: TcSegment[] } = { tc: 0, segs: [] }
    for (const c of arr) {
      const r = detailTc(c.i)
      if (r.tc > best.tc) best = r
    }
    tcOf.push(best)
  }
  function detailTc(start: number): { tc: number; segs: TcSegment[] } {
    const path = [start]
    let cur = start, guard = 0
    while (!stopAt(cur) && guard++ < N) { cur = dir[cur]; path.push(cur) }
    const segs: TcSegment[] = []
    // cumulative distance
    const cum = [0]
    for (let k = 1; k < path.length; k++) cum.push(cum[k - 1] + dist(path[k - 1], path[k]))
    const total = cum[cum.length - 1]
    if (total <= 0) return { tc: 0, segs }
    let k0 = 0
    // sheet
    let k1 = 0
    while (k1 + 1 < path.length && cum[k1 + 1] <= S.sheetMax + 1e-6 && acc[path[k1 + 1]] < chanCells) k1++
    if (k1 > 0) {
      const L = cum[k1]
      const s = Math.max(0.005, (z[path[0]] - z[path[k1]]) / L)
      const ck = COVER_KEYS[cover[path[0]]]
      const n = COVERS[ck].sheetN
      const t = sheetTime(n, L, s)
      segs.push({ type: 'sheet', surface: COVERS[ck].desc.split(',')[0], L, s, n, V: L / t, t: t / 60, path: path.slice(0, k1 + 1).map(xy) })
      k0 = k1
    }
    // shallow concentrated, split where paved/unpaved changes (min run 3 cells)
    let kc = k0
    while (kc < path.length - 1 && acc[path[kc]] < chanCells) kc++
    // runs of paved / unpaved; runs shorter than 40 ft fold into their neighbour
    const runs: { a: number; b: number; pv: boolean }[] = []
    for (let a = k0; a < kc; ) {
      const pv = paved(path[a])
      let b = a + 1
      while (b < kc && paved(path[b]) === pv) b++
      runs.push({ a, b, pv })
      a = b
    }
    for (let changed = true; changed && runs.length > 1; ) {
      changed = false
      let si = -1, sl = Infinity
      runs.forEach((r, i) => { const L = cum[r.b] - cum[r.a]; if (L < 40 && L < sl) { sl = L; si = i } })
      if (si >= 0) {
        const r = runs[si]
        const j = si > 0 ? si - 1 : si + 1
        const o = runs[j]
        o.a = Math.min(o.a, r.a); o.b = Math.max(o.b, r.b)
        runs.splice(si, 1)
        changed = true
      }
      for (let i = runs.length - 1; i > 0; i--)
        if (runs[i].pv === runs[i - 1].pv) { runs[i - 1].b = runs[i].b; runs.splice(i, 1); changed = true }
    }
    for (const { a, b, pv } of runs) {
      const L = cum[b] - cum[a]
      if (L <= 0) continue
      const s = Math.max(0.005, (z[path[a]] - z[path[b]]) / L)
      const V = (pv ? 20.3282 : 16.1345) * Math.sqrt(s)
      segs.push({ type: 'shallow', surface: pv ? 'Paved' : 'Unpaved', L, s, V, t: L / V / 60, path: path.slice(a, b + 1).map(xy) })
    }
    if (kc < path.length - 1) {
      const L = cum[path.length - 1] - cum[kc]
      const s = Math.max(0.005, (z[path[kc]] - z[path[path.length - 1]]) / L)
      const V = (1.49 / S.channelN) * Math.pow(S.channelR, 2 / 3) * Math.sqrt(s)
      segs.push({ type: 'channel', surface: `Channel n=${S.channelN}`, L, s, n: S.channelN, V, t: L / V / 60, path: path.slice(kc).map(xy) })
    }
    return { tc: segs.reduce((x, s) => x + s.t, 0), segs }
  }
  function xy(i: number): XY { return [cx(i), cy(i)] }
  mark('tc')

  /* ---------------- polygons + label anchors ---------------- */
  say('Drawing subcatchments')
  const traced = traceLabels(labels, grid)
  const anchor = labelAnchors(labels, grid)

  /* ---------------- hydrographs ---------------- */
  say('Running hydrographs')
  const subs: Subcatchment[] = []
  const prefix = condition === 'pre' ? 'E' : 'P'
  const unitOrder = [...Array(U).keys()].sort((a, b) => cnt[b] - cnt[a])
  const subNo = new Map<number, number>()
  unitOrder.forEach((u, k) => subNo.set(u, k + 1))
  for (let u = 0; u < U; u++) {
    const key = unitKeys[u]
    const areaAc = cnt[u] * cellAc
    const covers = unitCovers[u].sort((a, b) => b.areaAc - a.areaAc)
    const cn = covers.reduce((s, c) => s + c.cn * c.areaAc, 0) / Math.max(1e-9, areaAc)
    const imp = covers.filter((c) => COVERS[c.cover].imperv).reduce((s, c) => s + c.areaAc, 0)
    const tcRaw = tcOf[u].tc
    const tcMin = Math.max(S.minTcMin, tcRaw)
    const storms = S.storms.map((st) => subHydrograph(areaAc, cn, tcMin / 60, st.P, S.distribution))
    const kind: Subcatchment['kind'] = key[0] === 'D' ? 'dp' : key[0] === 'I' ? 'inlet' : 'basin'
    const to = key[0] === 'D' ? key : key
    const speck = 4 * cs * cs // drop single-cell slivers left by diagonal D8 joins
    const rings = (traced.get(u) ?? [])
      .filter((r) => Math.abs(polyArea(r.outer)) >= speck)
      .map((r) => ({ outer: simplifyRing(r.outer, 1.0 * cs), holes: r.holes.filter((h) => Math.abs(polyArea(h)) >= speck).map((h) => simplifyRing(h, 1.0 * cs)) }))
    subs.push({
      id: `S${u}`,
      name: `${prefix}${subNo.get(u)}`,
      kind,
      to,
      toName: nodeName(to),
      areaAc,
      cn: Math.round(cn * 10) / 10,
      impervPct: (100 * imp) / Math.max(1e-9, areaAc),
      tcMin,
      tcRaw,
      segments: tcOf[u].segs.map((s) => ({ ...s, path: simplify(s.path, 0.5 * cs) })),
      rings,
      label: anchor.get(u) ?? [cx(0), cy(0)],
      covers: mergeCovers(covers),
      storms: storms.map((r, k) => ({ P: S.storms[k].P, Q: r.Q, peak: r.peak, tpeak: r.tpeak, volAcFt: r.vol })),
      hydro: storms.map((r) => r.q),
    })
  }
  subs.sort((a, b) => +a.name.slice(1) - +b.name.slice(1))

  /* ---------------- node routing ---------------- */
  const nodeIds = new Set<string>([...dpList.map((_, k) => `D${k}`), ...inlets.map((_, k) => `I${k}`), ...basinsIn.map((_, k) => `B${k}`)])
  const ns = S.storms.length
  const blank = () => S.storms.map(() => new Float32Array(NSTEP + 1))
  const inflow = new Map<string, Float32Array[]>()
  for (const id of nodeIds) inflow.set(id, blank())
  for (const s of subs) {
    const h = inflow.get(s.to)!
    s.hydro.forEach((q, k) => addInto(h[k], q))
  }
  // topological order
  const indeg = new Map<string, number>()
  for (const id of nodeIds) indeg.set(id, 0)
  for (const [, to] of receiver) indeg.set(to, (indeg.get(to) ?? 0) + 1)
  const topo: string[] = []
  const q: string[] = [...nodeIds].filter((id) => !indeg.get(id))
  while (q.length) {
    const id = q.shift()!
    topo.push(id)
    const to = receiver.get(id)
    if (to) { indeg.set(to, indeg.get(to)! - 1); if (!indeg.get(to)) q.push(to) }
  }

  // basin geometry
  const basins: BasinResult[] = basinsIn.map((ring, b) => {
    const cells: number[] = []
    for (let i = 0; i < N; i++) if (basinCell[i] === b) cells.push(i)
    let bottom = Infinity
    for (const i of cells) bottom = Math.min(bottom, z[i])
    // rim = lowest elevation along the polygon boundary
    let rim = Infinity
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], c = ring[(k + 1) % ring.length]
      const L = Math.hypot(c[0] - a[0], c[1] - a[1])
      const n = Math.max(1, Math.ceil(L / cs))
      for (let t = 0; t <= n; t++) {
        const zz = zAt(a[0] + ((c[0] - a[0]) * t) / n, a[1] + ((c[1] - a[1]) * t) / n)
        if (!Number.isNaN(zz)) rim = Math.min(rim, zz)
      }
    }
    if (!Number.isFinite(rim) || rim <= bottom) rim = bottom + 0.5
    const storage: { z: number; S: number }[] = []
    const steps = 24
    for (let k = 0; k <= steps; k++) {
      const h = bottom + ((rim - bottom) * k) / steps
      let Sv = 0
      for (const i of cells) if (h > z[i]) Sv += (h - z[i]) * cs * cs
      storage.push({ z: h, S: Sv })
    }
    // extend one foot above rim for overtopping
    const top = storage[storage.length - 1]
    const areaRim = cells.length * cs * cs
    storage.push({ z: rim + 1, S: top.S + areaRim })
    return {
      id: `B${b}`, name: `Basin ${b + 1}`, ring, bottom, rim, storage, maxStorage: top.S,
      outflowTo: nodeName(receiver.get(`B${b}`) ?? 'D0'), piped: pipedBasin.has(b), inflow: [],
    }
  })

  const outflowOf = new Map<string, Float32Array[]>()
  const dpTarget = (id: string): string => {
    let cur = id, g = 0
    while (!cur.startsWith('D') && g++ < 100) cur = receiver.get(cur) ?? 'D0'
    return cur
  }
  const runNetwork = (outlets: Map<number, Outlet | null>) => {
    const acc2 = new Map<string, Float32Array[]>()
    for (const id of nodeIds) acc2.set(id, inflow.get(id)!.map((a) => a.slice()))
    const basinRuns = new Map<number, ReturnType<typeof routeBasin>[]>()
    for (const id of topo) {
      const inH = acc2.get(id)!
      let outH = inH
      if (id.startsWith('B')) {
        const b = +id.slice(1)
        const o = outlets.get(b)
        if (o) {
          const runs = inH.map((h) => routeBasin(h, basins[b].storage, o))
          basinRuns.set(b, runs)
          outH = runs.map((r) => r.out)
        }
      }
      outflowOf.set(id, outH)
      const to = receiver.get(id)
      if (to) { const t = acc2.get(to)!; outH.forEach((h, k) => addInto(t[k], h)) }
    }
    return { acc2, basinRuns }
  }

  // outlet design
  const outlets = new Map<number, Outlet | null>()
  basins.forEach((_, b) => outlets.set(b, null))
  let net = runNetwork(outlets)
  basins.forEach((B, b) => (B.inflow = net.acc2.get(`B${b}`)!.map((h) => { const st = stats(h); return { peak: st.peak, volAcFt: st.vol } })))
  if (basins.length && opt.prePeaks) {
    say('Sizing basin outlets')
    for (let b = 0; b < basins.length; b++) {
      const B = basins[b]
      const target = dpTarget(`B${b}`)
      const pre = opt.prePeaks[dpList[+target.slice(1)]?.id ?? '']
      if (!pre) continue
      const des = designOutlet(b, B, target, pre)
      outlets.set(b, des.outlet)
      B.outlet = des.design
      net = runNetwork(outlets)
    }
  } else if (basins.length) {
    // without existing peaks, route through a nominal 12" orifice so storage still attenuates
    basins.forEach((B, b) => outlets.set(b, { invert: B.bottom, orificeD: 1, weirCrest: null, weirL: 0, rim: B.rim, spillL: 10 }))
    net = runNetwork(outlets)
    warnings.push('Basin outlets are not sized yet. Analyze the existing condition so Drainage Analyst can size them to match existing peaks.')
  }

  function designOutlet(b: number, B: BasinResult, target: string, pre: number[]) {
    const inH = net.acc2.get(`B${b}`)!
    const dpAll = net.acc2.get(target)!
    const myOut = outflowOf.get(`B${b}`)!
    const other = dpAll.map((h, k) => { const o = h.slice(); for (let i = 0; i < o.length; i++) o[i] -= myOut[k][i]; return o })
    const peakWith = (k: number, out: Float32Array) => { let p = 0; for (let i = 0; i < out.length; i++) p = Math.max(p, other[k][i] + out[i]); return p }
    const sizes = [2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 21, 24, 30, 36]
    const mk = (D: number, crest: number | null, L: number): Outlet => ({ invert: B.bottom, orificeD: D / 12, weirCrest: crest, weirL: L, rim: B.rim, spillL: 10 })
    const sm = S.storms.map((s, k) => k).sort((a, c) => S.storms[a].P - S.storms[c].P)
    const k0 = sm[0]
    let D = sizes[0]
    for (const s of sizes) {
      const r = routeBasin(inH[k0], B.storage, mk(s, null, 0))
      if (peakWith(k0, r.out) <= pre[k0] * 1.0 && !r.overtops) D = s
      else break
    }
    const r2 = routeBasin(inH[k0], B.storage, mk(D, null, 0))
    let crest: number | null = Math.round((r2.maxZ + 0.1) * 100) / 100
    if (crest >= B.rim - 0.25) crest = null
    const Ls = [1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30]
    const evalAll = (o: Outlet) => S.storms.map((_, k) => {
      const r = routeBasin(inH[k], B.storage, o)
      return { r, peak: peakWith(k, r.out) }
    })
    let bestO = mk(D, crest, 0)
    let bestRes = evalAll(bestO)
    const ok = (res: typeof bestRes) => res.every((x, k) => x.peak <= pre[k] * 1.0001 && !x.r.overtops)
    if (crest != null && !ok(bestRes)) {
      let chosen: { o: Outlet; res: typeof bestRes } | null = null
      for (const L of Ls) {
        const o = mk(D, crest, L)
        const res = evalAll(o)
        // first length that keeps every storm in the basin, then keep growing while peaks still match
        if (res.every((x) => !x.r.overtops)) {
          if (res.every((x, k) => x.peak <= pre[k] * 1.0001)) chosen = { o, res }
          else if (!chosen) chosen = { o, res }
          else break
        }
      }
      if (chosen) { bestO = chosen.o; bestRes = chosen.res }
    }
    const design: OutletDesign = {
      orificeIn: D,
      weirCrest: bestO.weirCrest != null && bestO.weirL > 0 ? bestO.weirCrest : null,
      weirLength: bestO.weirCrest != null && bestO.weirL > 0 ? bestO.weirL : null,
      results: bestRes.map((x, k) => ({ peakIn: stats(inH[k]).peak, peakOut: stats(x.r.out).peak, stage: x.r.maxZ, storage: x.r.maxS, overtops: x.r.overtops })),
      meetsAll: ok(bestRes),
    }
    return { outlet: bestO, design }
  }

  const dps: DesignPoint[] = dpList.map((p, k) => {
    const h = net.acc2.get(`D${k}`)!
    let trib = 0, imp = 0
    for (const s of subs) if (dpTarget(s.to) === `D${k}`) { trib += s.areaAc; imp += (s.areaAc * s.impervPct) / 100 }
    return {
      id: p.id, name: p.name, x: cx(p.cell), y: cy(p.cell), forced: p.forced,
      storms: h.map((q) => { const st = stats(q); return { peak: st.peak, tpeak: st.tpeak, volAcFt: st.vol } }),
      hydro: h, tributaryAc: trib, impervAc: imp,
    }
  })
  for (const s of subs) s.toName = nodeName(s.to)
  mark('hydro')

  /* ---------------- display layers ---------------- */
  const shade = hillshade(z, valid, grid, zmin, zmax)
  const contours: XY[][] = []
  let budget = 250000
  for (const e of [...byRole('surface'), ...byRole('surface-ex')]) {
    if (e.kind !== 'poly') continue
    const p = simplify(e.pts.map((v) => [v[0], v[1]] as XY), cs * 0.25)
    budget -= p.length
    if (budget < 0) break
    contours.push(p)
  }
  const reference: XY[][] = []
  let rb = 120000
  for (const e of d.ents) {
    const r = role(e)
    if (e.kind !== 'poly' || r === 'surface' || r === 'surface-ex' || r === 'ignore' || r === 'storm') continue
    rb -= e.pts.length
    if (rb < 0) break
    reference.push(e.pts.map((v) => [v[0], v[1]] as XY))
  }
  const structsOut: Structure[] = [
    ...structures.filter((s) => s.kind !== 'inlet').map((s) => ({ x: s.x, y: s.y, kind: s.kind, label: s.label })),
    ...inlets.map((it, k) => ({ x: it.x, y: it.y, kind: 'inlet' as const, label: it.name, to: nodeName(receiver.get(`I${k}`) ?? '') })),
  ]
  mark('done')

  return {
    condition, fileName: d.fileName, settings: S, grid, bbox: bb, zmin, zmax, studyAc, dt: DT,
    subs, dps, basins, structures: structsOut, pipes, reference, contours, shade, labels,
    coverGrid: cover, hsgGrid: hsg, warnings, timings, z,
  }
}

/* ======================================================================= */

function toRing(e: Ent): Ring {
  const r = e.pts.map((p) => [p[0], p[1]] as XY)
  if (r.length > 2 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop()
  return r
}

function extent(pts: V3[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0]
    if (p[1] < y0) y0 = p[1]
    if (p[0] > x1) x1 = p[0]
    if (p[1] > y1) y1 = p[1]
  }
  return { x0, y0, x1, y1 }
}

function niceCell(c: number) {
  const steps = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12.5, 15, 20, 25, 30, 40, 50, 75, 100]
  for (const s of steps) if (s >= c) return s
  return Math.ceil(c / 50) * 50
}

function parseHSG(t: string) {
  const s = t.toUpperCase()
  const m = /HSG[\s:=\-]*([ABCD])(\/D)?/.exec(s) ?? /^\s*\(?([ABCD])(\/D)?\)?\s*$/.exec(s) ?? /\b([ABCD])\/D\b/.exec(s)
  if (!m) return -1
  return m[2] ? 3 : 'ABCD'.indexOf(m[1])
}

interface SurfSrc { pts: V3[]; faces: V3[][] }

function collectSurface(d: Drawing, ents: Ent[], includeTin: boolean): SurfSrc {
  const pts: V3[] = []
  const faces: V3[][] = []
  if (includeTin && d.tin) for (const t of d.tin.tris) faces.push([d.tin.pts[t[0]], d.tin.pts[t[1]], d.tin.pts[t[2]]])
  let totalLen = 0
  for (const e of ents) if (e.kind === 'poly' && e.hasZ) for (let k = 1; k < e.pts.length; k++) totalLen += Math.hypot(e.pts[k][0] - e.pts[k - 1][0], e.pts[k][1] - e.pts[k - 1][1])
  const spacing = Math.max(2, totalLen / 350000)
  for (const e of ents) {
    if (e.kind === 'face') faces.push(e.pts)
    else if (e.kind === 'poly' && e.hasZ) {
      for (let k = 0; k < e.pts.length; k++) {
        const a = e.pts[k]
        pts.push(a)
        const b = e.pts[k + 1]
        if (!b) break
        const L = Math.hypot(b[0] - a[0], b[1] - a[1])
        const n = Math.floor(L / spacing)
        for (let j = 1; j < n; j++) {
          const t = j / n
          pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])
        }
      }
    } else if ((e.kind === 'point' || e.kind === 'insert') && e.hasZ) pts.push(e.pts[0])
  }
  return { pts, faces }
}

function buildDEM(src: SurfSrc, g: GridSpec, z: Float64Array, warnings: string[]) {
  if (src.faces.length >= 2) {
    for (const f of src.faces) rasterTri(f[0], f[1], f[2], g, z)
    if (src.pts.length < 3) return
  }
  if (src.pts.length < 3) return
  // dedupe identical xy
  const seen = new Map<string, V3>()
  for (const p of src.pts) seen.set(`${p[0].toFixed(3)},${p[1].toFixed(3)}`, p)
  const P = [...seen.values()]
  const coords = new Float64Array(P.length * 2)
  P.forEach((p, i) => { coords[2 * i] = p[0]; coords[2 * i + 1] = p[1] })
  const del = new Delaunator(coords)
  const T = del.triangles, H = del.halfedges
  const nt = T.length / 3
  const elen = (e: number) => {
    const a = T[e], b = T[e % 3 === 2 ? e - 2 : e + 1]
    return Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1])
  }
  const lens: number[] = []
  for (let e = 0; e < T.length; e += 7) lens.push(elen(e))
  lens.sort((a, b) => a - b)
  const thr = Math.max(3 * (lens[Math.floor(lens.length * 0.95)] ?? 0), 6 * g.cs)
  // peel long-edged triangles inward from the hull
  const removed = new Uint8Array(nt)
  const queue: number[] = []
  for (let e = 0; e < H.length; e++) if (H[e] === -1) queue.push(Math.floor(e / 3))
  while (queue.length) {
    const t = queue.pop()!
    if (removed[t]) continue
    let peel = false
    for (let k = 0; k < 3; k++) {
      const e = 3 * t + k
      const o = H[e]
      if ((o === -1 || removed[Math.floor(o / 3)]) && elen(e) > thr) { peel = true; break }
    }
    if (!peel) continue
    removed[t] = 1
    for (let k = 0; k < 3; k++) { const o = H[3 * t + k]; if (o !== -1) queue.push(Math.floor(o / 3)) }
  }
  let flat = 0
  for (let t = 0; t < nt; t++) {
    if (removed[t]) continue
    const a = P[T[3 * t]], b = P[T[3 * t + 1]], c = P[T[3 * t + 2]]
    if (a[2] === b[2] && b[2] === c[2]) flat++
    rasterTri(a, b, c, g, z)
  }
  if (flat / nt > 0.35) warnings.push('Many flat triangles in the contour triangulation; add spot elevations or a TIN for better flow paths in flat areas.')
}

function rasterTri(a: V3, b: V3, c: V3, g: GridSpec, z: Float64Array) {
  const minx = Math.min(a[0], b[0], c[0]), maxx = Math.max(a[0], b[0], c[0])
  const miny = Math.min(a[1], b[1], c[1]), maxy = Math.max(a[1], b[1], c[1])
  const c0 = Math.max(0, Math.ceil((minx - g.x0) / g.cs - 0.5)), c1 = Math.min(g.nx - 1, Math.floor((maxx - g.x0) / g.cs - 0.5))
  const r0 = Math.max(0, Math.ceil((miny - g.y0) / g.cs - 0.5)), r1 = Math.min(g.ny - 1, Math.floor((maxy - g.y0) / g.cs - 0.5))
  const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
  if (Math.abs(det) < 1e-12) return
  for (let r = r0; r <= r1; r++) {
    const y = g.y0 + (r + 0.5) * g.cs
    for (let col = c0; col <= c1; col++) {
      const x = g.x0 + (col + 0.5) * g.cs
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det
      const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det
      const l3 = 1 - l1 - l2
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue
      z[r * g.nx + col] = l1 * a[2] + l2 * b[2] + l3 * c[2]
    }
  }
}

function flowRoute(
  z: Float64Array, valid: Uint8Array, isEdge: Uint8Array, sinks: Set<number>, g: GridSpec,
  nb: number[], nbd: number[], nbc: number[], nbr: number[],
) {
  const { nx, ny, cs } = g
  const N = nx * ny
  const filled = new Float64Array(N).fill(NaN)
  const closed = new Uint8Array(N)
  const dir = new Int32Array(N).fill(-1)
  const heap = new MinHeap(Math.max(1024, N >> 3))
  const eps = 1e-5
  for (let i = 0; i < N; i++) if (valid[i] && (isEdge[i] || sinks.has(i))) { closed[i] = 1; filled[i] = z[i]; heap.push(z[i], i) }
  while (heap.size) {
    const c = heap.pop()
    const col = c % nx, row = (c - col) / nx
    for (let k = 0; k < 8; k++) {
      const cc = col + nbc[k], rr = row + nbr[k]
      if (cc < 0 || rr < 0 || cc >= nx || rr >= ny) continue
      const n = c + nb[k]
      if (closed[n] || !valid[n]) continue
      closed[n] = 1
      filled[n] = Math.max(z[n], filled[c] + eps)
      heap.push(filled[n], n)
    }
  }
  // steepest descent on the conditioned surface
  for (let i = 0; i < N; i++) {
    if (!valid[i] || sinks.has(i)) continue
    const col = i % nx, row = (i - col) / nx
    let best = -1, bs = 0
    for (let k = 0; k < 8; k++) {
      const cc = col + nbc[k], rr = row + nbr[k]
      if (cc < 0 || rr < 0 || cc >= nx || rr >= ny) continue
      const n = i + nb[k]
      if (!valid[n]) continue
      const s = (filled[i] - filled[n]) / (nbd[k] * cs)
      if (s > bs) { bs = s; best = n }
    }
    dir[i] = best // edge cells with no lower neighbour stay terminal (-1)
  }
  // order: highest first
  let nv = 0
  for (let i = 0; i < N; i++) if (valid[i]) nv++
  const order = new Int32Array(nv)
  let k = 0
  for (let i = 0; i < N; i++) if (valid[i]) order[k++] = i
  order.sort((a, b) => filled[b] - filled[a])
  const acc = new Float64Array(N)
  for (let j = 0; j < nv; j++) acc[order[j]] = 1
  for (let j = 0; j < nv; j++) { const i = order[j]; if (dir[i] >= 0) acc[dir[i]] += acc[i] }
  return { dir, acc, filled, order }
}

function labelAnchors(labels: Int32Array, g: GridSpec) {
  const { nx, ny } = g
  const N = nx * ny
  const D = new Float32Array(N)
  for (let i = 0; i < N; i++) D[i] = labels[i] < 0 ? 0 : 1e9
  const diff = (i: number, j: number) => labels[i] !== labels[j]
  for (let r = 0; r < ny; r++)
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c
      if (!D[i]) continue
      if (c === 0 || r === 0 || c === nx - 1 || r === ny - 1) { D[i] = 1; continue }
      if (diff(i, i - 1) || diff(i, i - nx)) D[i] = 1
      else D[i] = Math.min(D[i], D[i - 1] + 1, D[i - nx] + 1, D[i - nx - 1] + 1.414, D[i - nx + 1] + 1.414)
    }
  for (let r = ny - 1; r >= 0; r--)
    for (let c = nx - 1; c >= 0; c--) {
      const i = r * nx + c
      if (!D[i] || c === nx - 1 || r === ny - 1 || c === 0) continue
      if (diff(i, i + 1) || diff(i, i + nx)) D[i] = Math.min(D[i], 1)
      else D[i] = Math.min(D[i], D[i + 1] + 1, D[i + nx] + 1, D[i + nx + 1] + 1.414, D[i + nx - 1] + 1.414)
    }
  const best = new Map<number, { i: number; d: number }>()
  for (let i = 0; i < N; i++) {
    const L = labels[i]
    if (L < 0) continue
    const b = best.get(L)
    if (!b || D[i] > b.d) best.set(L, { i, d: D[i] })
  }
  const out = new Map<number, XY>()
  for (const [L, b] of best) out.set(L, [g.x0 + ((b.i % nx) + 0.5) * g.cs, g.y0 + (Math.floor(b.i / nx) + 0.5) * g.cs])
  return out
}

function hillshade(z: Float64Array, valid: Uint8Array, g: GridSpec, zmin: number, zmax: number) {
  const { nx, ny, cs } = g
  const out = new Uint8ClampedArray(nx * ny * 4)
  const az = (315 * Math.PI) / 180, alt = (45 * Math.PI) / 180
  const exag = 2.5
  for (let r = 0; r < ny; r++)
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c
      if (!valid[i]) continue
      const zz = (cc: number, rr: number) => {
        cc = Math.max(0, Math.min(nx - 1, cc)); rr = Math.max(0, Math.min(ny - 1, rr))
        const v = z[rr * nx + cc]
        return Number.isNaN(v) ? z[i] : v
      }
      const dzdx = ((zz(c + 1, r) - zz(c - 1, r)) / (2 * cs)) * exag
      const dzdy = ((zz(c, r + 1) - zz(c, r - 1)) / (2 * cs)) * exag
      const slope = Math.atan(Math.hypot(dzdx, dzdy))
      const aspect = Math.atan2(dzdy, -dzdx)
      let hs = Math.cos(alt) * Math.cos(slope) + Math.sin(alt) * Math.sin(slope) * Math.cos(az - aspect)
      hs = Math.max(0, Math.min(1, hs))
      const t = (z[i] - zmin) / Math.max(1e-9, zmax - zmin)
      const v = Math.round(60 + 170 * hs)
      out[4 * i] = v
      out[4 * i + 1] = v
      out[4 * i + 2] = v
      out[4 * i + 3] = Math.round(255 * (0.55 + 0.45 * t))
    }
  return out
}

function mergeCovers(rows: CoverRow[]) {
  const m = new Map<string, CoverRow>()
  for (const r of rows) {
    const k = `${r.cover}|${r.hsg}`
    const e = m.get(k)
    if (e) e.areaAc += r.areaAc
    else m.set(k, { ...r })
  }
  return [...m.values()].sort((a, b) => b.areaAc - a.areaAc)
}

class UF {
  p: Int32Array
  constructor(n: number) { this.p = new Int32Array(n).map((_, i) => i) }
  find(a: number): number { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a] } return a }
  union(a: number, b: number) { a = this.find(a); b = this.find(b); if (a !== b) this.p[a] = b }
}
