// Generates a synthetic existing/proposed site pair for demos and tests.
import { writeFileSync, mkdirSync } from 'node:fs'
import { DxfWriter } from '../src/engine/dxfWrite'

type XY = [number, number]
const W = 640, H = 480

// existing ground: hill to the NW, broad swale running to the SE corner, road along the south
function zEx(x: number, y: number) {
  const hill = 9 * Math.exp(-(((x - 140) ** 2) + ((y - 360) ** 2)) / (2 * 110 ** 2))
  const plane = 312 - 0.03 * x + 0.012 * y
  const swaleLine = 470 - 0.72 * x // swale runs NW -> SE toward the road culvert
  const swale = -2.4 * Math.exp(-((y - swaleLine) ** 2) / (2 * 40 ** 2)) * Math.min(1, x / 180)
  // ridge in the NE that sheds the east strip off the property toward the abutter
  const ridge = 5.5 * Math.exp(-((x - 0.55 * y - 330) ** 2) / (2 * 45 ** 2)) * Math.min(1, y / 260)
  return plane + hill + swale + ridge
}

// proposed: building pad + parking graded at 1-2%, detention basin cut in the low area
const CBS: XY[] = [[285, 172], [345, 172], [385, 205]]
const PAD = { x0: 230, y0: 230, x1: 330, y1: 300, z: 0 }
const LOT = { x0: 230, y0: 150, x1: 400, y1: 230 }
const BASIN = { cx: 470, cy: 190, rx: 55, ry: 34, depth: 3.2 }
PAD.z = zEx(280, 265) + 0.5
function zPr(x: number, y: number) {
  let z = zEx(x, y)
  const blend = (d: number, w: number) => Math.max(0, Math.min(1, 1 - d / w))
  // pad
  const dPad = boxDist(x, y, PAD)
  if (dPad < 40) z = lerp(z, PAD.z, blend(dPad, 40))
  // parking: plane falling to the SE at ~1.5%
  let lotZ = PAD.z - 0.6 - 0.015 * (x - LOT.x0) - 0.012 * (LOT.y1 - y)
  for (const [qx, qy] of CBS) lotZ -= 0.9 * Math.max(0, 1 - Math.hypot(x - qx, y - qy) / 45) // sags at the catch basins
  const dLot = boxDist(x, y, LOT)
  if (dLot < 35) z = lerp(z, lotZ, blend(dLot, 35))
  // basin bowl
  const e = Math.hypot((x - BASIN.cx) / BASIN.rx, (y - BASIN.cy) / BASIN.ry)
  const rim = zEx(BASIN.cx, BASIN.cy) + 0.8
  const bottom = rim - BASIN.depth
  if (e < 1) z = bottom + (rim - bottom) * Math.max(0, Math.min(1, (e - 0.45) / 0.55))
  else if (e < 1.12) z = Math.max(z, rim + 0.6) // berm top
  else if (e < 1.5) z = Math.max(z, lerp(rim + 0.6, z, (e - 1.12) / 0.38))
  return z
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
function boxDist(x: number, y: number, b: { x0: number; y0: number; x1: number; y1: number }) {
  const dx = Math.max(b.x0 - x, 0, x - b.x1), dy = Math.max(b.y0 - y, 0, y - b.y1)
  return Math.hypot(dx, dy)
}

function contours(f: (x: number, y: number) => number, step = 4) {
  const nx = Math.round(W / step), ny = Math.round(H / step)
  const g: number[] = []
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) g.push(f(i * step, j * step))
  let lo = Infinity, hi = -Infinity
  for (const v of g) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
  const out: { z: number; pts: XY[] }[] = []
  for (let lev = Math.ceil(lo); lev <= Math.floor(hi); lev++) {
    const segs: [XY, XY][] = []
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const v = [g[j * (nx + 1) + i], g[j * (nx + 1) + i + 1], g[(j + 1) * (nx + 1) + i + 1], g[(j + 1) * (nx + 1) + i]]
        const p: XY[] = [[i * step, j * step], [(i + 1) * step, j * step], [(i + 1) * step, (j + 1) * step], [i * step, (j + 1) * step]]
        const cross: XY[] = []
        for (let k = 0; k < 4; k++) {
          const a = v[k] - lev, b = v[(k + 1) % 4] - lev
          if ((a < 0) !== (b < 0)) {
            const t = a / (a - b)
            cross.push([p[k][0] + (p[(k + 1) % 4][0] - p[k][0]) * t, p[k][1] + (p[(k + 1) % 4][1] - p[k][1]) * t])
          }
        }
        if (cross.length === 2) segs.push([cross[0], cross[1]])
        if (cross.length === 4) { segs.push([cross[0], cross[1]]); segs.push([cross[2], cross[3]]) }
      }
    // chain segments
    const key = (p: XY) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`
    const adj = new Map<string, number[]>()
    segs.forEach((s, k) => { for (const p of s) { const kk = key(p); adj.set(kk, [...(adj.get(kk) ?? []), k]) } })
    const used = new Uint8Array(segs.length)
    for (let s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue
      used[s0] = 1
      const line: XY[] = [segs[s0][0], segs[s0][1]]
      for (const dirn of [1, -1]) {
        for (;;) {
          const end = dirn === 1 ? line[line.length - 1] : line[0]
          const nxt = (adj.get(key(end)) ?? []).find((k) => !used[k])
          if (nxt == null) break
          used[nxt] = 1
          const s = segs[nxt]
          const other = key(s[0]) === key(end) ? s[1] : s[0]
          if (dirn === 1) line.push(other)
          else line.unshift(other)
        }
      }
      out.push({ z: lev, pts: line.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)] as XY) })
    }
  }
  return out
}

function addContours(w: DxfWriter, f: (x: number, y: number) => number, prefix: string) {
  for (const c of contours(f)) {
    const major = c.z % 5 === 0
    w.polyline(`${prefix}-CONT-${major ? 'MAJOR' : 'MINOR'}`, c.pts, false, { elevation: c.z })
  }
}
const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 40): XY[] =>
  Array.from({ length: n }, (_, k) => [cx + rx * Math.cos((2 * Math.PI * k) / n), cy + ry * Math.sin((2 * Math.PI * k) / n)] as XY)

function common(w: DxfWriter, phase: 'EX' | 'PR') {
  w.polyline('PROPERTY LINE', rect(20, 20, W - 20, H - 20), true)
  // road along the south edge
  w.polyline('EX-PAVEMENT', rect(0, 0, W, 34), true)
  // soils: HSG B upslope (west), HSG C east/low
  // soil boundary drawn as a single open line across the site (as on a web-soil-survey overlay)
  w.polyline('SOILS', [[300, -10], [340, 240], [380, H + 10]], false)
  w.text('SOILS', [120, 420], 8, '26B HSG B')
  w.text('SOILS', [520, 300], 8, '42C HSG C')
  // existing house + gravel drive on the west side
  const hb = rect(70, 90, 115, 125)
  hb.forEach((p, i) => w.line('EX-BLDG', p, hb[(i + 1) % 4])) // exploded lines, not a polyline
  w.polyline('EX-GRAVEL-DRIVE', rect(85, 34, 100, 90), true)
  w.polyline('EX-LAWN', rect(50, 60, 140, 150), true)
  // existing culvert under the road at the swale
  const cx = 70 / 0.55 + 0
  w.polyline('EX-STORM-CULVERT', [[560, 52], [575, -4]], false)
  w.circle('EX-STORM-FES', [560, 52], 1.5)
  w.circle('EX-STORM-FES', [575, -4], 1.5)
  void cx
  void phase
}

mkdirSync('public/samples', { recursive: true })

// ---------- existing ----------
{
  const w = new DxfWriter()
  addContours(w, zEx, 'EX')
  common(w, 'EX')
  // tree line along the road, open ended; the label tells which side is wooded
  w.polyline('EX-TREELINE', [[-5, 40], [200, 44], [420, 38], [W + 5, 42]], false)
  w.text('EX-TEXT', [300, 300], 10, 'WOODED')
  // meadow drawn with a small gap at the close
  w.polyline('EX-MEADOW', [[380, 260], [600, 260], [600, 440], [380, 440], [380, 262]], false)
  writeFileSync('public/samples/existing-conditions.dxf', w.toString(2))
}

// ---------- proposed ----------
{
  const w = new DxfWriter()
  addContours(w, zEx, 'EX') // existing ground kept on its own layers, as most plan sets do
  addContours(w, zPr, 'PR')
  common(w, 'PR')
  w.polyline('PR-BLDG', rect(PAD.x0 + 10, PAD.y0 + 10, PAD.x1 - 10, PAD.y1 - 10), true)
  const lot = rect(LOT.x0, LOT.y0, LOT.x1, LOT.y1)
  w.polyline('PR-PAVEMENT', [lot[0], lot[1], lot[2]], false) // edge of pavement in two pieces
  w.polyline('PR-PAVEMENT', [lot[2], lot[3], lot[0]], false)
  w.polyline('PR-PAVEMENT', rect(300, 34, 330, 150), true) // entrance drive
  w.polyline('PR-LAWN', rect(PAD.x0 - 30, PAD.y0 - 10, LOT.x1 + 40, PAD.y1 + 40), true)
  w.polyline('PR-LAWN', ellipse(BASIN.cx, BASIN.cy, BASIN.rx * 1.45, BASIN.ry * 1.45), true)
  const basin = ellipse(BASIN.cx, BASIN.cy, BASIN.rx, BASIN.ry)
  w.polyline('PR-DETENTION-BASIN', [...basin.slice(0, 21)], false) // drawn as two open arcs
  w.polyline('PR-DETENTION-BASIN', [...basin.slice(20), basin[0]], false)
  // catch basins in the lot, piped to a flared end in the basin
  const cbs = CBS
  for (const p of cbs) w.circle('PR-STORM-STRC', p, 2)
  w.polyline('PR-STORM-PIPE', [cbs[0], cbs[1]], false)
  w.polyline('PR-STORM-PIPE', [cbs[1], cbs[2]], false)
  w.polyline('PR-STORM-PIPE', [cbs[2], [432, 196]], false)
  w.circle('PR-STORM-FES', [432, 196], 1.5)
  // outlet control structure in the basin, piped to a level spreader toward the swale
  w.circle('PR-STORM-OCS', [505, 178], 2.5)
  w.polyline('PR-STORM-PIPE', [[505, 178], [540, 150]], false)
  w.circle('PR-STORM-FES', [540, 150], 1.5)
  writeFileSync('public/samples/proposed-conditions.dxf', w.toString(2))
}
console.log('samples written')
