import { useState } from 'preact/hooks'
import { compare } from '../engine/compare'
import { DT } from '../engine/runoff'
import type { AnalysisResult } from '../engine/types'

export function CompareView({ pre, post }: { pre: AnalysisResult; post: AnalysisResult }) {
  const { rows, suggestions } = compare(pre, post)
  const storms = post.settings.storms
  const [k, setK] = useState(Math.min(storms.length - 1, 2))
  const over = rows.filter((r) => r.storms.some((s) => !s.ok))
  return (
    <div class="main">
      <div class={`banner ${over.length ? 'bad' : 'good'}`}>
        <div class="big">{over.length ? `${over.length} design point${over.length > 1 ? 's' : ''} exceed existing` : 'Proposed ≤ existing everywhere'}</div>
        <div class="note">
          {over.length
            ? `${over.map((r) => r.name).join(', ')} — ${suggestions.filter((s) => s.level === 'fix').length} suggested fix${suggestions.filter((s) => s.level === 'fix').length === 1 ? '' : 'es'} below.`
            : `Every storm at every design point is at or below the existing peak.`}
        </div>
      </div>

      <div>
        <div class="eyebrow">
          <span>Pre vs. post peak discharge</span>
          <span style="display:flex;gap:6px;flex-wrap:wrap">
            {storms.map((s, i) => (
              <button class={`chip ${i === k ? 'on' : ''}`} onClick={() => setK(i)}>{s.label}</button>
            ))}
          </span>
        </div>
        <div class="cmp-grid">
          {rows.map((r) => {
            const a = pre.dps.find((d) => d.id === r.id)
            const b = post.dps.find((d) => d.id === r.id)
            return (
              <div class="mock">
                <div class="mock__eyebrow">{r.name} · Pre vs. post</div>
                <p class="mock__desc">Tributary {r.preAc.toFixed(2)} → {r.postAc.toFixed(2)} ac · impervious {r.preImpAc.toFixed(2)} → {r.postImpAc.toFixed(2)} ac</p>
                <Hydro a={a?.hydro[k]} b={b?.hydro[k]} />
                <div class="mock__divider" />
                <div class="mock__lines">
                  <div class="mock__line hd"><span>Storm</span><span>Pre / Post (cfs)</span></div>
                  {r.storms.map((s, i) => (
                    <div class={`mock__line ${!s.ok ? 'up' : ''}`} style={i === k ? 'font-weight:600' : ''}>
                      <span>{s.label}</span>
                      <span>{fmt(s.pre)} / {fmt(s.post)}{!s.ok ? ' ▲' : ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div>
        <div class="eyebrow"><span>Suggested improvements</span><span>Preliminary — verify in your routing model</span></div>
        <div class="sugs">
          {suggestions.map((s) => (
            <div class="mock">
              <div class={`mock__flag ${s.level === 'ok' ? 'ok' : s.level === 'warn' ? 'warn' : ''}`}>
                {s.level === 'fix' ? 'Suggested fix' : s.level === 'warn' ? 'Check' : 'Meets existing'}
              </div>
              <div class="mock__title">{s.title}</div>
              <div class="mock__body">{s.body}</div>
              {s.lines && s.lines.length > 0 && (
                <>
                  <div class="mock__divider" />
                  <div class="mock__lines">
                    {s.lines.map(([l, v]) => (
                      <div class={`mock__line ${/overtops/.test(v) ? 'up' : ''}`}><span>{l}</span><span>{v}</span></div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const fmt = (v: number | null) => (v == null ? '—' : v.toFixed(2))

function Hydro({ a, b }: { a?: Float32Array; b?: Float32Array }) {
  const W = 320, H = 120, P = 6
  const t0 = 10, t1 = 18
  const i0 = Math.round(t0 / DT), i1 = Math.round(t1 / DT)
  let max = 0.01
  for (const h of [a, b]) if (h) for (let i = i0; i <= i1; i++) max = Math.max(max, h[i])
  const path = (h?: Float32Array) => {
    if (!h) return ''
    let d = ''
    const step = 2
    for (let i = i0; i <= i1; i += step) {
      const x = P + ((i - i0) / (i1 - i0)) * (W - 2 * P)
      const y = H - P - (h[i] / max) * (H - 2 * P - 10)
      d += `${i === i0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    }
    return d
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style="display:block" role="img" aria-label="Pre and post hydrographs">
      {[12, 14, 16].map((t) => {
        const x = P + ((t - t0) / (t1 - t0)) * (W - 2 * P)
        return (
          <g>
            <line x1={x} x2={x} y1={P} y2={H - P} stroke="var(--line)" stroke-width="1" />
            <text x={x + 3} y={H - P - 2} font-size="9" fill="var(--faint)" font-family="IBM Plex Mono, monospace">{t}h</text>
          </g>
        )
      })}
      <path d={path(a)} fill="none" stroke="var(--amber)" stroke-width="1.8" stroke-dasharray="5 3" />
      <path d={path(b)} fill="none" stroke="var(--mint)" stroke-width="2" />
      <text x={W - P} y={P + 8} text-anchor="end" font-size="9.5" font-family="IBM Plex Mono, monospace" fill="var(--soft)">— post   - - pre</text>
    </svg>
  )
}
