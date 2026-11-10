import type { CoverKey } from './types'

/* ---------- TR-55 curve numbers (Tables 2-2a, 2-2c) ---------- */
export const COVERS: Record<CoverKey, { desc: string; cn: [number, number, number, number]; sheetN: number; paved: boolean; imperv: boolean; color: string }> = {
  roof: { desc: 'Roofs', cn: [98, 98, 98, 98], sheetN: 0.011, paved: true, imperv: true, color: '#8a8f98' },
  pavement: { desc: 'Paved parking, roads, walks', cn: [98, 98, 98, 98], sheetN: 0.011, paved: true, imperv: true, color: '#5f6670' },
  gravel: { desc: 'Gravel surface', cn: [76, 85, 89, 91], sheetN: 0.05, paved: false, imperv: false, color: '#b9a888' },
  grass: { desc: 'Open space, >75% grass cover, good', cn: [39, 61, 74, 80], sheetN: 0.24, paved: false, imperv: false, color: '#8fd18a' },
  meadow: { desc: 'Meadow, non-grazed', cn: [30, 58, 71, 78], sheetN: 0.24, paved: false, imperv: false, color: '#c7d98a' },
  woods: { desc: 'Woods, good', cn: [30, 55, 70, 77], sheetN: 0.4, paved: false, imperv: false, color: '#3f8f5a' },
  water: { desc: 'Water surface', cn: [98, 98, 98, 98], sheetN: 0.011, paved: true, imperv: false, color: '#4aa3df' },
  wetland: { desc: 'Wetland (as water surface)', cn: [98, 98, 98, 98], sheetN: 0.4, paved: false, imperv: false, color: '#5fb3a8' },
}
export const COVER_KEYS = Object.keys(COVERS) as CoverKey[]
export const HSG = ['A', 'B', 'C', 'D'] as const

/* ---------- NRCS 24-hr distributions (cumulative fraction vs hour) ---------- */
// Type III is symmetric about hour 12; Type II values from TR-55.
const TYPE_III_HALF: [number, number][] = [
  [0, 0], [2, 0.02], [4, 0.043], [6, 0.072], [7, 0.089], [8, 0.115], [8.5, 0.13], [9, 0.148],
  [9.5, 0.167], [9.75, 0.178], [10, 0.189], [10.5, 0.216], [11, 0.25], [11.5, 0.298], [11.6, 0.312], [11.7, 0.328],
  [11.75, 0.339], [11.8, 0.35], [11.9, 0.388], [12, 0.5],
]
const TYPE_III: [number, number][] = [
  ...TYPE_III_HALF,
  ...TYPE_III_HALF.slice(0, -1).reverse().map(([t, f]) => [24 - t, 1 - f] as [number, number]),
]
const TYPE_II: [number, number][] = [
  [0, 0], [2, 0.022], [4, 0.048], [6, 0.08], [7, 0.098], [8, 0.12], [8.5, 0.133], [9, 0.147],
  [9.5, 0.163], [9.75, 0.172], [10, 0.181], [10.5, 0.204], [11, 0.235], [11.5, 0.283], [11.75, 0.357], [12, 0.663],
  [12.5, 0.735], [13, 0.772], [13.5, 0.799], [14, 0.82], [16, 0.88], [20, 0.952], [24, 1],
]

export function cumRain(dist: 'II' | 'III', t: number) {
  const tab = dist === 'II' ? TYPE_II : TYPE_III
  if (t <= 0) return 0
  if (t >= 24) return 1
  for (let i = 1; i < tab.length; i++)
    if (t <= tab[i][0]) {
      const [t0, f0] = tab[i - 1], [t1, f1] = tab[i]
      return f0 + ((f1 - f0) * (t - t0)) / (t1 - t0)
    }
  return 1
}

export function scsRunoff(P: number, CN: number) {
  if (CN >= 99.999) return P
  const S = 1000 / CN - 10
  const Ia = 0.2 * S
  return P > Ia ? (P - Ia) ** 2 / (P - Ia + S) : 0
}

/* ---------- NRCS dimensionless curvilinear unit hydrograph (NEH 630 Table 16-1) ---------- */
const DUH: [number, number][] = [
  [0, 0], [0.1, 0.03], [0.2, 0.1], [0.3, 0.19], [0.4, 0.31], [0.5, 0.47], [0.6, 0.66], [0.7, 0.82], [0.8, 0.93],
  [0.9, 0.99], [1.0, 1.0], [1.1, 0.99], [1.2, 0.93], [1.3, 0.86], [1.4, 0.78], [1.5, 0.68], [1.6, 0.56], [1.7, 0.46],
  [1.8, 0.39], [1.9, 0.33], [2.0, 0.28], [2.2, 0.207], [2.4, 0.147], [2.6, 0.107], [2.8, 0.077], [3.0, 0.055],
  [3.2, 0.04], [3.4, 0.029], [3.6, 0.021], [3.8, 0.015], [4.0, 0.011], [4.5, 0.005], [5.0, 0],
]
function duh(r: number) {
  if (r <= 0 || r >= 5) return 0
  for (let i = 1; i < DUH.length; i++)
    if (r <= DUH[i][0]) {
      const [a, fa] = DUH[i - 1], [b, fb] = DUH[i]
      return fa + ((fb - fa) * (r - a)) / (b - a)
    }
  return 0
}

export const DT = 0.01 // hr
export const T_END = 36 // hr
export const NSTEP = Math.round(T_END / DT)

/** Runoff hydrograph (cfs at t = i*DT) for a subcatchment. */
export function subHydrograph(areaAc: number, cn: number, tcHr: number, P: number, dist: 'II' | 'III') {
  const n = NSTEP
  const q = new Float32Array(n + 1)
  // incremental excess (inches) per step
  const ex = new Float64Array(n)
  let prevQ = 0
  for (let i = 0; i < n; i++) {
    const t = (i + 1) * DT
    const Pc = P * cumRain(dist, t)
    const Qc = scsRunoff(Pc, cn)
    ex[i] = Qc - prevQ
    prevQ = Qc
  }
  const Qtot = prevQ
  if (Qtot <= 0 || areaAc <= 0) return { q, Q: Qtot, peak: 0, tpeak: 0, vol: 0 }
  const Tp = DT / 2 + 0.6 * tcHr
  const m = Math.ceil((5 * Tp) / DT) + 1
  const u = new Float64Array(m)
  let su = 0
  for (let k = 0; k < m; k++) {
    u[k] = duh(((k + 0.5) * DT) / Tp)
    su += u[k]
  }
  // scale so 1 inch of excess yields exactly 1 inch of runoff volume
  const vol1in = (areaAc * 43560) / 12 // cf
  const scale = su > 0 ? vol1in / (su * DT * 3600) : 0
  for (let k = 0; k < m; k++) u[k] *= scale
  for (let i = 0; i < n; i++) {
    const e = ex[i]
    if (e <= 0) continue
    const lim = Math.min(m, n + 1 - i)
    for (let k = 0; k < lim; k++) q[i + k] += e * u[k]
  }
  const st = stats(q)
  return { q, Q: Qtot, peak: st.peak, tpeak: st.tpeak, vol: (Qtot / 12) * areaAc }
}

export function stats(q: Float32Array) {
  let peak = 0, ip = 0, v = 0
  for (let i = 0; i < q.length; i++) {
    if (q[i] > peak) { peak = q[i]; ip = i }
    v += q[i]
  }
  return { peak, tpeak: ip * DT, vol: (v * DT * 3600) / 43560 }
}

export function addInto(dst: Float32Array, src: Float32Array) {
  for (let i = 0; i < dst.length; i++) dst[i] += src[i]
}

/* ---------- Basin routing ---------- */
const G = 32.174

export interface Outlet { invert: number; orificeD: number; weirCrest: number | null; weirL: number; rim: number; spillL: number }

export function outflow(o: Outlet, h: number) {
  let Q = 0
  const hc = h - o.invert
  if (hc > 0 && o.orificeD > 0) {
    const D = o.orificeD, A = (Math.PI * D * D) / 4
    const full = 0.6 * A * Math.sqrt(2 * G * (D / 2))
    Q += hc < D ? full * Math.pow(hc / D, 1.5) : 0.6 * A * Math.sqrt(2 * G * (hc - D / 2))
  }
  if (o.weirCrest != null && h > o.weirCrest) Q += 3.33 * o.weirL * Math.pow(h - o.weirCrest, 1.5)
  if (h > o.rim) Q += 2.6 * o.spillL * Math.pow(h - o.rim, 1.5)
  return Q
}

/** Level-pool routing with sub-stepping. storage: ascending [{z,S}] (cf). */
export function routeBasin(inflow: Float32Array, storage: { z: number; S: number }[], o: Outlet) {
  const out = new Float32Array(inflow.length)
  const Smax = storage[storage.length - 1].S
  const zOf = (S: number) => {
    if (S <= 0) return storage[0].z
    for (let i = 1; i < storage.length; i++)
      if (S <= storage[i].S) {
        const a = storage[i - 1], b = storage[i]
        return a.z + ((b.z - a.z) * (S - a.S)) / Math.max(1e-9, b.S - a.S)
      }
    // above the rim: extend with the top area
    const a = storage[storage.length - 2], b = storage[storage.length - 1]
    const dSdz = (b.S - a.S) / Math.max(1e-9, b.z - a.z)
    return b.z + (S - Smax) / Math.max(1, dSdz)
  }
  let S = 0, maxS = 0, maxZ = storage[0].z
  const sub = 12
  const h = (DT * 3600) / sub
  for (let i = 0; i < inflow.length; i++) {
    const I0 = inflow[Math.max(0, i - 1)], I1 = inflow[i]
    let O = 0
    for (let k = 0; k < sub; k++) {
      const I = I0 + ((I1 - I0) * (k + 0.5)) / sub
      const z = zOf(S)
      O = outflow(o, z)
      S = Math.max(0, S + (I - O) * h)
    }
    out[i] = outflow(o, zOf(S))
    if (S > maxS) { maxS = S; maxZ = zOf(S) }
  }
  return { out, maxS, maxZ, overtops: maxZ > o.rim + 1e-6 }
}

/** TR-55 Ch. 6 storage estimate (Vs/Vr) for Type II/III. */
export function tr55StorageRatio(qo: number, qi: number) {
  const r = Math.min(0.8, Math.max(0.1, qi > 0 ? qo / qi : 1))
  return 0.682 - 1.43 * r + 1.64 * r * r - 0.804 * r * r * r
}
