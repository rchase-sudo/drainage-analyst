# Drainage Analyst — Apollo Development

Automated pre/post drainage analysis that runs entirely in the browser. Drop an existing-conditions
plan and a proposed-conditions plan (ASCII DXF, or a LandXML TIN plus a DXF) and it produces:

- Subcatchments delineated from the surface (D8 flow on a depression-conditioned grid)
- Design points found automatically where flow leaves the site; the same points are reused for post
- Tc paths traced along the longest travel-time route, split into TR-55 sheet / shallow concentrated / channel segments
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
| Existing vs proposed | `EX`/`EXIST` vs `PR`/`PROP` tokens. In the proposed file, existing contours fill in outside the graded area |
| Cover | `BLDG`/`ROOF`, `PAVE`/`ASPH`/`CONC`/`DRIVE`/`PARK`, `GRAVEL`, `LAWN`/`GRASS`/`LOAM`, `MEADOW`/`BRUSH`, `WOOD`/`TREE`, `WATER`/`POND`, `WETLAND` (closed polylines) |
| Soils | `SOIL`/`HSG` closed polylines with a text label like `HSG C` inside |
| Storm drainage | `STORM`/`STRM`/`SD`/`PIPE`/`CULV`/`CB`/`INLET` — blocks or circles are structures, lines are pipes. `FES`/`HW` = end sections, `MH`/`DMH` = junctions, `OCS` = basin outlet |
| Basin | `DETENTION`, `BASIN`, `INFILTRATION`, `BIORETENTION`, `BMP` (closed polyline at the basin rim) |
| Design point | `DP`, `POA`, `DESIGN POINT` (optional — found automatically otherwise) |
| Study area | `WATERSHED`, `STUDY AREA`, `DRAINAGE AREA` (optional closed polyline that clips the analysis) |

Undrawn proposed cover and soils carry forward from the existing condition.

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
