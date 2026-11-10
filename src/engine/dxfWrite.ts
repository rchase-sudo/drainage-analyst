// Minimal AutoCAD R12 ASCII DXF writer. R12 opens in every CAD package
// (Civil 3D, AutoCAD, Carlson, Bentley, BricsCAD, Bluebeam's DXF import).

type P2 = [number, number] | [number, number, number]

export class DxfWriter {
  private layers = new Map<string, { color: number; ltype: string }>()
  private body: string[] = []

  layer(name: string, color = 7, ltype = 'CONTINUOUS') {
    this.layers.set(name, { color, ltype })
    return this
  }

  private g(code: number, v: string | number) {
    this.body.push(String(code), typeof v === 'number' ? fmt(v) : v)
  }

  private ensure(layer: string) {
    if (!this.layers.has(layer)) this.layers.set(layer, { color: 7, ltype: 'CONTINUOUS' })
  }

  /** 2D polyline at an optional elevation, or a 3D polyline when every point has z and is3d is set. */
  polyline(layer: string, pts: P2[], closed = false, opts: { is3d?: boolean; elevation?: number; color?: number } = {}) {
    if (pts.length < 2) return this
    this.ensure(layer)
    const is3d = !!opts.is3d
    this.g(0, 'POLYLINE')
    this.g(8, layer)
    if (opts.color != null) this.g(62, opts.color)
    this.g(66, 1)
    this.g(10, 0); this.g(20, 0); this.g(30, is3d ? 0 : opts.elevation ?? 0)
    this.g(70, (closed ? 1 : 0) | (is3d ? 8 : 0))
    for (const p of pts) {
      this.g(0, 'VERTEX')
      this.g(8, layer)
      this.g(10, p[0]); this.g(20, p[1]); this.g(30, is3d ? (p[2] ?? 0) : opts.elevation ?? 0)
      this.g(70, is3d ? 32 : 0)
    }
    this.g(0, 'SEQEND')
    this.g(8, layer)
    return this
  }

  line(layer: string, a: P2, b: P2) {
    this.ensure(layer)
    this.g(0, 'LINE'); this.g(8, layer)
    this.g(10, a[0]); this.g(20, a[1]); this.g(30, a[2] ?? 0)
    this.g(11, b[0]); this.g(21, b[1]); this.g(31, b[2] ?? 0)
    return this
  }

  circle(layer: string, c: P2, r: number) {
    this.ensure(layer)
    this.g(0, 'CIRCLE'); this.g(8, layer)
    this.g(10, c[0]); this.g(20, c[1]); this.g(30, c[2] ?? 0); this.g(40, r)
    return this
  }

  point(layer: string, p: P2) {
    this.ensure(layer)
    this.g(0, 'POINT'); this.g(8, layer)
    this.g(10, p[0]); this.g(20, p[1]); this.g(30, p[2] ?? 0)
    return this
  }

  face(layer: string, a: P2, b: P2, c: P2) {
    this.ensure(layer)
    this.g(0, '3DFACE'); this.g(8, layer)
    const v = [a, b, c, c]
    v.forEach((p, i) => { this.g(10 + i, p[0]); this.g(20 + i, p[1]); this.g(30 + i, p[2] ?? 0) })
    return this
  }

  /** Middle-center justified text. */
  text(layer: string, p: P2, height: number, value: string, rotationDeg = 0) {
    this.ensure(layer)
    this.g(0, 'TEXT'); this.g(8, layer)
    this.g(10, p[0]); this.g(20, p[1]); this.g(30, 0)
    this.g(40, height)
    this.g(1, value.replace(/[\r\n]+/g, ' '))
    if (rotationDeg) this.g(50, rotationDeg)
    this.g(72, 1) // center
    this.g(73, 2) // middle
    this.g(11, p[0]); this.g(21, p[1]); this.g(31, 0)
    return this
  }

  toString(insUnits = 2) {
    const out: string[] = []
    const g = (c: number, v: string | number) => out.push(String(c), String(v))
    g(0, 'SECTION'); g(2, 'HEADER')
    g(9, '$ACADVER'); g(1, 'AC1009')
    g(9, '$INSUNITS'); g(70, insUnits)
    g(0, 'ENDSEC')
    g(0, 'SECTION'); g(2, 'TABLES')
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 2)
    g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0)
    g(0, 'LTYPE'); g(2, 'DASHED'); g(70, 0); g(3, '__ __ __'); g(72, 65); g(73, 2); g(40, 7.5); g(49, 5); g(49, -2.5)
    g(0, 'ENDTAB')
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, this.layers.size + 1)
    g(0, 'LAYER'); g(2, '0'); g(70, 0); g(62, 7); g(6, 'CONTINUOUS')
    for (const [name, l] of this.layers) {
      if (name === '0') continue
      g(0, 'LAYER'); g(2, name); g(70, 0); g(62, l.color); g(6, l.ltype)
    }
    g(0, 'ENDTAB')
    g(0, 'ENDSEC')
    g(0, 'SECTION'); g(2, 'ENTITIES')
    for (const b of this.body) out.push(b)
    g(0, 'ENDSEC')
    g(0, 'EOF')
    return out.join('\r\n') + '\r\n'
  }
}

function fmt(n: number) {
  if (!Number.isFinite(n)) return '0'
  return Number.isInteger(n) ? String(n) : n.toFixed(4)
}
