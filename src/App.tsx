import { useMemo, useState } from 'react';
import { useEffect } from 'react';
import { LineageGraph } from './components/LineageGraph';
import type { GraphData } from './types/graph';
import { parsePlainJsonGraph } from './utils/plainJsonGraph';

export default function App() {
  const [dimensions, setDimensions] = useState({ width: 5600, height: 3280 });
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    function handleResize() {
      const pad = 20;
      const w = Math.max(1400, window.innerWidth - pad * 2);
      const h = Math.max(820, window.innerHeight - 220);
      setDimensions({ width: w, height: h });
    }
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const stats = useMemo(
    () => `${graphData.nodes.length.toLocaleString()} nodes / ${graphData.links.length.toLocaleString()} links`,
    [graphData]
  );

  return (
    <main className="app-root">
      <header className="app-header">
        <h1>Lineage Semantic Explorer</h1>
        <p>Load a plain JSON graph file with shape {`{ nodes: [], edges: [] }`}.</p>
        <div className="dataset-controls">
          <label>
            Load graph JSON:
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) {
                  return;
                }
                try {
                  const parsed = parsePlainJsonGraph(await file.text());
                  setGraphData(parsed);
                  setFileName(file.name);
                  setParseError(null);
                } catch (error) {
                  const message = error instanceof Error ? error.message : 'Failed to parse graph JSON.';
                  setParseError(message);
                  console.error('Failed to parse uploaded graph JSON', error);
                }
              }}
            />
          </label>
          <span className="dataset-stats">{stats}</span>
          {fileName ? <span className="dataset-stats">file: {fileName}</span> : null}
          {parseError ? <span className="dataset-stats">error: {parseError}</span> : null}
        </div>
      </header>

      <LineageGraph data={graphData} width={dimensions.width} height={dimensions.height} />
    </main>
  );
}
