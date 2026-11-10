export type XY = [number, number]
export type Ring = XY[]

export function polyArea(r: Ring) {
  let a = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[i][1] - r[j][1])
  return a / 2 // positive = counter-clockwise
}

export function pointInRing(x: number, y: number, r: Ring) {
  let inside = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function ringBBox(r: Ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of r) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return { x0, y0, x1, y1 }
}

export function centroid(r: Ring): XY {
  let sx = 0, sy = 0
  for (const p of r) { sx += p[0]; sy += p[1] }
  return [sx / r.length, sy / r.length]
}

export interface GridSpec { nx: number; ny: number; x0: number; y0: number; cs: number }

/** Scanline fill (even-odd) of a polygon onto grid cell centers. */
export function rasterizeRing(r: Ring, g: GridSpec, fn: (idx: number) => void) {
  const bb = ringBBox(r)
  const r0 = Math.max(0, Math.floor((bb.y0 - g.y0) / g.cs - 0.5))
  const r1 = Math.min(g.ny - 1, Math.ceil((bb.y1 - g.y0) / g.cs - 0.5))
  const xs: number[] = []
  for (let row = r0; row <= r1; row++) {
    const y = g.y0 + (row + 0.5) * g.cs
    xs.length = 0
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const yi = r[i][1], yj = r[j][1]
      if (yi > y !== yj > y) xs.push(r[i][0] + ((y - yi) * (r[j][0] - r[i][0])) / (yj - yi))
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.cs - 0.5))
      const c1 = Math.min(g.nx - 1, Math.floor((xs[k + 1] - g.x0) / g.cs - 0.5))
      for (let c = c0; c <= c1; c++) fn(row * g.nx + c)
    }
  }
}

/** Douglas–Peucker on an open polyline. */
export function simplify(pts: XY[], tol: number): XY[] {
  if (pts.length < 3) return pts.slice()
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  const t2 = tol * tol
  while (stack.length) {
    const [a, b] = stack.pop()!
    let max = -1, idx = -1
    const [ax, ay] = pts[a], [bx, by] = pts[b]
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]
      let d: number
      if (L === 0) d = (px - ax) ** 2 + (py - ay) ** 2
      else {
        let t = ((px - ax) * dx + (py - ay) * dy) / L
        t = Math.max(0, Math.min(1, t))
        d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
      }
      if (d > max) { max = d; idx = i }
    }
    if (max > t2 && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]) }
  }
  return pts.filter((_, i) => keep[i])
}

export function simplifyRing(r: Ring, tol: number): Ring {
  if (r.length < 5) return r
  // split at the point farthest from the first vertex so both halves are open polylines
  let far = 0, fd = -1
  for (let i = 1; i < r.length; i++) {
    const d = (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2
    if (d > fd) { fd = d; far = i }
  }
  const a = simplify(r.slice(0, far + 1), tol)
  const b = simplify([...r.slice(far), r[0]], tol)
  const out = [...a, ...b.slice(1, -1)]
  return out.length >= 3 ? out : r
}

/**
 * Traces boundaries of every label region in a raster (labels < 0 ignored).
 * Returns rings in world coordinates; outer rings CCW, holes CW.
 */
export function traceLabels(labels: Int32Array, g: GridSpec): Map<number, { outer: Ring; holes: Ring[] }[]> {
  const { nx, ny } = g
  const byLabel = new Map<number, Map<number, number[]>>() // label -> startVertex -> [edge endVertex,...]
  const W = nx + 1
  const add = (L: number, a: number, b: number) => {
    let m = byLabel.get(L)
    if (!m) byLabel.set(L, (m = new Map()))
    const arr = m.get(a)
    if (arr) arr.push(b)
    else m.set(a, [b])
  }
  for (let r = 0; r < ny; r++)
    for (let c = 0; c < nx; c++) {
      const L = labels[r * nx + c]
      if (L < 0) continue
      const v = (i: number, j: number) => j * W + i
      if (r === 0 || labels[(r - 1) * nx + c] !== L) add(L, v(c, r), v(c + 1, r))
      if (c === nx - 1 || labels[r * nx + c + 1] !== L) add(L, v(c + 1, r), v(c + 1, r + 1))
      if (r === ny - 1 || labels[(r + 1) * nx + c] !== L) add(L, v(c + 1, r + 1), v(c, r + 1))
      if (c === 0 || labels[r * nx + c - 1] !== L) add(L, v(c, r + 1), v(c, r))
    }

  const out = new Map<number, { outer: Ring; holes: Ring[] }[]>()
  for (const [L, m] of byLabel) {
    const rings: Ring[] = []
    for (const [start, ends] of m) {
      while (ends.length) {
        const loop: number[] = [start]
        let prev = start
        let cur = ends.pop()!
        let guard = 0
        while (cur !== start && guard++ < 1e7) {
          loop.push(cur)
          const opts = m.get(cur)
          if (!opts || !opts.length) break
          let pick = 0
          if (opts.length > 1) {
            const dx = (cur % W) - (prev % W), dy = Math.floor(cur / W) - Math.floor(prev / W)
            const lx = -dy, ly = dx
            for (let k = 0; k < opts.length; k++) {
              const ox = (opts[k] % W) - (cur % W), oy = Math.floor(opts[k] / W) - Math.floor(cur / W)
              if (ox === lx && oy === ly) { pick = k; break }
            }
          }
          const nxt = opts.splice(pick, 1)[0]
          prev = cur
          cur = nxt
        }
        if (loop.length >= 4) rings.push(loop.map((v) => [g.x0 + (v % W) * g.cs, g.y0 + Math.floor(v / W) * g.cs] as XY))
      }
    }
    const outers = rings.filter((r) => polyArea(r) > 0).map((outer) => ({ outer, holes: [] as Ring[] }))
    for (const h of rings.filter((r) => polyArea(r) < 0)) {
      const o = outers.find((o) => pointInRing(h[0][0] + 1e-6, h[0][1] + 1e-6, o.outer)) ?? outers[0]
      if (o) o.holes.push(h)
    }
    out.set(L, outers)
  }
  return out
}

/** Binary min-heap keyed by float, storing int payloads. */
export class MinHeap {
  private k: Float64Array
  private v: Int32Array
  size = 0
  constructor(cap = 1024) {
    this.k = new Float64Array(cap)
    this.v = new Int32Array(cap)
  }
  push(key: number, val: number) {
    if (this.size === this.k.length) {
      const k = new Float64Array(this.size * 2); k.set(this.k); this.k = k
      const v = new Int32Array(this.size * 2); v.set(this.v); this.v = v
    }
    let i = this.size++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.k[p] <= key) break
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p
    }
    this.k[i] = key; this.v[i] = val
  }
  pop(): number {
    const top = this.v[0]
    const n = --this.size
    if (n > 0) {
      const key = this.k[n], val = this.v[n]
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && this.k[c + 1] < this.k[c]) c++
        if (this.k[c] >= key) break
        this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c
      }
      this.k[i] = key; this.v[i] = val
    }
    return top
  }
}
