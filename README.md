# Lineage Exploring UI

Interactive semantic lineage graph explorer built with React, TypeScript, Vite, and D3 force layout.

## Layout Strategy

The UI employs a **component-aware spatial arrangement**:

```
┌───────────────────────────────────────────────────────┐
│ Small Components                  Main Graph (Force)  │
│ (sorted by size,                  (largest component) │
│  stacked & grouped)                                   │
│                                                       │
│ [1]  [2]  [3]     ← Smallest first                    │
│ [4]  [5]  [6]     ← Growing down, wrap to new col     │
│                    [Largest - full force layout]      │
│                    [across 60% of canvas]             │
└───────────────────────────────────────────────────────┘
```

All nodes have a `connected_component_id` (from `02_seed_components.py`):
- **Identifies disconnected subgraphs** within a single dataset
- **Enables spatial separation** — no overlap between unrelated graphs
- Single-node graphs (sources/sinks with no connections) are their own component



## Milestones Implemented

1. Bootstrap React + TypeScript + Vite app.
2. Add graph types and JSON data-loading model.
3. Integrate D3 force simulation as a React hook.
4. Render SVG bezier edges + rich HTML node cards.
5. Apply directional left-to-right force behavior.
6. Add group clustering with expand/collapse.
7. Add pan/zoom, hover highlight, selection, and focus mode.
8. Add a tiny data-validation harness for graph JSON.

## Project Structure

- `src/components/LineageGraph.tsx`: graph UI, interactions, clustering UX
- `src/hooks/useForceLayout.ts`: D3 simulation and directional force logic
- `src/utils/graph.ts`: visible graph projection and neighborhood helpers
- `src/types/graph.ts`: data model types

## Run

```zsh
npm install
npm run dev
```

Open the URL printed by Vite (typically `http://localhost:5173`).

## Layout Engine (Large Graphs)

The header now includes a **Layout** selector:

- `auto`: prefers WebGPU for larger graphs, falls back to CPU if unavailable
- `webgpu`: forces GPU attempt first, with CPU fallback if browser/device support is missing
- `cpu`: always uses classic d3-force on CPU

For best results with very large node counts, use a Chromium browser with WebGPU enabled.

## Local Detail Layout

In local context (double-click a node), the toolbar includes a **Detail layout** selector:

- `Force graph`: keeps the current force simulation layout
- `Sugiyama graph`: centers the selected node, places local inputs on the left, local outputs on the right,
  and places `inout` nodes top first then bottom with a max-rows-per-column grid

Notes:

- Sugiyama applies only in local detail context
- If no node is selected, rendering falls back to force placement
- Manual drag positions are preserved in both modes
- Edge color classes remain shared across modes (`edge-flow-outgoing`, `edge-flow-incoming`, `edge-flow-bidirectional`)

### Local WebGPU Fork

`d3-force-webgpu` is pinned to a vendored fork at `vendor/d3-force-webgpu` via `file:` dependency.

- GPU stability fixes live in `vendor/d3-force-webgpu/src/gpu/shaders.js`
- Simulation readback guards live in `vendor/d3-force-webgpu/src/gpu/simulation-gpu.js`
- After editing the fork, run `npm install` to refresh the linked package in `node_modules`

## Build

```zsh
npm run build
npm run preview
```

## Notes for Next Increment

- Add viewport-aware edge labels.
- Add WebWorker/off-main-thread simulation option.
- Persist cluster expand/collapse and camera state per session.
- Add query-driven filtering (type, group, directionality, relationship type).

