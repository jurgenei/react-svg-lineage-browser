# Lineage Exploring UI

Interactive semantic lineage graph explorer built with React, TypeScript, Vite, and D3 force layout.

## Layout Strategy

The UI employs a **component-aware spatial arrangement**:

```
┌──────────────────────────────────────────────────────┐
│ Small Components                  Main Graph (Force)  │
│ (sorted by size,                  (largest component) │
│  stacked & grouped)                                   │
│                                                       │
│ [1]  [2]  [3]     ← Smallest first                   │
│ [4]  [5]  [6]     ← Growing down, wrap to new col    │
│                    [Largest - full force layout]     │
│                    [across 60% of canvas]            │
└──────────────────────────────────────────────────────┘
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
9. Milestone 2: load real `buss.preprocessor` graph JSON and add large-graph rendering controls.

## Project Structure

- `src/components/LineageGraph.tsx`: graph UI, interactions, clustering UX
- `src/hooks/useForceLayout.ts`: D3 simulation and directional force logic
- `src/utils/graph.ts`: visible graph projection and neighborhood helpers
- `src/types/graph.ts`: data model types
- `src/data/sample-lineage.json`: starter graph data
- `src/data/buss-preprocessor.graph.json`: real graph dataset generated from `buss.preprocessor.xml`
- `scripts/check-data.mjs`: quick JSON integrity check
- `scripts/generate_buss_graph.py`: regenerate real dataset from source XML

## Run

```zsh
cd /Users/cs79en/Developer/Projects/lineage/projects/exploring
npm install
npm run gen:buss
npm run check:data
npm run dev
```

Open the URL printed by Vite (typically `http://localhost:5173`).

## Build

```zsh
cd /Users/cs79en/Developer/Projects/lineage/projects/exploring
npm run build
npm run preview
```

## Notes for Next Increment

- Add viewport-aware edge labels.
- Add WebWorker/off-main-thread simulation option.
- Persist cluster expand/collapse and camera state per session.
- Add query-driven filtering (type, group, directionality, relationship type).

