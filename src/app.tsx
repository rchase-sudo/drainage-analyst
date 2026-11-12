import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { exportCsv, exportDxf } from './engine/exportDxf'
import { ROLE_LABELS } from './engine/importer'
import { COVERS, COVER_KEYS } from './engine/runoff'
import { DEFAULT_SETTINGS, type AnalysisResult, type Condition, type LayerInfo, type Role, type Settings } from './engine/types'
import type { WorkerIn, WorkerOut } from './worker'
import { CompareView } from './ui/Compare'
import { MapView } from './ui/MapView'
import { BasinCards, DPTable, Kpis, SubDetail, SubTable } from './ui/Results'

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never
type Status = 'empty' | 'loading' | 'running' | 'done' | 'error'
interface CondState {
  files: string[]
  units: string
  layers: LayerInfo[]
  roles: Record<string, Role>
  status: Status
  msg: string
  error: string
  result: AnalysisResult | null
}
const blank = (): CondState => ({ files: [], units: 'ft', layers: [], roles: {}, status: 'empty', msg: '', error: '', result: null })

const LS = 'apollo-drainage-settings-v1'
function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(LS) ?? 'null')
    if (s && Array.isArray(s.storms)) return { ...DEFAULT_SETTINGS, ...s }
  } catch { /* storage unavailable */ }
  return DEFAULT_SETTINGS
}

export function App() {
  const [tab, setTab] = useState<Condition | 'compare'>('pre')
  const [st, setSt] = useState<Record<Condition, CondState>>({ pre: blank(), post: blank() })
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [drawer, setDrawer] = useState(false)
  const [sel, setSel] = useState<Record<Condition, string | null>>({ pre: null, post: null })
  const live = useRef({ st, settings })
  live.current = { st, settings }
  const snap = useRef<(() => string) | null>(null)
  const [snapshot, setSnapshot] = useState('')

  const worker = useMemo(() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }), [])
  const reqId = useRef(0)
  const latest = useRef<Record<Condition, number>>({ pre: 0, post: 0 })

  const patch = (c: Condition, p: Partial<CondState>) => setSt((s) => ({ ...s, [c]: { ...s[c], ...p } }))
  const send = (m: DistributiveOmit<WorkerIn, 'id'>) => {
    const id = ++reqId.current
    worker.postMessage({ ...m, id } as WorkerIn)
    return id
  }

  const [sortNote, setSortNote] = useState<string[]>([])
  const autoCompare = useRef(false)
  const [dragAll, setDragAll] = useState(false)

  const run = (c: Condition) => {
    const cur = live.current.st[c]
    if (!cur.layers.length && !cur.files.length) return
    patch(c, { status: 'running', msg: 'Starting', error: '' })
    latest.current[c] = send({ type: 'run', condition: c, roles: cur.roles, settings: live.current.settings })
  }

  useEffect(() => {
    worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const m = ev.data
      const c = m.condition
      if (m.type === 'sorted') {
        setSortNote(m.notes)
        setSt((s) => ({ pre: m.has.pre ? s.pre : blank(), post: m.has.post ? s.post : blank() }))
        live.current.st = { pre: m.has.pre ? { ...live.current.st.pre, status: 'loading' } : blank(), post: m.has.post ? live.current.st.post : blank() }
        setTab(m.has.pre ? 'pre' : 'post')
        return
      }
      if (m.type === 'loaded') {
        const roles = Object.fromEntries(m.layers.map((l) => [l.name, l.role]))
        patch(c, { layers: m.layers, roles, files: m.files, units: m.units, status: 'running', msg: 'Reading layers' })
        live.current.st = { ...live.current.st, [c]: { ...live.current.st[c], layers: m.layers, roles, files: m.files } }
        const preBusy = live.current.st.pre.status === 'loading' || live.current.st.pre.status === 'running'
        if (c === 'post' && preBusy) return // the pre result triggers post
        // the proposed plan may carry the limit of disturbance the existing run should use: re-run existing first
        if (c === 'post' && live.current.st.pre.files.length && m.layers.some((l) => l.role === 'site')) { run('pre'); return }
        run(c)
      } else if (m.type === 'progress') {
        if (m.id === latest.current[c]) patch(c, { msg: m.msg })
      } else if (m.type === 'error') {
        patch(c, { status: 'error', error: m.message, msg: '' })
      } else if (m.type === 'result') {
        if (m.id !== latest.current[c]) return
        patch(c, { status: 'done', result: m.result as AnalysisResult, msg: '' })
        if (c === 'post' && autoCompare.current && live.current.st.pre.status === 'done') { autoCompare.current = false; setTab('compare') }
        if (c === 'pre') {
          live.current.st = { ...live.current.st, pre: { ...live.current.st.pre, status: 'done' } }
          if (live.current.st.post.files.length) run('post')
        }
      }
    }
  }, [worker])

  // auto height for the Framer embed
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      try { window.parent?.postMessage({ type: 'apollo-drainage:height', height: document.documentElement.scrollHeight }, '*') } catch { /* not framed */ }
    })
    ro.observe(document.body)
    return () => ro.disconnect()
  }, [])

  const readFiles = async (c: Condition, list: File[]) => {
    const ok = list.filter((f) => /\.(dxf|xml)$/i.test(f.name))
    if (!ok.length) { patch(c, { status: 'error', error: 'Drop a .dxf (ASCII) or LandXML .xml file.' }); return }
    if (/\.dwg$/i.test(list[0]?.name ?? '')) { patch(c, { status: 'error', error: 'DWG is not supported; export DXF from CAD.' }); return }
    patch(c, { status: 'loading', msg: 'Reading file', error: '', result: null })
    const files = await Promise.all(ok.map(async (f) => ({ name: f.name, text: await f.text() })))
    if (c === 'pre') live.current.st = { ...live.current.st, pre: { ...live.current.st.pre, status: 'loading' } }
    send({ type: 'load', condition: c, files })
    setTab(c)
  }

  // Drop everything at once: files are sorted into existing / proposed and the whole pre → post → compare
  // chain runs with no further input.
  const intake = async (list: File[]) => {
    const ok = list.filter((f) => /\.(dxf|xml)$/i.test(f.name))
    if (!ok.length) { patch('pre', { status: 'error', error: list.some((f) => /\.dwg$/i.test(f.name)) ? 'DWG is not supported; save as DXF from CAD.' : 'Drop .dxf (ASCII) or LandXML .xml files.' }); return }
    patch('pre', { ...blank(), status: 'loading', msg: 'Reading and sorting files' })
    patch('post', { ...blank(), status: 'loading', msg: 'Waiting' })
    live.current.st = { pre: { ...blank(), status: 'loading' }, post: blank() }
    autoCompare.current = true
    const files = await Promise.all(ok.map(async (f) => ({ name: f.name, text: await f.text() })))
    send({ type: 'intake', files })
  }
  useEffect(() => {
    const over = (e: DragEvent) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragAll(true) } }
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragAll(false) }
    const drop = (e: DragEvent) => {
      setDragAll(false)
      if (e.defaultPrevented) return // a per-condition drop zone took it
      e.preventDefault()
      intake([...(e.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop)
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop) }
  }, [])
  const allInput = useRef<HTMLInputElement>(null)

  const loadSample = async () => {
    const get = async (n: string) => ({ name: n, text: await (await fetch(`./samples/${n}`)).text() })
    patch('pre', { status: 'loading', msg: 'Loading sample', error: '', result: null })
    patch('post', { status: 'loading', msg: 'Waiting for existing', error: '', result: null })
    live.current.st = { ...live.current.st, pre: { ...live.current.st.pre, status: 'loading' } }
    const [a, b] = await Promise.all([get('existing-conditions.dxf'), get('proposed-conditions.dxf')])
    send({ type: 'load', condition: 'pre', files: [a] })
    send({ type: 'load', condition: 'post', files: [b] })
    setTab('pre')
  }

  const clear = (c: Condition) => {
    send({ type: 'clear', condition: c })
    setSt((s) => ({ ...s, [c]: blank() }))
    if (c === 'pre' && live.current.st.post.files.length) setTimeout(() => run('post'), 50)
  }

  // re-run when roles/settings change (debounced)
  const timer = useRef<Record<string, number>>({})
  const schedule = (c: Condition) => {
    clearTimeout(timer.current[c])
    timer.current[c] = window.setTimeout(() => run(c), 350)
  }
  const setRole = (c: Condition, layer: string, role: Role) => {
    const roles = { ...live.current.st[c].roles, [layer]: role }
    patch(c, { roles })
    live.current.st = { ...live.current.st, [c]: { ...live.current.st[c], roles } }
    schedule(c)
  }
  const applySettings = (s: Settings) => {
    setSettings(s)
    live.current.settings = s
    try { localStorage.setItem(LS, JSON.stringify(s)) } catch { /* ignore */ }
    if (live.current.st.pre.files.length) schedule('pre')
    else if (live.current.st.post.files.length) schedule('post')
  }

  const download = (name: string, text: string, type = 'application/dxf') => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type }))
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }
  const base = (c: Condition) => (st[c].files[0] ?? (c === 'pre' ? 'existing' : 'proposed')).replace(/\.(dxf|xml)$/i, '')

  const printReport = () => {
    setSnapshot(snap.current?.() ?? '')
    setTimeout(() => window.print(), 80)
  }

  const stepInfo = (c: Condition) => {
    const s = st[c]
    if (s.status === 'empty') return { dot: '', text: 'Drop a DXF or LandXML' }
    if (s.status === 'loading' || s.status === 'running') return { dot: 'run', text: s.msg || 'Working' }
    if (s.status === 'error') return { dot: 'bad', text: 'Needs attention' }
    const r = s.result!
    return { dot: 'ok', text: `${r.studyAc.toFixed(2)} ac · ${r.subs.length} subcatchments · ${r.dps.length} DP` }
  }
  const canCompare = !!st.pre.result && !!st.post.result

  return (
    <div class="app">
      <header class="top">
        <div class="brand">
          <div class="mark" aria-hidden="true" />
          <div>
            <h1>Drainage Analyst</h1>
            <div class="tag">Apollo · Pre / post · TR-55 · NRCS UH</div>
          </div>
        </div>
        <div class="actions no-print">
          <button class="btn ghost" onClick={loadSample}>Load sample site</button>
          <button class="btn primary" onClick={() => allInput.current?.click()}>Drop project files</button>
          <input ref={allInput} type="file" accept=".dxf,.xml" multiple hidden onChange={(e) => { const t = e.target as HTMLInputElement; intake([...(t.files ?? [])]); t.value = '' }} />
          <button class="btn" onClick={() => setDrawer(true)}>Storms &amp; settings</button>
        </div>
      </header>

      {dragAll && <div class="dropall">Drop every file for the project — existing, proposed, surface. They are sorted automatically.</div>}
      {st.pre.status === 'empty' && st.post.status === 'empty' && (
        <div class="hero no-print" onClick={() => allInput.current?.click()}>
          <div class="big">Drop the whole project here</div>
          <div class="small">Existing plan, proposed plan, LiDAR or TIN — any mix of DXF and LandXML, all at once. Files are sorted, both conditions are analyzed, and the comparison opens on its own.</div>
        </div>
      )}
      {sortNote.length > 0 && (st.pre.files.length > 0 || st.post.files.length > 0) && (
        <div class="sortnote no-print"><b>Sorted automatically</b> · {sortNote.join(' · ')} · <span>drop a file on a step to override</span></div>
      )}

      <nav class="steps no-print">
        {(['pre', 'post'] as Condition[]).map((c, i) => {
          const info = stepInfo(c)
          return (
            <button class={`step ${tab === c ? 'on' : ''}`} onClick={() => setTab(c)}>
              <span class="n">0{i + 1}</span>
              <span class="t">{c === 'pre' ? 'Existing conditions' : 'Proposed conditions'}</span>
              <span class="s"><span class={`dot ${info.dot}`} />{info.text}</span>
            </button>
          )
        })}
        <button class={`step ${tab === 'compare' ? 'on' : ''}`} onClick={() => setTab('compare')}>
          <span class="n">03</span>
          <span class="t">Compare &amp; improve</span>
          <span class="s"><span class={`dot ${canCompare ? 'ok' : ''}`} />{canCompare ? 'Pre vs. post ready' : 'Needs both conditions'}</span>
        </button>
      </nav>

      {tab !== 'compare' && (
        <CondPanel
          key={tab}
          c={tab}
          s={st[tab]}
          settings={settings}
          selected={sel[tab]}
          onSelect={(id) => setSel({ ...sel, [tab]: id })}
          onFiles={(f) => readFiles(tab, f)}
          onRole={(l, r) => setRole(tab, l, r)}
          onClear={() => clear(tab)}
          onDxf={() => st[tab].result && download(`${base(tab)}-subcatchments.dxf`, exportDxf(st[tab].result!, st[tab].units as 'ft' | 'm'))}
          onCsv={() => st[tab].result && download(`${base(tab)}-drainage.csv`, exportCsv(st[tab].result!), 'text/csv')}
          onPrint={printReport}
          snapshotRef={snap}
          snapshot={snapshot}
          preReady={!!st.pre.result}
        />
      )}
      {tab === 'compare' &&
        (canCompare ? (
          <>
            <div class="actions no-print" style="justify-content:flex-end;margin-bottom:12px">
              <button class="btn primary" onClick={() => download(`${base('post')}-pre-post-subcatchments.dxf`, exportDxf([st.pre.result!, st.post.result!], st.post.units as 'ft' | 'm'))}>Export pre + post DXF</button>
            </div>
            <CompareView pre={st.pre.result!} post={st.post.result!} />
          </>
        ) : (
          <div class="panel results"><div class="note">Analyze both the existing and the proposed condition to compare them.</div></div>
        ))}

      {drawer && <SettingsDrawer s={settings} units={[...(st.pre.result?.soilUnits ?? []), ...(st.post.result?.soilUnits ?? [])]} onChange={applySettings} onClose={() => setDrawer(false)} />}

      <div class="foot">
        <span>Preliminary analysis — TR-55 Tc (sheet + shallow concentrated by surface), CN from drawn cover and soils, SCS runoff, NRCS dimensionless unit hydrograph, level-pool basin routing. Verify before design submittal.</span>
        <span>© Apollo Development</span>
      </div>
    </div>
  )
}

function CondPanel(p: {
  c: Condition
  s: CondState
  settings: Settings
  selected: string | null
  onSelect: (id: string | null) => void
  onFiles: (f: File[]) => void
  onRole: (layer: string, r: Role) => void
  onClear: () => void
  onDxf: () => void
  onCsv: () => void
  onPrint: () => void
  snapshotRef: { current: (() => string) | null }
  snapshot: string
  preReady: boolean
}) {
  const { c, s } = p
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const r = s.result
  const selSub = r?.subs.find((x) => x.id === p.selected) ?? null
  const busy = s.status === 'loading' || s.status === 'running'
  const used = (role: Role) => role !== 'reference' && role !== 'ignore'
  const label = c === 'pre' ? 'existing' : 'proposed'

  return (
    <div class="work">
      <aside class="side">
        <div class="panel">
          <div class="eyebrow"><span>{c === 'pre' ? 'Existing conditions' : 'Proposed conditions'}</span>{s.files.length > 0 && <button class="btn sm ghost" onClick={p.onClear}>Clear</button>}</div>
          <div
            class={`drop ${over ? 'over' : ''}`}
            onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true) }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); p.onFiles([...(e.dataTransfer?.files ?? [])]) }}
          >
            <div class="big">Drop the {label} plan</div>
            <div class="small">DXF with contours, cover and drainage (open or closed linework) — or a LandXML TIN plus a DXF. Analysis runs on drop.</div>
            <input ref={input} type="file" accept=".dxf,.xml" multiple hidden onChange={(e) => p.onFiles([...((e.target as HTMLInputElement).files ?? [])])} />
          </div>
          {s.files.length > 0 && (
            <div class="files">
              {s.files.map((f) => <div class="file"><span>{f}</span><span>{s.units}</span></div>)}
            </div>
          )}
          {c === 'post' && !p.preReady && s.files.length > 0 && (
            <div class="warn">Load the existing condition too: proposed design points, undisturbed cover and outlet sizing come from it.</div>
          )}
        </div>

        {(busy || s.error) && (
          <div class="panel">
            {busy && <div class="progress"><span class="spinner" />{s.msg || 'Working'}…</div>}
            {s.error && <div class="err">{s.error}</div>}
          </div>
        )}

        {r && <Kpis r={r} />}

        {s.layers.length > 0 && (
          <div class="panel">
            <div class="eyebrow"><span>Layers <b>· auto-mapped</b></span><span>{s.layers.filter((l) => used(s.roles[l.name] ?? l.role)).length}/{s.layers.length}</span></div>
            <div class="layers">
              {s.layers.map((l) => {
                const role = s.roles[l.name] ?? l.role
                return (
                  <div class={`lay ${used(role) ? 'used' : ''}`}>
                    <div>
                      <div class="nm" title={l.name}>{l.name}</div>
                      <div class="ct">{l.count} obj{l.closed ? ` · ${l.closed} closed` : ''}{l.withZ ? ` · ${l.withZ} w/ elev` : ''}</div>
                    </div>
                    <select value={role} onChange={(e) => p.onRole(l.name, (e.target as HTMLSelectElement).value as Role)}>
                      {ROLE_LABELS.map((o) => <option value={o.role}>{o.label}</option>)}
                    </select>
                  </div>
                )
              })}
            </div>
            <div class="note" style="margin-top:8px">Change any role and the analysis re-runs.</div>
          </div>
        )}

        {r && r.warnings.length > 0 && (
          <div class="panel">
            <div class="eyebrow"><span>Notes</span></div>
            {r.warnings.map((w) => <div class="warn">{w}</div>)}
          </div>
        )}
      </aside>

      <div class="main">
        <MapView
          result={r}
          selected={p.selected}
          onSelect={p.onSelect}
          snapshotRef={p.snapshotRef}
          emptyTitle={busy ? 'Analyzing…' : `Drop the ${label} plan to start`}
          emptyText={busy ? s.msg : 'Subcatchments, Tc paths, design points and peak flows are generated automatically from the surface and drainage features in your drawing.'}
        />
        {p.snapshot && <img class="print-only" src={p.snapshot} style="width:100%" alt="Subcatchment map" />}

        {r && (
          <div class="panel results">
            <div class="rhead">
              <h2>{c === 'pre' ? 'Existing' : 'Proposed'} drainage summary</h2>
              <div class="actions no-print">
                <button class="btn primary" onClick={p.onDxf}>Export DXF</button>
                <button class="btn" onClick={p.onCsv}>CSV</button>
                <button class="btn" onClick={p.onPrint}>Print report</button>
              </div>
            </div>
            <div class="eyebrow"><span>Design points</span><span>{r.settings.distribution === 'III' ? 'Type III' : 'Type II'} 24-hr</span></div>
            <DPTable r={r} />
            <div class="eyebrow" style="margin-top:18px"><span>Subcatchments · peak flow (cfs)</span><span>Click a row or the map</span></div>
            <SubTable r={r} selected={p.selected} onSelect={(id) => p.onSelect(id)} />
            {selSub && <SubDetail r={r} s={selSub} />}
            {!selSub && r.subs[0] && <SubDetail r={r} s={r.subs[0]} />}
            <BasinCards r={r} />
          </div>
        )}
      </div>
    </div>
  )
}

function SettingsDrawer({ s, units, onChange, onClose }: { s: Settings; units: { unit: string; areaAc: number }[]; onChange: (s: Settings) => void; onClose: () => void }) {
  const [d, setD] = useState<Settings>(s)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setD({ ...d, [k]: v })
  const num = (v: string, fb: number) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : fb)
  return (
    <>
      <div class="drawer-bg" onClick={onClose} />
      <div class="drawer" role="dialog" aria-label="Settings">
        <h2>Storms &amp; settings</h2>
        <div class="note" style="margin-bottom:14px">Enter 24-hour rainfall depths for your site (NOAA Atlas 14 or NRCC). Defaults are placeholders.</div>
        <div class="eyebrow"><span>24-hr rainfall (in)</span></div>
        <div class="storms">
          {d.storms.map((st, i) => (
            <>
              <input value={st.label} onInput={(e) => { const a = [...d.storms]; a[i] = { ...st, label: (e.target as HTMLInputElement).value }; set('storms', a) }} />
              <input type="number" step="0.1" value={st.P} onInput={(e) => { const a = [...d.storms]; a[i] = { ...st, P: num((e.target as HTMLInputElement).value, st.P) }; set('storms', a) }} />
              <button class="btn sm ghost" onClick={() => set('storms', d.storms.filter((_, j) => j !== i))} disabled={d.storms.length < 2}>×</button>
            </>
          ))}
        </div>
        <button class="btn sm" style="margin-top:8px" onClick={() => set('storms', [...d.storms, { label: 'New', P: 4 }])}>Add storm</button>

        <div class="eyebrow" style="margin-top:22px"><span>Method</span></div>
        <div class="field"><span>Rainfall distribution</span>
          <select value={d.distribution} onChange={(e) => set('distribution', (e.target as HTMLSelectElement).value as 'II' | 'III')}>
            <option value="III">NRCS Type III</option>
            <option value="II">NRCS Type II</option>
          </select>
        </div>
        <div class="field"><span>Default HSG (no soils layer)</span>
          <select value={d.defaultHSG} onChange={(e) => set('defaultHSG', (e.target as HTMLSelectElement).value as Settings['defaultHSG'])}>
            {['A', 'B', 'C', 'D'].map((h) => <option>{h}</option>)}
          </select>
        </div>
        <div class="field"><span>Area with no cover linework</span>
          <select value={d.defaultCover} onChange={(e) => set('defaultCover', (e.target as HTMLSelectElement).value as Settings['defaultCover'])}>
            {COVER_KEYS.filter((k) => !COVERS[k].imperv).map((k) => <option value={k}>{COVERS[k].desc}</option>)}
          </select>
        </div>
        <div class="field"><span>Max sheet flow length (ft)</span><input type="number" value={d.sheetMax} onInput={(e) => set('sheetMax', num((e.target as HTMLInputElement).value, 100))} /></div>
        <div class="field"><span>Minimum Tc (min)</span><input type="number" step="0.5" value={d.minTcMin} onInput={(e) => set('minTcMin', num((e.target as HTMLInputElement).value, 6))} /></div>
        <div class="field"><span>New design point at (% of site)</span><input type="number" step="1" value={d.minDPPercent} onInput={(e) => set('minDPPercent', num((e.target as HTMLInputElement).value, 5))} /></div>
        <div class="field"><span>Roads act as drainage divides</span>
          <select value={d.roadDivides === false ? 'no' : 'yes'} onChange={(e) => set('roadDivides', (e.target as HTMLSelectElement).value === 'yes')}>
            <option value="yes">Yes</option><option value="no">No</option>
          </select>
        </div>
        <div class="field"><span>Group inlets by outfall</span>
          <select value={d.groupInlets === false ? 'no' : 'yes'} onChange={(e) => set('groupInlets', (e.target as HTMLSelectElement).value === 'yes')}>
            <option value="yes">One subcatchment per outfall</option><option value="no">One per inlet</option>
          </select>
        </div>
        {(() => {
          const seen = new Map<string, number>()
          for (const u of units) seen.set(u.unit, (seen.get(u.unit) ?? 0) + u.areaAc)
          for (const k of Object.keys(d.soilMap ?? {})) if (!seen.has(k)) seen.set(k, 0)
          if (!seen.size) return null
          return (
            <>
              <div class="eyebrow" style="margin-top:22px"><span>Soil map units → HSG</span></div>
              <div class="note" style="margin-bottom:6px">Soil labels on the plan that aren't an HSG letter. Set the group from the soil survey.</div>
              {[...seen.entries()].map(([u, ac]) => (
                <div class="field"><span class="mono">{u}{ac ? ` · ${ac.toFixed(2)} ac` : ''}</span>
                  <select value={d.soilMap?.[u] ?? ''} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; const m = { ...(d.soilMap ?? {}) }; if (v) m[u] = v as 'A'; else delete m[u]; set('soilMap', m) }}>
                    <option value="">Default ({d.defaultHSG})</option>
                    {['A', 'B', 'C', 'D'].map((h) => <option value={h}>HSG {h}</option>)}
                  </select>
                </div>
              ))}
            </>
          )
        })()}
        <div class="field"><span>Resolution</span>
          <select value={String(d.targetCells)} onChange={(e) => set('targetCells', +(e.target as HTMLSelectElement).value)}>
            <option value="90000">Fast</option>
            <option value="220000">Standard</option>
            <option value="600000">Fine</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;margin-top:22px">
          <button class="btn primary" onClick={() => { onChange(d); onClose() }}>Apply &amp; re-run</button>
          <button class="btn ghost" onClick={() => setD(DEFAULT_SETTINGS)}>Defaults</button>
          <button class="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </>
  )
}
