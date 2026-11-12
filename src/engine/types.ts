import type { Ring, XY } from './geometry'

export type Condition = 'pre' | 'post'

export type CoverKey = 'roof' | 'pavement' | 'gravel' | 'dirt' | 'grass' | 'meadow' | 'woods' | 'water' | 'wetland'

export type Role =
  | 'surface'
  | 'surface-ex' // existing ground used only where the proposed surface has no data (post)
  | 'study'
  | 'site' // limit of disturbance or property line: design points go where flow leaves it
  | 'soils'
  | 'storm'
  | 'designpoint'
  | 'basin'
  | `cover:${CoverKey}`
  | 'reference'
  | 'ignore'

export type V3 = [number, number, number]

export interface Ent {
  kind: 'poly' | 'point' | 'text' | 'insert' | 'circle' | 'face'
  layer: string
  pts: V3[]
  closed?: boolean
  hasZ?: boolean
  text?: string
  name?: string
  r?: number
  /** boundary of a HATCH fill */
  hatch?: boolean
}

export interface LayerInfo {
  name: string
  count: number
  closed: number
  withZ: number
  faces: number
  points: number
  /** polylines / lines, and how many of those carry an elevation */
  polys?: number
  polysZ?: number
  hatches?: number
  role: Role
}

export interface Drawing {
  fileName: string
  source: 'dxf' | 'landxml'
  units: 'ft' | 'm'
  toFt: number
  ents: Ent[]
  layers: LayerInfo[]
  /** LandXML surface, already in feet */
  tin?: { pts: V3[]; tris: [number, number, number][] }
}

export interface Storm { label: string; P: number }

export interface Settings {
  storms: Storm[]
  distribution: 'III' | 'II'
  defaultHSG: 'A' | 'B' | 'C' | 'D'
  defaultCover: CoverKey | 'carry'
  sheetMax: number // ft
  channelAcres: number // contributing area where channel flow starts
  channelN: number
  channelR: number // hydraulic radius ft
  minTcMin: number
  minDPPercent: number // % of study area for a natural outfall to become its own design point
  targetCells: number
  /** one subcatchment per receiving basin / design point for inlets, instead of one per inlet */
  groupInlets?: boolean
  /** road / drive edges act as drainage divides */
  roadDivides?: boolean
  /** the user has entered their own rainfall depths */
  rainfallSet?: boolean
  /** HSG for soil map-unit symbols found on the plan (e.g. "238BH": "C") */
  soilMap?: Record<string, 'A' | 'B' | 'C' | 'D'>
}

export const DEFAULT_SETTINGS: Settings = {
  storms: [
    { label: '2-yr', P: 3.1 },
    { label: '10-yr', P: 4.7 },
    { label: '25-yr', P: 5.9 },
    { label: '50-yr', P: 7.0 },
    { label: '100-yr', P: 8.3 },
  ],
  distribution: 'III',
  defaultHSG: 'C',
  defaultCover: 'woods',
  sheetMax: 100,
  channelAcres: 5,
  channelN: 0.035,
  channelR: 0.5,
  minTcMin: 6,
  minDPPercent: 5,
  targetCells: 220000,
  groupInlets: true,
  roadDivides: true,
}

export interface TcSegment {
  type: 'sheet' | 'shallow' | 'channel'
  surface: string
  L: number // ft
  s: number // ft/ft
  n?: number
  V: number // ft/s
  t: number // min
  path: XY[]
}

export interface CoverRow { cover: CoverKey; hsg: string; areaAc: number; cn: number; desc: string }

export interface StormResult { P: number; Q: number; peak: number; tpeak: number; volAcFt: number }

export interface Subcatchment {
  /** drawn by Claude rather than derived from the surface */
  source?: 'ai'
  note?: string
  id: string
  name: string
  kind: 'dp' | 'inlet' | 'basin'
  to: string // node id it reports to
  toName: string
  areaAc: number
  cn: number
  impervPct: number
  tcMin: number
  tcRaw: number
  segments: TcSegment[]
  rings: { outer: Ring; holes: Ring[] }[]
  label: XY
  covers: CoverRow[]
  storms: StormResult[]
  hydro: Float32Array[]
}

export interface DesignPoint {
  id: string
  name: string
  x: number
  y: number
  forced: boolean
  storms: { peak: number; tpeak: number; volAcFt: number }[]
  hydro: Float32Array[]
  tributaryAc: number
  impervAc: number
}

export interface BasinResult {
  id: string
  name: string
  ring: Ring
  bottom: number
  rim: number
  storage: { z: number; S: number }[] // cf
  maxStorage: number
  outflowTo: string
  piped: boolean
  inflow: { peak: number; volAcFt: number }[]
  outlet?: OutletDesign
}

export interface OutletDesign {
  orificeIn: number
  weirCrest: number | null
  weirLength: number | null
  results: { peakIn: number; peakOut: number; stage: number; storage: number; overtops: boolean }[]
  meetsAll: boolean
}

export interface Structure { x: number; y: number; kind: 'inlet' | 'junction' | 'outfall' | 'ocs'; label: string; to?: string }

export interface AnalysisResult {
  condition: Condition
  fileName: string
  settings: Settings
  grid: { nx: number; ny: number; x0: number; y0: number; cs: number }
  bbox: { x0: number; y0: number; x1: number; y1: number }
  zmin: number
  zmax: number
  studyAc: number
  dt: number // hr
  subs: Subcatchment[]
  dps: DesignPoint[]
  basins: BasinResult[]
  structures: Structure[]
  pipes: XY[][]
  reference: XY[][]
  contours: XY[][]
  shade: Uint8ClampedArray // RGBA nx*ny, row 0 = bottom
  labels: Int32Array // subcatchment index per cell (-1 none)
  coverGrid: Uint8Array // cover index per cell (255 = none)
  hsgGrid: Uint8Array // 0..3, 255 = none
  aiNotes?: string[]
  aiContext?: AiContext
  /** soil map-unit symbols found without an HSG */
  soilUnits?: { unit: string; hsg: string; areaAc: number }[]
  warnings: string[]
  timings: Record<string, number>
}

/* ---------- Claude delineation ---------- */
export interface AiSub {
  name: string
  kind: 'roof' | 'surface'
  ring: XY[]
  /** where this area's runoff goes: the receiving structure or discharge point */
  outlet?: XY | null
  outletName?: string
  /** longest flow path, most remote point first */
  path?: XY[]
  note?: string
}
export interface AiModel { subs: AiSub[]; notes: string[] }

/** Everything Claude is given about a condition, in drawing coordinates (ft). */
export interface AiContext {
  bbox: { x0: number; y0: number; x1: number; y1: number }
  bounds: XY[]
  structures: { kind: string; label: string; x: number; y: number; to?: string }[]
  pipes: XY[][]
  buildings: XY[][]
  basins: { name: string; ring: XY[] }[]
  dps: { name: string; x: number; y: number }[]
  texts: { t: string; x: number; y: number; layer: string }[]
  elev: { x0: number; y0: number; step: number; nx: number; ny: number; z: (number | null)[] }
  engineSubs: { name: string; to: string; areaAc: number; x: number; y: number }[]
}
