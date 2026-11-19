// Claude delineation: Claude draws the subcatchments (judgment), the engine computes everything from them.
import type { AiContext, AiModel, AnalysisResult, Condition } from './engine/types'

export interface AiConfig {
  apiKey: string
  model: string
  /** Messages endpoint. Point this at your own proxy to keep the key off the browser. */
  endpoint: string
  /** run Claude automatically after each analysis */
  auto: boolean
}

export const DEFAULT_AI: AiConfig = { apiKey: '', model: 'claude-opus-5-5', endpoint: 'https://api.anthropic.com/v1/messages', auto: false }
const LS = 'apollo-drainage-ai-v1'

export function loadAi(): AiConfig {
  try { return { ...DEFAULT_AI, ...(JSON.parse(localStorage.getItem(LS) ?? 'null') ?? {}) } } catch { return DEFAULT_AI }
}
export function saveAi(c: AiConfig) {
  try { localStorage.setItem(LS, JSON.stringify(c)) } catch { /* storage unavailable */ }
}
export const aiReady = (c: AiConfig) => !!c.apiKey || !/api\.anthropic\.com/.test(c.endpoint)

const SYSTEM = `You are a senior civil engineer delineating drainage subcatchments for a pre/post stormwater analysis. You are given a site plan image with a coordinate grid, the same plan as structured data, and sometimes the engineer's plan sheet as a PDF. You draw the subcatchments; software then computes area, curve number, time of concentration and hydrographs from exactly what you draw.

Coordinates: feet, x to the right, y up, origin at the lower-left corner of the image. Use the data's coordinates for buildings, structures, walls and the analysis bounds rather than estimating them from the image.

How to delineate:
- Work only inside the analysis bounds. Your polygons must cover all of it, with no gaps and no overlaps. Share vertices along common edges.
- Every roof is its own subcatchment (kind "roof", named R-1, R-2 ...), using the building outline from the data, with "building" set to its id. If ridge or valley lines show how the roof pitches, split it and give each pitch its own subcatchment. Where an infiltration trench is drawn along the eaves (listed among the BMPs in the data as kind "trench"), the roof drains to that trench: set the outlet to the trench. Otherwise the roof drains to the ground or structure just below its eaves: set the outlet there.
- One surface subcatchment per receiving inlet or design point: if two areas reach the same catch basin (even by different routes, such as along a wall face and across a yard), they are one subcatchment.
- Every inlet that collects surface runoff (catch basin, drop inlet, yard drain, culvert inlet, basin) gets the ground area that actually reaches it (kind "surface", named S-1, S-2 ...). A structure labelled "INV IN", "CB" or "RIM" at a pipe end is a structure. A pipe end with no structure — a roof leader, foundation drain or wall underdrain — collects no surface water, so never give it a subcatchment. Manholes and cleanouts collect no surface water.
- Decide divides from spot grades, contours, the elevation grid, curbs, crowns, high points, building faces and swales. Runoff does not cross a building or a curb line. Do not create a separate subcatchment for an area that simply flows on into a neighbouring area: merge it into the area it flows through.
- Retaining walls: where the data says a wall's top stands above the uphill ground, the wall is a barrier. Water on the uphill side never crosses it, not over it and not through an underdrain. It is carried along the wall face to the inlet the wall was built to feed, normally the nearest catch basin at or just beyond the wall's end. Route those areas to that inlet, not to a design point beyond the wall, and draw the divide along the wall. Only the strip on the downhill side of the wall drains past it. Where the wall is flush with the ground, ignore it: flow passes over.
- Design points: area leaving the analysis bounds overland is assigned to a design point. The design points listed in the data must all be used, and "design_point" on every subcatchment names the design point its runoff finally reaches (through any inlets and pipes). The existing and proposed conditions are compared at the same design points, so do not invent new ones unless the instructions below allow it.
- Outlet: the x,y of the receiving structure taken from the data (or the design point), and its name as labelled on the plan (for example "CB 221").
- Flow path: the longest hydraulic path within the subcatchment as a polyline, from the most remote point to the outlet, following the direction water runs. Omit it for roofs.
- Keep polygons simple: at most about 40 vertices each.
- Where the plan does not show enough to be sure (no grading, missing pipes), make the most reasonable engineering assumption and record it in that subcatchment's note and in the assumptions list.

Answer only by calling submit_subcatchments, exactly once, with the complete delineation. Do not reply in text.`

const TOOL = {
  name: 'submit_subcatchments',
  description: 'Submit the complete subcatchment delineation for this condition.',
  input_schema: {
    type: 'object',
    properties: {
      subcatchments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'R-n for roofs, S-n for surface areas' },
            kind: { type: 'string', enum: ['roof', 'surface'] },
            description: { type: 'string', description: 'What this area is, in a few words' },
            polygon: { type: 'array', description: 'Closed outline as [x, y] pairs in feet', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, minItems: 3 },
            building: { type: 'string', description: 'Roofs: the building id from the data, e.g. B1' },
            drip_edges: { type: 'array', description: 'Roofs: eave polylines where this roof surface sheds water', items: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, minItems: 2 } },
            design_point: { type: 'string', description: 'Name of the design point this runoff finally reaches' },
            outlet: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' }, name: { type: 'string' } },
              required: ['x', 'y', 'name'],
            },
            flow_path: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
            note: { type: 'string', description: 'Routing and any assumption, e.g. "Roof drain > 6 in HDPE > CB 221"' },
          },
          required: ['name', 'kind', 'polygon', 'outlet'],
        },
      },
      assumptions: { type: 'array', items: { type: 'string' } },
    },
    required: ['subcatchments', 'assumptions'],
  },
}

const r1 = (v: number) => Math.round(v * 10) / 10

/** The plan as Claude sees it: linework, buildings, pipes, structures and a labelled coordinate grid. */
export function renderPlan(result: AnalysisResult, ctx: AiContext) {
  const { x0, y0, x1, y1 } = ctx.bbox
  const wFt = x1 - x0, hFt = y1 - y0
  const s = 1568 / Math.max(wFt, hFt)
  const W = Math.max(64, Math.round(wFt * s)), H = Math.max(64, Math.round(hFt * s))
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const g = cv.getContext('2d')!
  const X = (x: number) => (x - x0) * s, Y = (y: number) => H - (y - y0) * s
  const line = (pts: [number, number][], close = false) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])))); if (close) g.closePath() }
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H)
  g.strokeStyle = '#c9c9c9'; g.lineWidth = 0.7
  for (const c of result.contours) { line(c); g.stroke() }
  g.strokeStyle = '#4a4a4a'; g.lineWidth = 0.9
  for (const c of result.reference) { line(c); g.stroke() }
  for (const b of ctx.buildings) { line(b.ring, true); g.fillStyle = b.proposed ? 'rgba(222,170,110,0.55)' : 'rgba(170,170,170,0.5)'; g.fill(); g.strokeStyle = '#8a4b14'; g.lineWidth = 1.6; g.stroke() }
  g.strokeStyle = '#b3261e'; g.lineWidth = 4.5
  for (const w of ctx.walls) { line(w.line); g.stroke() }
  for (const b of ctx.basins) { line(b.ring, true); g.fillStyle = 'rgba(150,90,220,0.25)'; g.fill(); g.strokeStyle = '#6a2fc0'; g.lineWidth = 1.6; g.stroke() }
  g.strokeStyle = '#1565d8'; g.lineWidth = 2.4
  for (const p of ctx.pipes) { line(p); g.stroke() }
  g.strokeStyle = '#d0109c'; g.lineWidth = 2.6; g.setLineDash([10, 5]); line(ctx.bounds, true); g.stroke(); g.setLineDash([])
  // surface elevations at a coarse lattice, so slope direction can be read off the image
  g.fillStyle = '#7a8a99'; g.font = '8px sans-serif'; g.textAlign = 'center'
  const e = ctx.elev
  for (let r = 0; r < e.ny; r += 2) for (let c = 0; c < e.nx; c += 2) { const v = e.z[r * e.nx + c]; if (v != null) g.fillText(v.toFixed(1), X(e.x0 + c * e.step), Y(e.y0 + r * e.step)) }
  // the drawing's own text (spot grades, structure labels)
  g.fillStyle = '#333'; g.font = '9px sans-serif'; g.textAlign = 'left'
  for (const t of ctx.texts.slice(0, 450)) g.fillText(t.t.slice(0, 28), X(t.x), Y(t.y))
  g.font = 'bold 13px sans-serif'; g.fillStyle = '#5a2d0c'; g.textAlign = 'center'
  for (const b of ctx.buildings) { const c = b.ring.reduce((a, p) => [a[0] + p[0] / b.ring.length, a[1] + p[1] / b.ring.length], [0, 0]); g.fillText(b.id, X(c[0]), Y(c[1])) }
  g.textAlign = 'left'
  ctx.structures.forEach((st, i) => {
    const x = X(st.x), y = Y(st.y)
    g.fillStyle = st.kind === 'inlet' ? '#0a8a3a' : st.kind === 'outfall' ? '#c2410c' : '#111'
    g.fillRect(x - 5, y - 5, 10, 10)
    g.font = 'bold 12px sans-serif'; g.strokeStyle = '#fff'; g.lineWidth = 3
    const lab = `N${i + 1}`
    g.strokeText(lab, x + 7, y - 6); g.fillText(lab, x + 7, y - 6)
  })
  for (const d of ctx.dps) { g.fillStyle = '#e07b00'; g.beginPath(); g.arc(X(d.x), Y(d.y), 6, 0, 7); g.fill(); g.font = 'bold 12px sans-serif'; g.fillText(d.name, X(d.x) + 8, Y(d.y) + 12) }
  // coordinate grid in local feet
  const step = niceStep(Math.max(wFt, hFt) / 10)
  g.strokeStyle = 'rgba(30,110,220,0.35)'; g.lineWidth = 0.8; g.fillStyle = '#1e50a0'; g.font = '11px monospace'
  for (let v = 0; v <= wFt; v += step) { g.beginPath(); g.moveTo(v * s, 0); g.lineTo(v * s, H); g.stroke(); g.fillText(String(v), v * s + 3, H - 4); g.fillText(String(v), v * s + 3, 11) }
  for (let v = 0; v <= hFt; v += step) { g.beginPath(); g.moveTo(0, H - v * s); g.lineTo(W, H - v * s); g.stroke(); g.fillText(String(v), 3, H - v * s - 3) }
  return { dataUrl: cv.toDataURL('image/png'), pxPerFt: s, w: W, h: H }
}

function niceStep(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

/** The same plan as numbers, in the image's local coordinates. */
export function planData(condition: Condition, result: AnalysisResult, ctx: AiContext) {
  const L = (p: [number, number]) => [r1(p[0] - ctx.bbox.x0), r1(p[1] - ctx.bbox.y0)]
  const e = ctx.elev
  const rows: string[] = []
  for (let r = e.ny - 1; r >= 0; r--) rows.push(e.z.slice(r * e.nx, (r + 1) * e.nx).map((v) => (v == null ? '-' : v.toFixed(1))).join(' '))
  return {
    condition: condition === 'pre' ? 'existing' : 'proposed',
    units: 'feet',
    analysis_area_ac: +result.studyAc.toFixed(3),
    analysis_bounds: ctx.bounds.map(L),
    structures: ctx.structures.map((st, i) => ({ id: `N${i + 1}`, type: st.kind, block_or_label: st.label || undefined, discharges_to: st.to || undefined, xy: L([st.x, st.y]) })),
    pipes: ctx.pipes.map((p) => p.map(L)),
    buildings: ctx.buildings.map((b) => ({ id: b.id, status: b.proposed ? 'proposed' : 'existing', outline: b.ring.map(L) })),
    retaining_walls: ctx.walls.map((w) => ({ line: w.line.map(L), note: w.label || undefined })),
    bmps: ctx.basins.map((b) => ({ name: b.name, kind: b.kind ?? 'basin', outline: b.ring.map(L) })),
    design_points: ctx.dps.map((d) => ({ name: d.name, xy: L([d.x, d.y]) })),
    plan_text: ctx.texts.map((t) => ({ text: t.t, xy: L([t.x, t.y]), layer: t.layer })),
    elevation_grid: {
      note: 'Ground elevations (ft) sampled from the surface. Rows run north to south, values west to east.',
      west_x: r1(e.x0 - ctx.bbox.x0), north_y: r1(e.y0 - ctx.bbox.y0 + (e.ny - 1) * e.step), spacing_ft: r1(e.step), rows,
    },
    surface_derived_subcatchments: { note: 'What flow routing on the surface alone produced. A starting point to correct, not the answer.', list: ctx.engineSubs.map((s) => ({ name: s.name, drains_to: s.to, area_ac: s.areaAc, label_xy: L([s.x, s.y]) })) },
  }
}

export function buildRequest(cfg: AiConfig, condition: Condition, result: AnalysisResult, ctx: AiContext, image: { dataUrl: string; pxPerFt: number; w: number; h: number }, pdf?: { name: string; b64: string } | null) {
  const content: any[] = []
  if (pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.b64 }, title: pdf.name })
  content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.dataUrl.split(',')[1] } })
  content.push({
    type: 'text',
    text:
      `Delineate the ${condition === 'pre' ? 'EXISTING' : 'PROPOSED'} condition.\n\n` +
      `The image is ${image.w} x ${image.h} px at ${image.pxPerFt.toFixed(3)} px per foot; blue grid lines are labelled in feet. Magenta dashed line = analysis bounds, tan = proposed buildings (grey = existing), thick dark red = retaining walls, blue = storm pipes, green squares = inlets, black squares = manholes, orange = end sections and design points. Structures are tagged N1, N2 ... matching the data. Small grey numbers are ground elevations.` +
      (pdf ? `\nThe attached PDF is the engineer's plan sheet for the same site: use it to read grades, pipe runs, roof drains and labels. It is not in the same coordinates as the image.` : '') +
      (condition === 'pre'
        ? `\n\nDesign points: use exactly the ${ctx.dps.length} listed (${ctx.dps.map((d) => d.name).join(', ')}). They are where the proposed condition discharges, so every one must receive the existing land that drains toward that location, even a small area. Some may sit just outside the property line; that is intended.`
        : `\n\nDesign points: the listed ones (${ctx.dps.map((d) => d.name).join(', ')}) are the existing condition's discharge points; route all area leaving the site to them. Add a new design point only where the proposed closed drainage system discharges at a location none of them covers, and give it a clear name (e.g. "Pipe outfall at Orchard Blossom Rd"); the software adds it to the existing condition too.`) +
      `\n\nPlan data:\n` + JSON.stringify(planData(condition, result, ctx)),
  })
  return {
    model: cfg.model,
    max_tokens: 40000,
    system: SYSTEM,
    tools: [TOOL],
    // this model does not accept a forced tool call; the instructions require it instead
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content }],
  }
}

export async function delineate(cfg: AiConfig, condition: Condition, result: AnalysisResult, pdf?: { name: string; b64: string } | null): Promise<AiModel> {
  const ctx = result.aiContext
  if (!ctx || ctx.bounds.length < 3) throw new Error('Nothing to send: run the analysis first.')
  const body = buildRequest(cfg, condition, result, ctx, renderPlan(result, ctx), pdf)
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }
  if (cfg.apiKey) { headers['x-api-key'] = cfg.apiKey; headers['anthropic-dangerous-direct-browser-access'] = 'true' }
  let json: any = null
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response
    try {
      res = await fetch(cfg.endpoint, { method: 'POST', headers, body: JSON.stringify(body) })
    } catch (e: any) {
      throw new Error(`Could not reach Claude (${e?.message ?? 'network error'}).`)
    }
    json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`Claude returned ${res.status}: ${json?.error?.message ?? res.statusText}`)
    const done = (json?.content ?? []).some((b: any) => b.type === 'tool_use' && b.name === TOOL.name && b.input?.subcatchments?.length)
    if (done || json?.stop_reason !== 'max_tokens') break
    // ran out of room while working it out: ask once more for a more direct answer
    const last = body.messages[0].content[body.messages[0].content.length - 1]
    last.text += '\n\nKeep your reasoning brief and go straight to the submit_subcatchments call.'
  }
  const call = (json?.content ?? []).find((b: any) => b.type === 'tool_use' && b.name === TOOL.name)
  if (!call || !call.input?.subcatchments?.length) throw new Error(json?.stop_reason === 'max_tokens' ? 'Claude ran out of output before finishing the delineation.' : 'Claude did not return a delineation.')
  return toModel(call.input, ctx)
}

/** Claude's answer → drawing coordinates, with anything malformed dropped. */
export function toModel(input: any, ctx: AiContext): AiModel {
  const W = (p: any): [number, number] => [Number(p?.[0]) + ctx.bbox.x0, Number(p?.[1]) + ctx.bbox.y0]
  const ok = (p: [number, number]) => Number.isFinite(p[0]) && Number.isFinite(p[1])
  const subs: AiModel['subs'] = []
  for (const s of input?.subcatchments ?? []) {
    const ring = (Array.isArray(s?.polygon) ? s.polygon : []).map(W).filter(ok)
    if (ring.length < 3) continue
    const o = s.outlet && Number.isFinite(+s.outlet.x) && Number.isFinite(+s.outlet.y) ? ([+s.outlet.x + ctx.bbox.x0, +s.outlet.y + ctx.bbox.y0] as [number, number]) : null
    const path = (Array.isArray(s.flow_path) ? s.flow_path : []).map(W).filter(ok)
    const drip = (Array.isArray(s.drip_edges) ? s.drip_edges : []).map((e: any) => (Array.isArray(e) ? e.map(W).filter(ok) : [])).filter((e: any[]) => e.length >= 2)
    subs.push({
      building: s.building ? String(s.building) : undefined, drip: drip.length ? drip : undefined, dp: s.design_point ? String(s.design_point) : undefined,
      name: String(s.name ?? ''), kind: s.kind === 'roof' ? 'roof' : 'surface', ring, outlet: o, outletName: s.outlet?.name ? String(s.outlet.name) : undefined,
      path: path.length >= 2 ? path : undefined, note: [s.description, s.note].filter(Boolean).join(' — ') || undefined,
    })
  }
  if (!subs.length) throw new Error('Claude returned no usable subcatchments.')
  return { subs, notes: (Array.isArray(input?.assumptions) ? input.assumptions : []).map(String) }
}
