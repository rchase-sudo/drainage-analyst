import type { AnalysisResult, Subcatchment } from '../engine/types'
import { subColor } from './MapView'

export function Kpis({ r }: { r: AnalysisResult }) {
  const imp = r.subs.reduce((s, x) => s + (x.areaAc * x.impervPct) / 100, 0)
  return (
    <div class="kpis">
      <div class="kpi"><div class="v">{r.studyAc.toFixed(2)}</div><div class="l">Acres analyzed</div></div>
      <div class="kpi"><div class="v">{r.subs.length}</div><div class="l">Subcatchments</div></div>
      <div class="kpi"><div class="v">{r.dps.length}</div><div class="l">Design points</div></div>
      <div class="kpi"><div class="v">{((100 * imp) / r.studyAc).toFixed(0)}%</div><div class="l">Impervious</div></div>
      <div class="kpi"><div class="v">{r.grid.cs}</div><div class="l">Cell (ft)</div></div>
      <div class="kpi"><div class="v">{(r.zmax - r.zmin).toFixed(0)}</div><div class="l">Relief (ft)</div></div>
    </div>
  )
}

export function DPTable({ r }: { r: AnalysisResult }) {
  const st = r.settings.storms
  return (
    <div class="tbl-wrap">
      <table class="t">
        <thead>
          <tr>
            <th>Design point</th>
            <th>Tributary (ac)</th>
            <th>Imperv. (ac)</th>
            {st.map((s) => <th>{s.label} (cfs)</th>)}
          </tr>
        </thead>
        <tbody>
          {r.dps.map((d) => (
            <tr>
              <td><span class="sw" style="background:var(--amber);transform:rotate(45deg)" />{d.name}</td>
              <td>{d.tributaryAc.toFixed(2)}</td>
              <td>{d.impervAc.toFixed(2)}</td>
              {d.storms.map((x) => <td>{x.peak.toFixed(2)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function SubTable({ r, selected, onSelect }: { r: AnalysisResult; selected: string | null; onSelect: (id: string) => void }) {
  const st = r.settings.storms
  return (
    <div class="tbl-wrap">
      <table class="t">
        <thead>
          <tr>
            <th>Subcatchment</th>
            <th class="l">Drains to</th>
            <th>Area (ac)</th>
            <th>CN</th>
            <th>Imp. %</th>
            <th>Tc (min)</th>
            {st.map((s) => <th>{s.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {r.subs.map((s, k) => (
            <tr class={s.id === selected ? 'sel' : ''} onClick={() => onSelect(s.id)}>
              <td><span class="sw" style={{ background: subColor(k) }} />{s.name}</td>
              <td class="l">{s.toName}</td>
              <td>{s.areaAc.toFixed(2)}</td>
              <td>{s.cn.toFixed(1)}</td>
              <td>{s.impervPct.toFixed(0)}</td>
              <td>{s.tcMin.toFixed(1)}</td>
              {s.storms.map((x) => <td>{x.peak.toFixed(2)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function SubDetail({ r, s }: { r: AnalysisResult; s: Subcatchment }) {
  const segColor = { sheet: 'var(--amber)', shallow: 'var(--violet)', channel: 'var(--mint)' }
  const floor = s.tcRaw < r.settings.minTcMin
  return (
    <div class="detail">
      <div class="mock">
        <div class="mock__eyebrow">{s.name} · Time of concentration (TR-55)</div>
        <p class="mock__desc">Longest travel-time path, traced from the surface, to {s.toName}</p>
        <div class="mock__divider" />
        <div class="mock__lines">
          <div class="mock__line hd"><span>Segment</span><span>L · slope · V → time</span></div>
          {s.segments.map((g) => (
            <div class="mock__line">
              <span><span class="seg" style={{ borderColor: segColor[g.type], borderTopStyle: g.type === 'sheet' ? 'dashed' : 'solid' }} />{g.type === 'sheet' ? `Sheet · ${g.surface} n=${g.n}` : g.type === 'shallow' ? `Shallow conc. · ${g.surface}` : g.surface}</span>
              <span>{g.L.toFixed(0)} ft · {(g.s * 100).toFixed(1)}% · {g.V.toFixed(2)} fps → {g.t.toFixed(1)} min</span>
            </div>
          ))}
        </div>
        <div class="mock__divider" />
        <div class="mock__price">
          <span class="mock__price-label">Tc used</span>
          <span class="mock__price-value">{s.tcMin.toFixed(1)} min</span>
        </div>
        {floor && <div class="note">Computed {s.tcRaw.toFixed(1)} min; the {r.settings.minTcMin}-min minimum applies.</div>}
      </div>
      <div class="mock">
        <div class="mock__eyebrow">{s.name} · Area &amp; runoff</div>
        <p class="mock__desc">{s.areaAc.toFixed(3)} ac · weighted CN {s.cn.toFixed(1)} · {s.impervPct.toFixed(0)}% impervious</p>
        <div class="mock__divider" />
        <div class="mock__lines">
          <div class="mock__line hd"><span>Cover · HSG</span><span>ac · CN</span></div>
          {s.covers.map((c) => (
            <div class="mock__line"><span>{c.desc} · {c.hsg}</span><span>{c.areaAc.toFixed(3)} · {c.cn}</span></div>
          ))}
        </div>
        <div class="mock__divider" />
        <div class="mock__lines">
          <div class="mock__line hd"><span>Storm · P</span><span>Q · peak · vol</span></div>
          {s.storms.map((x, k) => (
            <div class="mock__line"><span>{r.settings.storms[k].label} · {x.P.toFixed(2)} in</span><span>{x.Q.toFixed(2)} in · {x.peak.toFixed(2)} cfs · {(x.volAcFt * 43560).toFixed(0)} cf</span></div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function BasinCards({ r }: { r: AnalysisResult }) {
  if (!r.basins.length) return null
  return (
    <div class="detail">
      {r.basins.map((B) => (
        <div class="mock">
          <div class="mock__eyebrow">{B.name} · Stage-storage from the proposed surface</div>
          <p class="mock__desc">Bottom {B.bottom.toFixed(2)} · rim {B.rim.toFixed(2)} · {Math.round(B.maxStorage).toLocaleString()} cf to rim · outlet {B.piped ? 'piped' : 'overland'} to {B.outflowTo}</p>
          <div class="mock__divider" />
          {B.outlet ? (
            <>
              <div class={`mock__flag ${B.outlet.meetsAll ? 'ok' : ''}`}>{B.outlet.meetsAll ? 'Outlet sized' : 'Outlet best effort'}</div>
              <div class="mock__lines">
                <div class="mock__line"><span>Low orifice</span><span>{B.outlet.orificeIn}" @ {B.bottom.toFixed(2)}</span></div>
                {B.outlet.weirCrest != null && <div class="mock__line"><span>Weir</span><span>{B.outlet.weirLength} ft @ {B.outlet.weirCrest.toFixed(2)}</span></div>}
                <div class="mock__line hd" style="margin-top:6px"><span>Storm</span><span>in → out · WSE</span></div>
                {B.outlet.results.map((x, k) => (
                  <div class={`mock__line ${x.overtops ? 'up' : ''}`}><span>{r.settings.storms[k].label}</span><span>{x.peakIn.toFixed(2)} → {x.peakOut.toFixed(2)} cfs · {x.stage.toFixed(2)}{x.overtops ? ' ▲' : ''}</span></div>
                ))}
              </div>
            </>
          ) : (
            <div class="note">Analyze the existing condition and the outlet is sized automatically to match existing peaks.</div>
          )}
        </div>
      ))}
    </div>
  )
}
