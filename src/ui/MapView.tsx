import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { AnalysisResult } from '../engine/types'

export const PALETTE = ['#29e8a6', '#e24fd0', '#ffa53d', '#4cc9f0', '#b8f35a', '#ff6f91', '#9b8cff', '#f9d65c', '#5ee0d0', '#ff9a6b', '#7fb2ff', '#d6a2ff']
export const subColor = (i: number) => PALETTE[i % PALETTE.length]

type Toggles = { subs: boolean; tc: boolean; contours: boolean; shade: boolean; labels: boolean; storm: boolean; linework: boolean }

interface Props {
  result: AnalysisResult | null
  selected: string | null
  onSelect: (id: string | null) => void
  emptyTitle: string
  emptyText: string
  snapshotRef?: { current: (() => string) | null }
}

export function MapView({ result, selected, onSelect, emptyTitle, emptyText, snapshotRef }: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const cvs = useRef<HTMLCanvasElement>(null)
  const view = useRef({ cx: 0, cy: 0, scale: 1 })
  const [tg, setTg] = useState<Toggles>({ subs: true, tc: true, contours: true, shade: true, labels: true, storm: true, linework: true })
  const [tip, setTip] = useState<{ x: number; y: number; id: string } | null>(null)
  const raf = useRef(0)

  // raster layers prepared once per result
  const layers = useMemo(() => {
    if (!result) return null
    const { nx, ny } = result.grid
    const shade = document.createElement('canvas')
    shade.width = nx; shade.height = ny
    const sctx = shade.getContext('2d')!
    const img = sctx.createImageData(nx, ny)
    for (let r = 0; r < ny; r++) img.data.set(result.shade.subarray(r * nx * 4, (r + 1) * nx * 4), (ny - 1 - r) * nx * 4)
    sctx.putImageData(img, 0, 0)

    const fill = document.createElement('canvas')
    fill.width = nx; fill.height = ny
    const fctx = fill.getContext('2d')!
    const fimg = fctx.createImageData(nx, ny)
    const colorOf = new Map<number, [number, number, number]>()
    result.subs.forEach((s, k) => colorOf.set(+s.id.slice(1), hex(subColor(k))))
    for (let r = 0; r < ny; r++)
      for (let c = 0; c < nx; c++) {
        const L = result.labels[r * nx + c]
        if (L < 0) continue
        const col = colorOf.get(L)
        if (!col) continue
        const o = ((ny - 1 - r) * nx + c) * 4
        fimg.data[o] = col[0]; fimg.data[o + 1] = col[1]; fimg.data[o + 2] = col[2]; fimg.data[o + 3] = 70
      }
    fctx.putImageData(fimg, 0, 0)
    return { shade, fill }
  }, [result])

  // latest state for the paint loop (observers hold the first closure)
  const live = useRef<any>({})
  live.current = { result, layers, tg, selected }

  const fit = () => {
    const el = cvs.current
    if (!el || !result) return
    const { x0, y0, x1, y1 } = result.bbox
    const w = el.clientWidth, h = el.clientHeight
    view.current = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale: 0.92 * Math.min(w / (x1 - x0), h / (y1 - y0)) }
  }

  useEffect(() => { fit(); draw() }, [result])
  useEffect(() => { draw() }, [tg, selected, layers])

  useEffect(() => {
    const el = cvs.current
    if (!el) return
    const ro = new ResizeObserver(() => draw())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (snapshotRef) snapshotRef.current = () => cvs.current?.toDataURL('image/png') ?? ''

  function draw() {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(paint)
  }

  function paint() {
    const { result, layers, tg, selected } = live.current as { result: AnalysisResult | null; layers: { shade: HTMLCanvasElement; fill: HTMLCanvasElement } | null; tg: Toggles; selected: string | null }
    const el = cvs.current
    if (!el) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const W = el.clientWidth, H = el.clientHeight
    if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) { el.width = Math.round(W * dpr); el.height = Math.round(H * dpr) }
    const ctx = el.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    if (!result || !layers) return
    const css = getComputedStyle(el)
    const C = (n: string) => css.getPropertyValue(n).trim()
    const { cx, cy, scale } = view.current
    const X = (x: number) => (x - cx) * scale + W / 2
    const Y = (y: number) => H / 2 - (y - cy) * scale
    const g = result.grid
    const gx = X(g.x0), gy = Y(g.y0 + g.ny * g.cs), gw = g.nx * g.cs * scale, gh = g.ny * g.cs * scale

    if (tg.shade) { ctx.imageSmoothingEnabled = true; ctx.globalAlpha = 0.9; ctx.drawImage(layers.shade, gx, gy, gw, gh); ctx.globalAlpha = 1 }
    if (tg.subs) { ctx.imageSmoothingEnabled = false; ctx.drawImage(layers.fill, gx, gy, gw, gh) }

    const line = (pts: [number, number][], close = false) => {
      ctx.beginPath()
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))))
      if (close) ctx.closePath()
    }

    if (tg.contours) {
      ctx.strokeStyle = C('--soft'); ctx.globalAlpha = 0.28; ctx.lineWidth = 0.6
      for (const c of result.contours) { line(c); ctx.stroke() }
      ctx.globalAlpha = 1
    }
    if (tg.linework) {
      ctx.strokeStyle = C('--text'); ctx.globalAlpha = 0.35; ctx.lineWidth = 0.8
      for (const c of result.reference) { line(c); ctx.stroke() }
      ctx.globalAlpha = 1
    }
    // basins
    for (const B of result.basins) {
      line(B.ring, true)
      ctx.fillStyle = C('--violet'); ctx.globalAlpha = 0.14; ctx.fill(); ctx.globalAlpha = 1
      ctx.strokeStyle = C('--violet'); ctx.lineWidth = 1.6; ctx.stroke()
    }
    // subcatchment outlines
    if (tg.subs) {
      result.subs.forEach((s, k) => {
        const sel = s.id === selected
        ctx.strokeStyle = sel ? C('--text') : subColor(k)
        ctx.lineWidth = sel ? 2.6 : 1.4
        for (const r of s.rings) {
          line(r.outer, true); ctx.stroke()
          for (const h of r.holes) { line(h, true); ctx.stroke() }
        }
      })
    }
    if (tg.storm) {
      ctx.strokeStyle = C('--text'); ctx.lineWidth = 1.8; ctx.globalAlpha = 0.75
      for (const p of result.pipes) { line(p); ctx.stroke() }
      ctx.globalAlpha = 1
      for (const s of result.structures) {
        const x = X(s.x), y = Y(s.y)
        ctx.fillStyle = s.kind === 'inlet' ? C('--mint') : s.kind === 'ocs' ? C('--violet') : C('--text')
        ctx.strokeStyle = C('--map-bg') || '#000'; ctx.lineWidth = 1.5
        ctx.beginPath()
        if (s.kind === 'outfall') { ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y + 4); ctx.lineTo(x - 5, y + 4); ctx.closePath() }
        else ctx.rect(x - 4, y - 4, 8, 8)
        ctx.fill(); ctx.stroke()
      }
    }
    if (tg.tc) {
      for (const s of result.subs) {
        const dim = selected && s.id !== selected ? 0.35 : 1
        for (const seg of s.segments) {
          ctx.globalAlpha = dim
          ctx.strokeStyle = seg.type === 'sheet' ? C('--amber') : seg.type === 'shallow' ? C('--violet') : C('--mint')
          ctx.lineWidth = seg.type === 'channel' ? 3 : 2.2
          ctx.setLineDash(seg.type === 'sheet' ? [6, 4] : [])
          line(seg.path); ctx.stroke()
        }
        ctx.setLineDash([])
        const last = s.segments[s.segments.length - 1]
        if (last && last.path.length > 1) {
          const a = last.path[last.path.length - 2], b = last.path[last.path.length - 1]
          arrow(ctx, X(a[0]), Y(a[1]), X(b[0]), Y(b[1]), ctx.strokeStyle as string)
        }
        const first = s.segments[0]?.path[0]
        if (first) { ctx.fillStyle = C('--amber'); ctx.beginPath(); ctx.arc(X(first[0]), Y(first[1]), 3, 0, 7); ctx.fill() }
        ctx.globalAlpha = 1
      }
    }
    // design points
    for (const d of result.dps) {
      const x = X(d.x), y = Y(d.y)
      ctx.fillStyle = C('--amber'); ctx.strokeStyle = C('--map-bg') || '#000'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 8, y); ctx.closePath(); ctx.fill(); ctx.stroke()
      halo(ctx, d.name, x + 12, y + 4, '700 12px Sora, sans-serif', C('--amber'), C('--map-bg'))
    }
    if (tg.labels) {
      result.subs.forEach((s) => {
        const x = X(s.label[0]), y = Y(s.label[1])
        halo(ctx, s.name, x, y - 6, '800 14px Sora, sans-serif', C('--text'), C('--map-bg'), 'center')
        halo(ctx, `${s.areaAc.toFixed(2)} ac · CN ${s.cn.toFixed(0)} · Tc ${s.tcMin.toFixed(1)}`, x, y + 9, '500 10.5px "IBM Plex Mono", monospace', C('--soft'), C('--map-bg'), 'center')
      })
    }
    // scale bar
    const ft = niceLen(120 / scale)
    const px = ft * scale
    ctx.fillStyle = C('--soft'); ctx.fillRect(W - 24 - px, H - 22, px, 2)
    ctx.font = '500 10.5px "IBM Plex Mono", monospace'; ctx.textAlign = 'right'
    ctx.fillText(`${ft} ft`, W - 24, H - 28)
  }

  // interaction
  useEffect(() => {
    const el = cvs.current
    if (!el) return
    let drag: { x: number; y: number; moved: boolean } | null = null
    const toWorld = (mx: number, my: number) => {
      const { cx, cy, scale } = view.current
      return [cx + (mx - el.clientWidth / 2) / scale, cy - (my - el.clientHeight / 2) / scale]
    }
    const pick = (mx: number, my: number) => {
      if (!result) return null
      const [wx, wy] = toWorld(mx, my)
      const g = result.grid
      const c = Math.floor((wx - g.x0) / g.cs), r = Math.floor((wy - g.y0) / g.cs)
      if (c < 0 || r < 0 || c >= g.nx || r >= g.ny) return null
      const L = result.labels[r * g.nx + c]
      return L < 0 ? null : `S${L}`
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      const [wx, wy] = toWorld(mx, my)
      const f = Math.exp(-e.deltaY * 0.0015)
      const v = view.current
      v.scale *= f
      v.cx = wx - (mx - el.clientWidth / 2) / v.scale
      v.cy = wy + (my - el.clientHeight / 2) / v.scale
      draw()
    }
    const down = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY, moved: false }; el.setPointerCapture(e.pointerId) }
    const move = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true
        view.current.cx -= dx / view.current.scale
        view.current.cy += dy / view.current.scale
        drag.x = e.clientX; drag.y = e.clientY
        setTip(null)
        draw()
        return
      }
      const id = pick(e.clientX - rect.left, e.clientY - rect.top)
      setTip(id ? { x: e.clientX - rect.left, y: e.clientY - rect.top, id } : null)
    }
    const up = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      if (drag && !drag.moved) onSelect(pick(e.clientX - rect.left, e.clientY - rect.top))
      drag = null
    }
    const leave = () => setTip(null)
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointerleave', leave)
    return () => {
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointerleave', leave)
    }
  }, [result, onSelect])

  const zoom = (f: number) => { view.current.scale *= f; draw() }
  const tipSub = tip && result ? result.subs.find((s) => s.id === tip.id) : null
  const toggle = (k: keyof Toggles) => setTg({ ...tg, [k]: !tg[k] })
  const T: [keyof Toggles, string][] = [['subs', 'Subcatchments'], ['tc', 'Tc paths'], ['labels', 'Labels'], ['storm', 'Drainage'], ['contours', 'Contours'], ['linework', 'Linework'], ['shade', 'Hillshade']]

  return (
    <div class="mapwrap" ref={wrap}>
      <canvas ref={cvs} />
      {!result && (
        <div class="empty">
          <div class="t">{emptyTitle}</div>
          <div class="s">{emptyText}</div>
        </div>
      )}
      {result && (
        <>
          <div class="maptools">
            {T.map(([k, l]) => (
              <button class={`chip ${tg[k] ? 'on' : ''}`} onClick={() => toggle(k)}>{l}</button>
            ))}
          </div>
          <div class="zoombtns">
            <button onClick={() => zoom(1.25)} aria-label="Zoom in">+</button>
            <button onClick={() => zoom(0.8)} aria-label="Zoom out">−</button>
            <button onClick={() => { fit(); draw() }} aria-label="Fit" title="Fit to site">⤢</button>
          </div>
          <div class="legend">
            <span><i style="border-color:var(--amber);border-top-style:dashed" />Sheet</span>
            <span><i style="border-color:var(--violet)" />Shallow conc.</span>
            <span><i style="border-color:var(--mint);border-top-width:3px" />Channel</span>
            <span style="color:var(--amber)">◆ Design point</span>
            <span style="color:var(--mint)">■ Inlet</span>
          </div>
        </>
      )}
      {tipSub && tip && (
        <div class="tip" style={{ left: Math.min(tip.x + 14, (wrap.current?.clientWidth ?? 600) - 200), top: tip.y + 14 }}>
          <b>{tipSub.name}</b> <span class="mono" style="font-size:10.5px;color:var(--faint)">→ {tipSub.toName}</span>
          <div class="r"><span>Area</span><span>{tipSub.areaAc.toFixed(2)} ac</span></div>
          <div class="r"><span>CN</span><span>{tipSub.cn.toFixed(1)}</span></div>
          <div class="r"><span>Impervious</span><span>{tipSub.impervPct.toFixed(0)}%</span></div>
          <div class="r"><span>Tc</span><span>{tipSub.tcMin.toFixed(1)} min</span></div>
          {result!.settings.storms.map((st, k) => (
            <div class="r"><span>{st.label}</span><span>{tipSub.storms[k].peak.toFixed(2)} cfs</span></div>
          ))}
        </div>
      )}
    </div>
  )
}

function hex(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function halo(ctx: CanvasRenderingContext2D, t: string, x: number, y: number, font: string, fill: string, stroke: string, align: CanvasTextAlign = 'left') {
  ctx.font = font
  ctx.textAlign = align
  ctx.lineJoin = 'round'
  ctx.lineWidth = 3
  ctx.strokeStyle = stroke || '#000'
  ctx.strokeText(t, x, y)
  ctx.fillStyle = fill
  ctx.fillText(t, x, y)
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string) {
  const a = Math.atan2(y1 - y0, x1 - x0)
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x1 - 9 * Math.cos(a - 0.45), y1 - 9 * Math.sin(a - 0.45))
  ctx.lineTo(x1 - 9 * Math.cos(a + 0.45), y1 - 9 * Math.sin(a + 0.45))
  ctx.closePath()
  ctx.fill()
}

function niceLen(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}
