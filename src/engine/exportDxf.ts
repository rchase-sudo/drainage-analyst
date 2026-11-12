import { DxfWriter } from './dxfWrite'
import { polyArea, simplifyRing, traceLabels } from './geometry'
import { COVERS, COVER_KEYS } from './runoff'
import type { AnalysisResult } from './types'

/** Subcatchments, Tc lines, labels and design points as CAD linework, in the drawing's own units. */
export function exportDxf(rs: AnalysisResult | AnalysisResult[], units: 'ft' | 'm' = 'ft') {
  const w = new DxfWriter()
  for (const r of Array.isArray(rs) ? rs : [rs]) writeResult(w, r, units)
  return w.toString(units === 'm' ? 6 : 2)
}

function writeResult(w: DxfWriter, r: AnalysisResult, units: 'ft' | 'm') {
  const k = units === 'm' ? 1 / 3.280839895 : 1
  const P = (p: [number, number]): [number, number] => [p[0] * k, p[1] * k]
  const tag = r.condition === 'pre' ? 'EX' : 'PR'
  const L = {
    sub: `APL-${tag}-SUBCAT`,
    lbl: `APL-${tag}-SUBCAT-LABEL`,
    sheet: `APL-${tag}-TC-SHEET`,
    shallow: `APL-${tag}-TC-SHALLOW`,
    channel: `APL-${tag}-TC-CHANNEL`,
    tcl: `APL-${tag}-TC-LABEL`,
    dp: `APL-${tag}-DESIGN-POINT`,
    basin: `APL-${tag}-BASIN`,
  }
  w.layer(L.sub, r.condition === 'pre' ? 3 : 6)
    .layer(L.lbl, 7)
    .layer(L.sheet, 2, 'DASHED')
    .layer(L.shallow, 30)
    .layer(L.channel, 4)
    .layer(L.tcl, 7)
    .layer(L.dp, 1)
    .layer(L.basin, 5)
  const diag = Math.hypot(r.bbox.x1 - r.bbox.x0, r.bbox.y1 - r.bbox.y0)
  const th = niceText(diag / 110) * k

  for (const s of r.subs) {
    for (const g of s.rings) {
      w.polyline(L.sub, g.outer.map(P), true)
      for (const h of g.holes) w.polyline(L.sub, h.map(P), true)
    }
    const [x, y] = P(s.label)
    w.text(L.lbl, [x, y + th * 1.9], th * 1.4, s.name)
    w.text(L.lbl, [x, y + th * 0.3], th, `${s.areaAc.toFixed(2)} AC  CN ${s.cn.toFixed(0)}`)
    w.text(L.lbl, [x, y - th * 1.2], th, `Tc ${s.tcMin.toFixed(1)} MIN`)
    for (const seg of s.segments) {
      const layer = seg.type === 'sheet' ? L.sheet : seg.type === 'shallow' ? L.shallow : L.channel
      w.polyline(layer, seg.path.map(P), false)
    }
    // label the Tc path at its midpoint
    const all = s.segments.flatMap((g) => g.path)
    if (all.length > 1) {
      const m = all[Math.floor(all.length / 2)], n = all[Math.min(all.length - 1, Math.floor(all.length / 2) + 1)]
      let ang = (Math.atan2(n[1] - m[1], n[0] - m[0]) * 180) / Math.PI
      if (ang > 90) ang -= 180
      if (ang < -90) ang += 180
      const [mx, my] = P(m)
      w.text(L.tcl, [mx, my + th * 0.8], th * 0.8, `${s.name} Tc=${s.tcMin.toFixed(1)} MIN`, ang)
    }
  }
  for (const d of r.dps) {
    const p = P([d.x, d.y])
    w.circle(L.dp, p, th * 0.9)
    w.text(L.dp, [p[0], p[1] - th * 2.2], th * 1.2, d.name)
  }
  for (const B of r.basins) w.polyline(L.basin, B.ring.map(P), true)

  // closed land-cover and soil polygons, rebuilt from whatever linework the drawing had
  const g = r.grid
  const speck = 9 * g.cs * g.cs
  const toLabels = (src: Uint8Array) => { const a = new Int32Array(src.length); for (let i = 0; i < src.length; i++) a[i] = src[i] === 255 ? -1 : src[i]; return a }
  const covColor: Record<string, number> = { roof: 8, pavement: 9, gravel: 42, grass: 3, meadow: 52, woods: 94, water: 5, wetland: 4 }
  for (const [k, parts] of traceLabels(toLabels(r.coverGrid), g)) {
    const key = COVER_KEYS[k]
    if (!key) continue
    const layer = `APL-${tag}-COVER-${key.toUpperCase()}`
    w.layer(layer, covColor[key] ?? 7)
    for (const part of parts) {
      if (Math.abs(polyArea(part.outer)) < speck) continue
      w.polyline(layer, simplifyRing(part.outer, g.cs).map(P), true)
      for (const h of part.holes) if (Math.abs(polyArea(h)) >= speck) w.polyline(layer, simplifyRing(h, g.cs).map(P), true)
    }
    void COVERS
  }
  for (const [h, parts] of traceLabels(toLabels(r.hsgGrid), g)) {
    const layer = `APL-${tag}-SOILS-HSG-${'ABCD'[h]}`
    w.layer(layer, 40 + h * 20)
    for (const part of parts) {
      if (Math.abs(polyArea(part.outer)) < speck) continue
      w.polyline(layer, simplifyRing(part.outer, g.cs).map(P), true)
      for (const hole of part.holes) if (Math.abs(polyArea(hole)) >= speck) w.polyline(layer, simplifyRing(hole, g.cs).map(P), true)
    }
  }
}

function niceText(h: number) {
  const s = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20]
  for (const v of s) if (v >= h) return v
  return 20
}

export function exportCsv(r: AnalysisResult) {
  const st = r.settings.storms
  const head = ['Subcatchment', 'Kind', 'To', 'Area (ac)', 'CN', 'Impervious (%)', 'Tc (min)', ...st.flatMap((s) => [`${s.label} Q (in)`, `${s.label} peak (cfs)`, `${s.label} vol (ac-ft)`])]
  const rows = r.subs.map((s) => [s.name, s.kind, s.toName, s.areaAc.toFixed(3), s.cn.toFixed(1), s.impervPct.toFixed(1), s.tcMin.toFixed(1), ...s.storms.flatMap((x) => [x.Q.toFixed(2), x.peak.toFixed(2), x.volAcFt.toFixed(3)])])
  const dpHead = ['Design point', 'Tributary (ac)', ...st.flatMap((s) => [`${s.label} peak (cfs)`, `${s.label} vol (ac-ft)`])]
  const dpRows = r.dps.map((d) => [d.name, d.tributaryAc.toFixed(3), ...d.storms.flatMap((x) => [x.peak.toFixed(2), x.volAcFt.toFixed(3)])])
  const tcHead = ['Subcatchment', 'Segment', 'Surface', 'Length (ft)', 'Slope (ft/ft)', 'n', 'Velocity (ft/s)', 'Time (min)']
  const tcRows = r.subs.flatMap((s) => s.segments.map((g) => [s.name, g.type, g.surface, g.L.toFixed(0), g.s.toFixed(4), g.n?.toString() ?? '', g.V.toFixed(2), g.t.toFixed(1)]))
  const csv = (h: string[], rows: string[][]) => [h, ...rows].map((r) => r.map((c) => (/[,"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n')
  return [csv(head, rows), '', csv(dpHead, dpRows), '', csv(tcHead, tcRows)].join('\n')
}
