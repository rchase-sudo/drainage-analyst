import DxfParser from 'dxf-parser'
import type { Condition, CoverKey, Drawing, Ent, LayerInfo, Role, V3 } from './types'

/* ------------------------------------------------------------------ */
/*  File import                                                         */
/* ------------------------------------------------------------------ */

export function importFile(name: string, text: string, condition: Condition): Drawing {
  const isXml = /\.xml$/i.test(name) || /^\s*<\?xml|<LandXML/i.test(text.slice(0, 500))
  const d = isXml ? importLandXML(name, text) : importDXF(name, text)
  d.layers = summarizeLayers(d, condition)
  return d
}

function importDXF(fileName: string, text: string): Drawing {
  const parser: any = new (DxfParser as any)()
  let dxf: any
  try {
    dxf = parser.parseSync(text)
  } catch (e: any) {
    throw new Error('Could not read this DXF. Save it as ASCII DXF (AutoCAD 2000 or later) and try again.')
  }
  const insUnits = dxf?.header?.$INSUNITS
  const units: 'ft' | 'm' = insUnits === 6 ? 'm' : 'ft'
  const k = units === 'm' ? 3.280839895 : 1
  const polyElev = scanPolylineElevations(text)
  let polyIdx = 0
  const ents: Ent[] = []
  const P = (p: any): V3 => [(p?.x ?? 0) * k, (p?.y ?? 0) * k, (p?.z ?? 0) * k]

  for (const e of dxf?.entities ?? []) {
    const layer = String(e.layer ?? '0')
    switch (e.type) {
      case 'LINE': {
        const pts = (e.vertices ?? []).map(P)
        if (pts.length === 2) ents.push({ kind: 'poly', layer, pts, closed: false, hasZ: pts.some((p: V3) => p[2] !== 0) })
        break
      }
      case 'LWPOLYLINE': {
        const z = (e.elevation ?? 0) * k
        const pts = densifyBulges(e.vertices ?? [], k, z)
        if (pts.length >= 2) ents.push({ kind: 'poly', layer, pts, closed: !!e.shape || isClosed(pts), hasZ: z !== 0 })
        break
      }
      case 'POLYLINE': {
        const headerZ = (polyElev[polyIdx++] ?? 0) * k
        if (e.isPolyfaceMesh || e.is3dPolygonMesh) {
          for (const v of e.vertices ?? []) if (v.z) ents.push({ kind: 'point', layer, pts: [P(v)], hasZ: true })
          break
        }
        const pts: V3[] = (e.vertices ?? []).map((v: any) => {
          const p = P(v)
          if (!e.is3dPolyline && p[2] === 0) p[2] = headerZ
          return p
        })
        if (pts.length >= 2) ents.push({ kind: 'poly', layer, pts, closed: !!e.shape || isClosed(pts), hasZ: pts.some((p) => p[2] !== 0) })
        break
      }
      case '3DFACE': {
        const vs = (e.vertices ?? []).filter((v: any) => v && v.x != null).map(P)
        const uniq: V3[] = []
        for (const v of vs) if (!uniq.some((u) => u[0] === v[0] && u[1] === v[1] && u[2] === v[2])) uniq.push(v)
        if (uniq.length >= 3) {
          ents.push({ kind: 'face', layer, pts: uniq.slice(0, 3), hasZ: true })
          if (uniq.length === 4) ents.push({ kind: 'face', layer, pts: [uniq[0], uniq[2], uniq[3]], hasZ: true })
        }
        break
      }
      case 'POINT':
        ents.push({ kind: 'point', layer, pts: [P(e.position)], hasZ: (e.position?.z ?? 0) !== 0 })
        break
      case 'INSERT':
        ents.push({ kind: 'insert', layer, pts: [P(e.position)], name: String(e.name ?? ''), hasZ: (e.position?.z ?? 0) !== 0 })
        break
      case 'CIRCLE':
        ents.push({ kind: 'circle', layer, pts: [P(e.center)], r: (e.radius ?? 0) * k })
        break
      case 'TEXT':
        ents.push({ kind: 'text', layer, pts: [P(e.startPoint)], text: String(e.text ?? '') })
        break
      case 'MTEXT':
        ents.push({ kind: 'text', layer, pts: [P(e.position)], text: String(e.text ?? '').replace(/\\[A-Za-z][^;]*;|[{}]|\\P/g, ' ') })
        break
      case 'SPLINE': {
        const src = e.fitPoints?.length ? e.fitPoints : e.controlPoints ?? []
        const pts = src.map(P)
        if (pts.length >= 2) ents.push({ kind: 'poly', layer, pts, closed: !!e.closed || isClosed(pts), hasZ: pts.some((p: V3) => p[2] !== 0) })
        break
      }
      case 'ARC': {
        const c = e.center, r = e.radius
        if (!c || !r) break
        let a0 = e.startAngle ?? 0, a1 = e.endAngle ?? Math.PI * 2
        if (a1 < a0) a1 += Math.PI * 2
        const n = Math.max(4, Math.ceil((a1 - a0) / (Math.PI / 16)))
        const pts: V3[] = []
        for (let i = 0; i <= n; i++) {
          const a = a0 + ((a1 - a0) * i) / n
          pts.push([(c.x + r * Math.cos(a)) * k, (c.y + r * Math.sin(a)) * k, (c.z ?? 0) * k])
        }
        ents.push({ kind: 'poly', layer, pts, closed: false, hasZ: (c.z ?? 0) !== 0 })
        break
      }
    }
  }
  if (!ents.length) throw new Error('No drawing entities found in this DXF.')
  return { fileName, source: 'dxf', units, toFt: k, ents, layers: [] }
}

function isClosed(pts: V3[]) {
  if (pts.length < 4) return false
  const a = pts[0], b = pts[pts.length - 1]
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6
}

function densifyBulges(vs: any[], k: number, z: number): V3[] {
  const out: V3[] = []
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i]
    out.push([a.x * k, a.y * k, z])
    const b = vs[i + 1]
    if (b && a.bulge) {
      const ang = 4 * Math.atan(a.bulge)
      const n = Math.min(32, Math.max(2, Math.ceil(Math.abs(ang) / (Math.PI / 12))))
      const chord = Math.hypot(b.x - a.x, b.y - a.y)
      const r = chord / (2 * Math.sin(ang / 2))
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
      const d = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2)) * Math.sign(a.bulge) * (Math.abs(ang) > Math.PI ? -1 : 1)
      const ux = -(b.y - a.y) / chord, uy = (b.x - a.x) / chord
      const cx = mx + ux * d, cy = my + uy * d
      const s0 = Math.atan2(a.y - cy, a.x - cx)
      for (let j = 1; j < n; j++) {
        const t = s0 + (ang * j) / n
        out.push([(cx + Math.abs(r) * Math.cos(t)) * k, (cy + Math.abs(r) * Math.sin(t)) * k, z])
      }
    }
  }
  return out
}

/** dxf-parser drops a 2D POLYLINE's header elevation; recover it from the raw ENTITIES section in order. */
function scanPolylineElevations(text: string): number[] {
  const out: number[] = []
  const sec = text.search(/\n\s*ENTITIES\s*\r?\n/)
  if (sec < 0) return out
  const lines = text.slice(sec).split(/\r?\n/)
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim(), val = lines[i + 1].trim()
    if (code === '0' && val === 'ENDSEC') break
    if (code === '0' && val === 'POLYLINE') {
      let z = 0
      for (let j = i + 2; j + 1 < lines.length; j += 2) {
        const c = lines[j].trim()
        if (c === '0') break
        if (c === '30') z = parseFloat(lines[j + 1]) || 0
      }
      out.push(z)
    }
  }
  return out
}

function importLandXML(fileName: string, text: string): Drawing {
  // Regex-based so it runs in a Web Worker (no DOMParser there).
  const units: 'ft' | 'm' = /<Metric\b/i.test(text) || /linearUnit="meter"/i.test(text) ? 'm' : 'ft'
  const k = units === 'm' ? 3.280839895 : 1
  const surfRx = /<Surface\b[^>]*>([\s\S]*?)<\/Surface>/gi
  let best = '', bestN = -1, m: RegExpExecArray | null
  while ((m = surfRx.exec(text))) {
    const n = (m[1].match(/<F\b/gi) ?? []).length
    if (n > bestN) { bestN = n; best = m[1] }
  }
  if (!best) throw new Error('No <Surface> found in this LandXML file.')
  const idMap = new Map<string, number>()
  const pts: V3[] = []
  const pRx = /<P\b([^>]*)>([^<]*)<\/P>/gi
  while ((m = pRx.exec(best))) {
    const id = /id="([^"]*)"/i.exec(m[1])?.[1] ?? String(pts.length + 1)
    const v = m[2].trim().split(/\s+/).map(Number) // northing easting elevation
    if (v.length < 3 || v.some((n) => !Number.isFinite(n))) continue
    idMap.set(id, pts.length)
    pts.push([v[1] * k, v[0] * k, v[2] * k])
  }
  const tris: [number, number, number][] = []
  const fRx = /<F\b([^>]*)>([^<]*)<\/F>/gi
  while ((m = fRx.exec(best))) {
    if (/\bi="1"/.test(m[1])) continue // invisible face
    const t = m[2].trim().split(/\s+/).map((id) => idMap.get(id))
    if (t.length >= 3 && t[0] != null && t[1] != null && t[2] != null) tris.push([t[0], t[1], t[2]])
  }
  if (tris.length < 2) throw new Error('The LandXML surface has no triangles.')
  return { fileName, source: 'landxml', units, toFt: k, ents: [], layers: [], tin: { pts, tris } }
}

/* ------------------------------------------------------------------ */
/*  Layer role detection                                                */
/* ------------------------------------------------------------------ */

const RX = {
  ignore: /TEXT|ANNO|DIM|TITLE|BORDER|NOTE|LABEL|SYMB|HATCH|VPORT|VIEWPORT|DEFPOINTS|LEGEND|NORTH|SCALE|GRID|MATCH|SHEET/,
  study: /WATERSHED|STUDY|ANALYSIS.?(AREA|LIMIT|BOUND)|DRAIN(AGE)?.?AREA|LIMIT.?OF.?ANALYSIS|SUBCAT/,
  designpoint: /\bDP\b|DESIGN.?P(T|OINT)|\bPOA\b|POINT.?OF.?ANALYSIS|ANALYSIS.?P(T|OINT)/,
  soils: /SOIL|\bHSG\b/,
  basin: /DETEN|BASIN|INFILTR|BIORET|RAIN.?GARDEN|\bBMP\b|STORMWATER.?(POND|AREA)|RETENTION|TREATMENT.?(SWALE|AREA)/,
  storm: /STRM|STORM|\bSD\b|\bSTM\b|PIPE|CULV|CATCH|\bCB\b|INLET|DRAIN.?(LINE|STR)|DRAINAGE|\bDMH\b|OUTFALL|HEADWALL|\bFES\b/,
  surface: /CONT|TOPO|SURF|\bTIN\b|\bEG\b|\bFG\b|GRADE|GRADING|ELEV|SPOT|BRKL|BREAK|\bGROUND\b|\bGRND\b|MAJR|MINR/,
  roof: /BLDG|BUILDING|ROOF|HOUSE|GARAGE|SHED|BARN|DWELL|FOOTPRINT/,
  pavement: /PAVE|PVMT|ASPH|BITUM|\bBIT\b|CONC|DRIVE|DRWY|PARK|ROAD|STREET|\bST\b|SIDEWALK|\bSW\b|WALK|IMPERV|PATIO|HARDSCAPE|\bPAD\b|DECK/,
  gravel: /GRAVEL|GRVL|CRUSH|STONE.?(DRIVE|AREA)/,
  wetland: /WETL|\bWL\b|MARSH|BOG/,
  water: /WATER|POND|LAKE|STREAM|RIVER|BROOK|CREEK|\bEOW\b/,
  woods: /WOOD|TREE|FOREST|\bVEG|CANOPY/,
  meadow: /MEADOW|FIELD|BRUSH|SCRUB|PASTURE|SHRUB/,
  grass: /GRASS|LAWN|TURF|LANDSCAP|LOAM|SEED|OPEN.?SPACE|PERVIOUS|PLANT/,
  demo: /DEMO|REMOV|\bRMV\b|\bTBR\b|RAZE|TO BE REM/,
  ex: /(^|[^A-Z])(EX|EXIST|EXST|EXG|EXT|E)([^A-Z]|$)|EXIST/,
  pr: /(^|[^A-Z])(PR|PROP|PRP|PROPOSED|P|NEW)([^A-Z]|$)|PROPOS/,
}

function guessRole(L: LayerInfo, condition: Condition): Role {
  const n = L.name.toUpperCase().replace(/[_\-.|$]/g, ' ')
  const isEx = RX.ex.test(n) && !RX.pr.test(n)
  const isPr = RX.pr.test(n) && !RX.ex.test(n)

  if (RX.ignore.test(n) && !L.withZ) return 'ignore'
  const lines = L.count - L.points - L.faces // polylines and lines, open or closed
  if (RX.study.test(n)) return lines > 0 ? 'study' : 'reference'
  if (RX.designpoint.test(n)) return 'designpoint'
  if (RX.soils.test(n)) return 'soils'
  if (RX.basin.test(n) && lines > 0) return condition === 'pre' ? 'reference' : 'basin'
  if (RX.storm.test(n)) return condition === 'pre' && isPr ? 'reference' : 'storm'

  const zHeavy = L.faces > 0 || (L.withZ > 0 && L.withZ >= 0.6 * (L.count - L.points))
  if (RX.surface.test(n) || zHeavy) {
    if (condition === 'pre') return isPr ? 'reference' : 'surface'
    return isEx ? 'surface-ex' : 'surface'
  }
  if (lines > 0) {
    const cov = (Object.keys(COVER_RX) as CoverKey[]).find((k) => COVER_RX[k].test(n))
    // demolished items never count; existing items drawn on the proposed plan still exist, so they count;
    // proposed items on the existing plan don't exist yet
    if (cov) return RX.demo.test(n) || (condition === 'pre' && isPr) ? 'reference' : (`cover:${cov}` as Role)
  }
  return 'reference'
}

export const COVER_RX: Record<CoverKey, RegExp> = {
  roof: RX.roof,
  gravel: RX.gravel,
  pavement: RX.pavement,
  wetland: RX.wetland,
  water: RX.water,
  woods: RX.woods,
  meadow: RX.meadow,
  grass: RX.grass,
}

function summarizeLayers(d: Drawing, condition: Condition): LayerInfo[] {
  const m = new Map<string, LayerInfo>()
  for (const e of d.ents) {
    let L = m.get(e.layer)
    if (!L) m.set(e.layer, (L = { name: e.layer, count: 0, closed: 0, withZ: 0, faces: 0, points: 0, role: 'reference' }))
    L.count++
    if (e.kind === 'poly' && e.closed) L.closed++
    if (e.hasZ && e.kind !== 'text') L.withZ++
    if (e.kind === 'face') L.faces++
    if (e.kind === 'point' || e.kind === 'insert' || e.kind === 'circle' || e.kind === 'text') L.points++
  }
  const layers = [...m.values()]
  for (const L of layers) L.role = guessRole(L, condition)
  // If a layer was ignored for being "text" but it's the only HSG labels, keep soils text
  if (d.source === 'landxml') return []
  // Fallback: no surface layer detected → every layer with elevations becomes surface
  if (!layers.some((l) => l.role === 'surface' || l.role === 'surface-ex'))
    for (const L of layers) if (L.withZ > 0 && L.role === 'reference') L.role = 'surface'
  return layers.sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.name.localeCompare(b.name))
}

export const ROLE_LABELS: { role: Role; label: string }[] = [
  { role: 'surface', label: 'Surface (contours / TIN)' },
  { role: 'surface-ex', label: 'Existing surface (fill-in)' },
  { role: 'study', label: 'Study area limit' },
  { role: 'designpoint', label: 'Design point' },
  { role: 'storm', label: 'Storm drainage (CB, pipe, culvert)' },
  { role: 'basin', label: 'Stormwater basin' },
  { role: 'soils', label: 'Soils (HSG)' },
  { role: 'cover:roof', label: 'Cover · Roof' },
  { role: 'cover:pavement', label: 'Cover · Pavement' },
  { role: 'cover:gravel', label: 'Cover · Gravel' },
  { role: 'cover:grass', label: 'Cover · Grass / lawn' },
  { role: 'cover:meadow', label: 'Cover · Meadow / brush' },
  { role: 'cover:woods', label: 'Cover · Woods' },
  { role: 'cover:water', label: 'Cover · Water' },
  { role: 'cover:wetland', label: 'Cover · Wetland' },
  { role: 'reference', label: 'Reference (display only)' },
  { role: 'ignore', label: 'Ignore' },
]

function roleOrder(r: Role) {
  const i = ROLE_LABELS.findIndex((x) => x.role === r)
  return i < 0 ? 99 : i
}
