import { tr55StorageRatio } from './runoff'
import type { AnalysisResult } from './types'

export interface CompareRow {
  id: string
  name: string
  preAc: number
  postAc: number
  preImpAc: number
  postImpAc: number
  storms: { label: string; pre: number | null; post: number | null; diff: number | null; ok: boolean }[]
}

export interface Suggestion {
  level: 'ok' | 'warn' | 'fix'
  dp?: string
  title: string
  body: string
  lines?: [string, string][]
}

const TOL = 0.01

export function compare(pre: AnalysisResult, post: AnalysisResult) {
  const labels = post.settings.storms.map((s) => s.label)
  const ids = [...new Set([...pre.dps.map((d) => d.id), ...post.dps.map((d) => d.id)])]
  const rows: CompareRow[] = ids.map((id) => {
    const a = pre.dps.find((d) => d.id === id)
    const b = post.dps.find((d) => d.id === id)
    return {
      id,
      name: (a ?? b)!.name,
      preAc: a?.tributaryAc ?? 0,
      postAc: b?.tributaryAc ?? 0,
      preImpAc: a?.impervAc ?? 0,
      postImpAc: b?.impervAc ?? 0,
      storms: labels.map((label, k) => {
        const p = a?.storms[k]?.peak ?? null
        const q = b?.storms[k]?.peak ?? null
        const diff = p != null && q != null ? q - p : null
        return { label, pre: p, post: q, diff, ok: diff == null ? q == null || q < TOL : diff <= TOL }
      }),
    }
  })

  const out: Suggestion[] = []
  for (const r of rows) {
    const a = pre.dps.find((d) => d.id === r.id)
    const b = post.dps.find((d) => d.id === r.id)
    if (!a && b) {
      out.push({ level: 'warn', dp: r.name, title: `${r.name}: new outfall`, body: `Proposed grading sends ${b.tributaryAc.toFixed(2)} ac to a point that receives no flow today. Regrade so this area reaches an existing design point, or confirm the receiving area can accept new concentrated flow.` })
      continue
    }
    if (a && !b) {
      out.push({ level: 'warn', dp: r.name, title: `${r.name}: no longer receives flow`, body: `The proposed condition sends nothing to ${r.name}. If it is a wetland or resource area, check whether the loss of hydrology is acceptable.` })
      continue
    }
    if (!a || !b) continue
    const bad = r.storms.map((s, k) => ({ s, k })).filter((x) => !x.s.ok)
    const basins = post.basins.filter((B) => resolveDP(post, B.outflowTo) === r.name && B.inflow.some((x) => x.peak > 0.01))

    const dImp = r.postImpAc - r.preImpAc
    if (!bad.length) {
      const sized = basins.filter((B) => B.outlet)
      const over = sized.filter((B) => B.outlet!.results.some((x) => x.overtops))
      if (over.length) {
        for (const B of over)
          out.push({
            level: 'warn', dp: r.name, title: `${r.name}: ${B.name} overtops as graded`,
            body: `Peaks at ${r.name} are at or below existing, but ${B.name} holds only ${fmtCf(B.maxStorage)} below its rim (${B.rim.toFixed(2)}, bottom ${B.bottom.toFixed(2)}) and overtops in ${B.outlet!.results.filter((x) => x.overtops).length} of ${B.outlet!.results.length} storms. Check that the basin's contours are inside its outline, or deepen / enlarge it.`,
            lines: outletLines(B, post),
          })
        continue
      }
      out.push({
        level: 'ok', dp: r.name, title: `${r.name}: proposed peaks at or below existing`,
        body: sized.length
          ? `Met with the outlet sized below. Every storm is at or under the existing peak.`
          : `Every storm is at or under the existing peak${dImp > 0.01 ? ` even with ${dImp.toFixed(2)} ac of new impervious area` : ''}. No detention required at this point.`,
        lines: sized.flatMap((B) => outletLines(B, post)),
      })
      continue
    }

    const worst = bad.reduce((m, x) => (x.s.diff! > m.s.diff! ? x : m), bad[0])
    const exceedTxt = bad.map((x) => `${x.s.label} +${x.s.diff!.toFixed(2)} cfs`).join(', ')

    // tributary area moved onto this point by the grading
    const dA = r.postAc - r.preAc
    if (dA > Math.max(0.02, 0.02 * r.preAc))
      out.push({
        level: 'fix', dp: r.name, title: `${r.name}: drainage area grew ${dA.toFixed(2)} ac`,
        body: `Proposed grading sends ${r.postAc.toFixed(2)} ac to ${r.name} versus ${r.preAc.toFixed(2)} ac today. Regrading the added area back to its existing outfall is usually the cheapest way to hold peaks here.`,
      })

    // area that reaches the DP without passing through any basin
    const bypassSubs = post.subs.filter((s) => tributaryTo(post, s) === r.name && !passesBasin(post, s))
    let bypassOver = false
    if (basins.length && bypassSubs.length) {
      const n = bypassSubs[0].hydro[0].length
      const peaks = post.settings.storms.map((_, k) => {
        let p = 0
        for (let i = 0; i < n; i++) { let v = 0; for (const s of bypassSubs) v += s.hydro[k][i]; if (v > p) p = v }
        return p
      })
      const over = peaks.map((p, k) => ({ p, k })).filter((x) => x.p > a.storms[x.k].peak + TOL)
      if (over.length) {
        bypassOver = true
        const ac = bypassSubs.reduce((x, s) => x + s.areaAc, 0)
        const imp = bypassSubs.reduce((x, s) => x + (s.areaAc * s.impervPct) / 100, 0)
        const w = over[0]
        out.push({
          level: 'fix', dp: r.name, title: `${r.name}: too much area bypasses the basin`,
          body: `${ac.toFixed(2)} ac (${imp.toFixed(2)} ac impervious) reaches ${r.name} without passing through ${basins.map((B) => B.name).join(', ')}. That area alone peaks at ${w.p.toFixed(2)} cfs in the ${post.settings.storms[w.k].label} versus ${a.storms[w.k].peak.toFixed(2)} cfs existing, so no outlet size can fix it. Capture the impervious part with inlets or regrade it toward the basin, then re-run.`,
          lines: bypassSubs
            .sort((x, y) => y.areaAc * y.impervPct - x.areaAc * x.impervPct)
            .slice(0, 4)
            .map((s) => [s.name, `${s.areaAc.toFixed(2)} ac · ${s.impervPct.toFixed(0)}% imp. · ${s.storms[w.k].peak.toFixed(2)} cfs`] as [string, string]),
        })
      }
    }

    if (basins.length && !bypassOver) {
      for (const B of basins) {
        const o = B.outlet
        // storage needed at the basin (TR-55 Ch. 6), using flow the DP can still accept from the basin
        let need = 0
        post.settings.storms.forEach((_, k) => {
          const qi = B.inflow[k]?.peak ?? 0
          const outPeak = o?.results[k]?.peakOut ?? qi
          const bypass = Math.max(0, b.storms[k].peak - outPeak)
          const qo = Math.max(0.05 * qi, a.storms[k].peak - bypass)
          const Vr = (B.inflow[k]?.volAcFt ?? 0) * 43560
          need = Math.max(need, tr55StorageRatio(qo, qi) * Vr)
        })
        const add = Math.max(0, need * 1.15 - B.maxStorage)
        const depth = Math.max(0.5, B.rim - B.bottom)
        out.push({
          level: 'fix', dp: r.name, title: `${r.name}: enlarge ${B.name}`,
          body: `Exceeds existing for ${exceedTxt}. ${B.name} holds ${fmtCf(B.maxStorage)} below its rim (${B.rim.toFixed(2)}); about ${fmtCf(need * 1.15)} is needed. Add roughly ${fmtCf(add)} — about ${Math.round(add / depth).toLocaleString()} sf more footprint at the current ${depth.toFixed(1)} ft depth, or deepen the basin.`,
          lines: outletLines(B, post),
        })
      }
    } else if (!basins.length) {
      // size a new basin
      let need = 0, need0 = 0
      const smallest = post.settings.storms.map((s, k) => ({ P: s.P, k })).sort((x, y) => x.P - y.P)[0].k
      post.settings.storms.forEach((_, k) => {
        const Vr = b.storms[k].volAcFt * 43560
        const v = tr55StorageRatio(a.storms[k].peak, b.storms[k].peak) * Vr * (b.storms[k].peak > a.storms[k].peak ? 1 : 0)
        need = Math.max(need, v)
        if (k === smallest) need0 = v
      })
      const D = 3
      const foot = (need / D) * 1.35
      const h0 = Math.max(0.5, D * (need0 / Math.max(1, need)))
      const orifice = sizeOrifice(a.storms[smallest].peak, h0)
      out.push({
        level: 'fix', dp: r.name, title: `${r.name}: add detention`,
        body: `Exceeds existing for ${exceedTxt}. Provide about ${fmtCf(need * 1.15)} of detention upstream of ${r.name} (TR-55 Ch. 6 estimate +15%). At 3 ft of live storage that is a basin of roughly ${Math.round(foot).toLocaleString()} sf including side slopes. Draw the basin on a "DETENTION" layer and re-run to size the outlet automatically.`,
        lines: [
          ['Storage required', fmtCf(need * 1.15)],
          ['Footprint @ 3 ft deep', `${Math.round(foot).toLocaleString()} sf`],
          [`Low orifice (${post.settings.storms[smallest].label})`, `${orifice}" dia.`],
          ['Controlling storm', worst.s.label],
        ],
      })
    }

    // what's driving the increase
    const contrib = post.subs
      .filter((s) => tributaryTo(post, s) === r.name)
      .sort((x, y) => (y.areaAc * y.impervPct) - (x.areaAc * x.impervPct))[0]
    if (contrib && contrib.impervPct > 20) {
      out.push({
        level: 'warn', dp: r.name, title: `${contrib.name} drives the increase`,
        body: `${contrib.name} is ${contrib.impervPct.toFixed(0)}% impervious (${((contrib.areaAc * contrib.impervPct) / 100).toFixed(2)} ac). Routing its roof and pavement runoff to infiltration or disconnecting it onto pervious area reduces the storage you need.`,
      })
    }
    if (dImp > 0.01) {
      const A = r.postAc, I = r.postImpAc / Math.max(1e-9, A)
      const wqv = (1 / 12) * (0.05 + 0.9 * I) * A * 43560
      out.push({
        level: 'warn', dp: r.name, title: `${r.name}: treatment volume`,
        body: `${dImp.toFixed(2)} ac of new impervious area. Water quality volume ≈ ${fmtCf(wqv)} (1-in rain, Rv = 0.05 + 0.9·I). Check your state's treatment criteria.`,
      })
    }
  }
  if (out.every((s) => s.level === 'ok'))
    out.unshift({ level: 'ok', title: 'No mitigation needed', body: 'Proposed peak flows are at or below existing at every design point for every storm analyzed.' })
  const order = { fix: 0, warn: 1, ok: 2 }
  out.sort((x, y) => order[x.level] - order[y.level])
  return { rows, suggestions: out }
}

const bare = (n: string) => n.replace(/ \(via inlets\)$/, '')
function tributaryTo(r: AnalysisResult, s: AnalysisResult['subs'][number]) {
  return resolveDP(r, bare(s.toName))
}

function passesBasin(r: AnalysisResult, s: AnalysisResult['subs'][number]) {
  if (s.kind === 'basin') return true
  let cur = bare(s.toName)
  for (let g = 0; g < 50; g++) {
    if (r.basins.some((b) => b.name === cur)) return true
    const st = r.structures.find((x) => x.kind === 'inlet' && x.label === cur)
    if (st?.to) { cur = st.to; continue }
    return false
  }
  return false
}

/** Follow inlets and basins downstream until a design point name is reached. */
export function resolveDP(r: AnalysisResult, name: string): string {
  let cur = name
  for (let g = 0; g < 50; g++) {
    const B = r.basins.find((b) => b.name === cur)
    if (B) { cur = B.outflowTo; continue }
    const st = r.structures.find((x) => x.kind === 'inlet' && x.label === cur)
    if (st?.to) { cur = st.to; continue }
    return cur
  }
  return cur
}

function outletLines(B: AnalysisResult['basins'][number], post: AnalysisResult): [string, string][] {
  const o = B.outlet
  if (!o) return []
  const lines: [string, string][] = [
    ['Low orifice', `${o.orificeIn}" dia. @ inv. ${B.bottom.toFixed(2)}`],
  ]
  if (o.weirCrest != null) lines.push(['Weir', `${o.weirLength} ft @ ${o.weirCrest.toFixed(2)}`])
  lines.push(['Rim / spillway', B.rim.toFixed(2)])
  o.results.forEach((r, k) => lines.push([`${post.settings.storms[k].label} in → out`, `${r.peakIn.toFixed(2)} → ${r.peakOut.toFixed(2)} cfs · WSE ${r.stage.toFixed(2)}${r.overtops ? ' ▲ overtops' : ''}`]))
  return lines
}

function sizeOrifice(Q: number, h: number) {
  for (let D = 2; D <= 36; D++) {
    const d = D / 12
    const q = 0.6 * ((Math.PI * d * d) / 4) * Math.sqrt(2 * 32.174 * Math.max(0.1, h - d / 2))
    if (q >= Q) return Math.max(2, D - 1)
  }
  return 36
}

export function fmtCf(v: number) {
  return `${Math.round(v).toLocaleString()} cf`
}
