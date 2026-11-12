# Drainage Analyst — Apollo Development

Automated pre/post drainage analysis that runs entirely in the browser. Drop an existing-conditions
plan and a proposed-conditions plan (ASCII DXF, or a LandXML TIN plus a DXF) and it produces:

- Subcatchments delineated from the surface (D8 flow on a depression-conditioned grid)
- Design points found automatically where flow leaves the site; the same points are reused for post
- Tc paths traced along the longest travel-time route: sheet flow, then shallow concentrated flow at a speed set by the surface (faster on pavement, slower on grass and woods)
- Weighted curve numbers from land-cover and soil polygons (TR-55 Tables 2-2a/2-2c)
- NRCS Type III (or II) 24-hr hydrographs using the NRCS dimensionless unit hydrograph
- Pipe networks, culverts and catch basins: each inlet gets its own subcatchment, routed through its pipe to the outfall
- Detention basins: stage–storage taken from the proposed surface, level-pool routing, and an automatically sized
  low orifice + weir to hold post peaks at or below existing
- Pre vs. post comparison with suggested fixes (bypass area, drainage-area shifts, storage needed, treatment volume)
- DXF export of subcatchment boundaries, Tc lines, labels and design points back into CAD, plus CSV and a printable report

## Drawing conventions (auto-detected, overridable in the app)

| Role | Layer names that are recognized |
| --- | --- |
| Surface | `CONT`, `TOPO`, `SURF`, `TIN`, `EG`, `FG`, `GRADE`, spot elevations; any layer whose objects carry elevations; 3DFACE TINs |
| Existing vs proposed | `EX`/`EXIST` vs `PR`/`PROP` tokens. In the proposed file, existing contours fill in outside the graded area and existing cover still counts; `DEMO`/`REMOVE` layers are ignored |
| Cover | `BLDG`/`ROOF`, `PAVE`/`ASPH`/`CONC`/`DRIVE`/`PARK`, `GRAVEL`, `LAWN`/`GRASS`/`LOAM`, `MEADOW`/`BRUSH`, `WOOD`/`TREE`, `WATER`/`POND`, `WETLAND` |
| Soils | `SOIL`/`HSG` boundary lines with a text label like `HSG C` in each soil area |
| Storm drainage | `STORM`/`STRM`/`SD`/`PIPE`/`CULV`/`CB`/`INLET` — blocks or circles are structures, lines are pipes. `FES`/`HW` = end sections, `MH`/`DMH` = junctions, `OCS` = basin outlet |
| Basin | `DETENTION`, `BASIN`, `INFILTRATION`, `BIORETENTION`, `BMP` (outline at the basin rim) |
| Design point | `DP`, `POA`, `DESIGN POINT` (optional — found automatically otherwise) |
| Study area | `WATERSHED`, `STUDY AREA`, `DRAINAGE AREA` (optional outline that clips the analysis) |

Linework does not need to be closed. Nearly-closed polylines are closed automatically; open lines, exploded
LINEs and pieces drawn in segments are treated as boundaries and the enclosed areas become shapes. Where a line
runs off the drawing (a tree line, a soil boundary), the side carrying a label (`WOODED`, `HSG C`, …) or the
layer's symbols is used. Every shape the analysis used comes back as a closed polyline in the DXF export
(`APL-EX-COVER-*`, `APL-EX-SOILS-HSG-*`, basins, subcatchments).

Impervious area comes only from roof and pavement linework present in the drawing; anything without cover
linework is pervious (woods by default, changeable in settings). Each subcatchment's CN is the area-weighted
CN of the cover and soil linework inside it. In the proposed condition, undrawn areas keep the existing
pervious cover and soils.

Tc is computed for every subcatchment along its longest travel-time path: TR-55 sheet flow for the first
100 ft (Manning's n of the surface it crosses), then shallow concentrated flow with a velocity factor for the
surface underneath (V = Kv·√s: paved 20.3, gravel 16.1, grass/meadow 7.0, woods 5.0), split wherever the surface changes.

## One drop

Drop every file for a project anywhere on the page (existing plan, proposed plan, LiDAR / TIN — any mix of DXF and
LandXML). Files are sorted into existing and proposed by name and by what their layers hold; a single drawing that
carries both existing and proposed layers is used for both conditions. Existing runs, then proposed, then the
comparison opens. Dropping a file on a step overrides the sort.

- The proposed condition is always analyzed over exactly the same area as existing, so the two are comparable.
- Large blocks (bound xrefs, grouped site linework, "Export to AutoCAD" surfaces) are read through to their contents.
- Unlabeled tree lines: woods is assumed on the side away from buildings and pavement.
- HydroCAD (`HC_*`) and this app's own `APL-*` layers are treated as outputs and never fed back in.
- "Export pre + post DXF" on the compare tab writes both conditions to one drawing.

## Site mode and engineering conventions

When the plan has a limit of disturbance (`LOD`, `LIMIT OF WORK`, `AREA-DISTURBED`) and/or a property line, and no
explicit study area, the analysis follows flow from the work area downstream to where it leaves the property.
Design points go there, and each subcatchment is the full watershed to its design point. The LOD on the proposed
plan is also used for the existing run. Large GIS / LiDAR surfaces get a second, fine-resolution pass over just
that area.

Calibrated against two completed SFC projects (669110 Thomas Point, 665530):
- Road, drive and trail edges act as drainage divides; outside the work area they bound the analysis (no run-on
  from beyond a road). Toggle under settings.
- Inlets discharging to the same basin or design point share one subcatchment (toggle).
- HATCH fills and MULTILEADER labels are read (dxf-parser drops them); unlabeled contours take the elevation of the
  nearest contour label.
- Roads drawn as two edge lines are detected as strips (≤ 45 ft between edges) even where the lines break at
  intersections; large areas merely ringed by a loop road are not paved.
- Utility pipes (water, gas, sewer, electric), setback/buffer lines, symbols and annotation are excluded; drainage
  symbols are classified by block name (CB / BASIN → inlet, MH → junction, HW / FES → end section).
- Soil map-unit symbols (e.g. `238BH`) are listed in settings so each can be assigned an HSG.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run samples    # regenerate public/samples/*.dxf
```

Pushing to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`).

## Embedding

Embed the Pages URL in an iframe (see `framer/DrainageAnalyst.tsx`). Query params: `?theme=dark|light`.
The app posts `{ type: 'apollo-drainage:height', height }` to the parent so the frame can size itself.

## Limits

Preliminary analysis. Peak flows at design points are summed hydrographs (no reach routing between nodes);
inlet capacity and pipe hydraulics are not modeled; inlets are assumed to sit at low points. Verify in
HydroCAD or your routing model before submittal.
