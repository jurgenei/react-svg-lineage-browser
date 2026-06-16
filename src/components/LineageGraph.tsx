import { useEffect, useMemo, useRef, useState } from 'react';
import { select, zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from 'd3';
import type { GraphData, SimLink, SimNode } from '../types/graph';
import { useForceLayout } from '../hooks/useForceLayout';
import { buildVisibleGraph } from '../utils/graph';

interface LineageGraphProps {
  data: GraphData;
  width?: number;
  height?: number;
}

export function LineageGraph({ data, width = 1400, height = 820 }: LineageGraphProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(defaultCollapsedGroups(data)));
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [edgeMode, setEdgeMode] = useState<'none' | 'soft' | 'grouped'>('soft');
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);
  const [searchTerm, setSearchTerm] = useState('');
  const [tableMatches, setTableMatches] = useState<string[]>([]);
  const [tableMatchIndex, setTableMatchIndex] = useState(-1);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [manualPositions, setManualPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const dragStateRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  const groupOrder = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const node of data.nodes) {
      if (!seen.has(node.group)) {
        seen.add(node.group);
        order.push(node.group);
      }
    }
    return order;
  }, [data.nodes]);

  const visibleGraph = useMemo(() => buildVisibleGraph(data, collapsedGroups), [data, collapsedGroups]);
  const { nodes, links } = useForceLayout(visibleGraph.nodes, visibleGraph.links, width, height, groupOrder);

  const nodesWithStacks = useMemo(() => placeUnconnectedNodes(nodes, links, width, height), [nodes, links, width, height]);

  const nodesWithManualPositions = useMemo(() => {
    if (manualPositions.size === 0) {
      return nodesWithStacks;
    }
    return nodesWithStacks.map((node) => {
      const fixed = manualPositions.get(node.id);
      return fixed ? { ...node, x: fixed.x, y: fixed.y } : node;
    });
  }, [nodesWithStacks, manualPositions]);

  const nodeMap = useMemo(() => {
    const map = new Map<string, SimNode>();
    for (const node of nodesWithManualPositions) {
      map.set(node.id, node);
    }
    return map;
  }, [nodesWithManualPositions]);

  const groupCenter = useMemo(() => {
    const accum = new Map<string, { x: number; y: number; count: number }>();
    for (const node of nodesWithManualPositions) {
      const current = accum.get(node.group) ?? { x: 0, y: 0, count: 0 };
      current.x += node.x;
      current.y += node.y;
      current.count += 1;
      accum.set(node.group, current);
    }
    const centers = new Map<string, { x: number; y: number }>();
    for (const [group, value] of accum.entries()) {
      centers.set(group, { x: value.x / value.count, y: value.y / value.count });
    }
    return centers;
  }, [nodesWithManualPositions]);

  const worldBounds = useMemo(() => {
    const padding = 180;
    const minX = (-transform.x / transform.k) - padding;
    const minY = (-transform.y / transform.k) - padding;
    const maxX = ((width - transform.x) / transform.k) + padding;
    const maxY = ((height - transform.y) / transform.k) + padding;
    return { minX, minY, maxX, maxY };
  }, [transform, width, height]);

  const cullingEnabled = nodesWithManualPositions.length > 280;
  const visibleNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const node of nodesWithManualPositions) {
      const inside =
        node.x >= worldBounds.minX &&
        node.x <= worldBounds.maxX &&
        node.y >= worldBounds.minY &&
        node.y <= worldBounds.maxY;
      if (!cullingEnabled || inside) {
        ids.add(node.id);
      }
    }
    return ids;
  }, [nodesWithManualPositions, worldBounds, cullingEnabled]);

  const renderNodes = useMemo(
    () => (cullingEnabled ? nodesWithManualPositions.filter((n) => visibleNodeIds.has(n.id)) : nodesWithManualPositions),
    [nodesWithManualPositions, cullingEnabled, visibleNodeIds]
  );

  const renderLinks = useMemo(() => {
    if (!cullingEnabled) {
      return links;
    }
    return links.filter((link) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      return visibleNodeIds.has(sourceId) && visibleNodeIds.has(targetId);
    });
  }, [links, cullingEnabled, visibleNodeIds]);

  const linkParallelInfo = useMemo(() => {
    const grouped = new Map<string, SimLink[]>();
    for (const link of renderLinks) {
      const src = typeof link.source === 'string' ? link.source : link.source.id;
      const dst = typeof link.target === 'string' ? link.target : link.target.id;
      const key = `${src}|${dst}`;
      const arr = grouped.get(key) ?? [];
      arr.push(link);
      grouped.set(key, arr);
    }

    const info = new Map<string, { index: number; total: number }>();
    for (const [key, arr] of grouped.entries()) {
      arr.forEach((link, index) => {
        const id = link.edgeKey ?? `${key}|${index}`;
        info.set(id, { index, total: arr.length });
      });
    }
    return info;
  }, [renderLinks]);

  const pivotNodeId = selectedNodeId ?? hoveredNodeId;

  const highlightState = useMemo(() => {
    if (!focusMode || !pivotNodeId) {
      return null;
    }
    const related = new Set<string>([pivotNodeId]);
    const directLinks = new Set<string>();
    for (const link of links) {
      const src = typeof link.source === 'string' ? link.source : link.source.id;
      const dst = typeof link.target === 'string' ? link.target : link.target.id;
      if (src === pivotNodeId || dst === pivotNodeId) {
        related.add(src);
        related.add(dst);
        directLinks.add(`${src}->${dst}`);
      }
    }
    return { related, directLinks };
  }, [focusMode, pivotNodeId, links]);

  const dimSet = useMemo(() => {
    const pivot = selectedNodeId ?? hoveredNodeId;
    if (!focusMode || !pivot) {
      return null;
    }
    return highlightState?.related ?? null;
  }, [focusMode, selectedNodeId, hoveredNodeId, highlightState]);

  useEffect(() => {
    if (!svgRef.current) {
      return;
    }
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => setTransform(event.transform));
    zoomBehaviorRef.current = zoomBehavior;
    select(svgRef.current).call(zoomBehavior as never);
  }, []);

  useEffect(() => {
    const validNodeIds = new Set(visibleGraph.nodes.map((n) => n.id));
    setManualPositions((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      let changed = false;
      const next = new Map<string, { x: number; y: number }>();
      for (const [id, value] of prev.entries()) {
        if (validNodeIds.has(id)) {
          next.set(id, value);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [visibleGraph.nodes]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const state = dragStateRef.current;
      if (!state || !stageRef.current) {
        return;
      }
      const rect = stageRef.current.getBoundingClientRect();
      const worldX = (event.clientX - rect.left - transform.x) / transform.k;
      const worldY = (event.clientY - rect.top - transform.y) / transform.k;
      setManualPositions((prev) => {
        const next = new Map(prev);
        next.set(state.id, {
          x: worldX - state.offsetX,
          y: worldY - state.offsetY
        });
        return next;
      });
    }

    function handlePointerUp() {
      if (dragStateRef.current) {
        dragStateRef.current = null;
        setDraggingNodeId(null);
      }
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [transform]);

  useEffect(() => {
    if (!pendingFocusId) {
      return;
    }
    const node = nodeMap.get(pendingFocusId);
    if (!node) {
      return;
    }
    panToNode(node, transform.k);
    setSelectedNodeId(node.id);
    setPendingFocusId(null);
  }, [pendingFocusId, nodeMap, transform.k]);

  const searchResultsText = tableMatches.length
    ? `match ${tableMatchIndex + 1}/${tableMatches.length}`
    : searchTerm.trim().length
      ? 'no table matches'
      : '';

  function runSearch(resetToFirst: boolean) {
    const q = searchTerm.trim().toLowerCase();
    if (!q) {
      setTableMatches([]);
      setTableMatchIndex(-1);
      return;
    }

    const matches = data.nodes
      .filter((n) => n.type === 'table' && n.label.toLowerCase().includes(q))
      .map((n) => n.id);

    if (!matches.length) {
      setTableMatches([]);
      setTableMatchIndex(-1);
      return;
    }

    setTableMatches(matches);
    const nextIndex = resetToFirst ? 0 : Math.min(Math.max(tableMatchIndex, 0), matches.length - 1);
    setTableMatchIndex(nextIndex);
    focusMatch(matches[nextIndex]);
  }

  function cycleSearch(delta: number) {
    if (!tableMatches.length) {
      return;
    }
    const nextIndex = (tableMatchIndex + delta + tableMatches.length) % tableMatches.length;
    setTableMatchIndex(nextIndex);
    focusMatch(tableMatches[nextIndex]);
  }

  function focusMatch(nodeId: string) {
    const rawNode = data.nodes.find((n) => n.id === nodeId);
    if (rawNode && collapsedGroups.has(rawNode.group)) {
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        next.delete(rawNode.group);
        return next;
      });
    }
    setPendingFocusId(nodeId);
  }

  function panToNode(node: SimNode, zoomScale: number) {
    if (!svgRef.current || !zoomBehaviorRef.current) {
      return;
    }
    const nodeX = node.x + 85;
    const nodeY = node.y + 24;
    const tx = width / 2 - (nodeX * zoomScale);
    const ty = height / 2 - (nodeY * zoomScale);
    const targetTransform = zoomIdentity.translate(tx, ty).scale(zoomScale);

    select(svgRef.current)
      .transition()
      .duration(280)
      .call(zoomBehaviorRef.current.transform as never, targetTransform);
  }

  return (
    <div className="graph-shell">
      <div className="toolbar">
        <button onClick={() => setCollapsedGroups(new Set(groupOrder))}>Collapse all groups</button>
        <button onClick={() => setCollapsedGroups(new Set())}>Expand all groups</button>
        <button onClick={() => setFocusMode((v) => !v)}>{focusMode ? 'Disable focus mode' : 'Enable focus mode'}</button>
        <button
          onClick={() => {
            if (!svgRef.current || !zoomBehaviorRef.current) {
              return;
            }
            select(svgRef.current)
              .transition()
              .duration(240)
              .call(zoomBehaviorRef.current.transform as never, zoomIdentity);
          }}
        >
          Reset zoom
        </button>
        <label>
          Table search:
          <input
            value={searchTerm}
            placeholder="table name..."
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runSearch(true);
                return;
              }
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                  cycleSearch(e.key === 'ArrowRight' ? 1 : -1);
              }
            }}
          />
        </label>
        <span className="search-stats">{searchResultsText}</span>
        <label>
          Edge mode:
          <select value={edgeMode} onChange={(e) => setEdgeMode(e.target.value as 'none' | 'soft' | 'grouped')}>
            <option value="none">none</option>
            <option value="soft">soft bundle</option>
            <option value="grouped">grouped bundle</option>
          </select>
        </label>
        <span className="render-stats">
          render {renderNodes.length}/{nodes.length} nodes, {renderLinks.length}/{links.length} links
        </span>
        {selectedNodeId ? <span className="selected-label">Selected: {selectedNodeId}</span> : null}
      </div>

      <div ref={stageRef} className="graph-stage" style={{ width, height }}>
        <svg ref={svgRef} width={width} height={height} className="edge-layer">
          <defs>
            <marker id="arrow-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="3.5" markerHeight="3.5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          <g transform={transform.toString()}>
            {renderLinks.map((link, idx) => {
              const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
              const targetId = typeof link.target === 'string' ? link.target : link.target.id;
              const source = nodeMap.get(sourceId);
              const target = nodeMap.get(targetId);
              if (!source || !target) {
                return null;
              }
              const faded = dimSet ? !(dimSet.has(source.id) && dimSet.has(target.id)) : false;
              const sx = source.x + 90;
              const sy = source.y + 24;
              const tx = target.x;
              const ty = target.y + 24;
              const isDirect =
                highlightState?.directLinks.has(`${source.id}->${target.id}`) ||
                highlightState?.directLinks.has(`${target.id}->${source.id}`);
              const parallel = linkParallelInfo.get(link.edgeKey ?? `${source.id}|${target.id}|${idx}`) ?? { index: 0, total: 1 };
              const strokeWidth = Math.min(8, 1.5 + Math.log2((link.weight ?? 1) + 1) * 1.7);
              
              // Determine directionality class
              let dirClass = '';
              if (pivotNodeId && isDirect) {
                if (source.id === pivotNodeId) {
                  dirClass = 'edge-flow-outgoing';
                } else if (target.id === pivotNodeId) {
                  dirClass = 'edge-flow-incoming';
                }
              }
              
               const edgeKey = link.edgeKey ?? `${source.id}|${target.id}|${idx}`;
               // Always show labels for edges connected to selected node (incoming/outgoing)
               const isConnectedToSelected = dirClass === 'edge-flow-outgoing' || dirClass === 'edge-flow-incoming';
               const showLabel = isConnectedToSelected;
               const labelX = (sx + tx) / 2;
               const labelY = (sy + ty) / 2;
               const labelWidth = link.label ? Math.max(link.label.length * 6.2 + 12, 36) : 36;

               return (
                <g key={`${source.id}:${target.id}:${idx}`}>
                  <path
                    d={edgePath(source, target, edgeMode, groupCenter, parallel.index, parallel.total)}
                    className={`edge edge-${link.type.toLowerCase()} ${dirClass} ${faded ? 'edge-dim' : ''} ${isDirect ? 'edge-direct' : ''}`}
                    style={{ strokeWidth }}
                    markerEnd="url(#arrow-end)"
                    onMouseEnter={() => setHoveredEdgeKey(edgeKey)}
                    onMouseLeave={() => setHoveredEdgeKey(null)}
                  >
                    <title>{`${link.label ?? link.type} (${link.weight ?? 1})`}</title>
                  </path>
                   {showLabel && link.label && (
                     <g className="edge-label-group">
                       <rect
                         x={labelX - labelWidth / 2}
                         y={labelY - 8}
                         width={labelWidth}
                         height={16}
                         rx="4"
                         ry="4"
                         className={`edge-label-bg edge-${link.type.toLowerCase()} ${dirClass}`}
                       />
                       <text
                         x={labelX}
                         y={labelY}
                         textAnchor="middle"
                         dominantBaseline="middle"
                         className="edge-label"
                       >
                         {link.label}
                       </text>
                     </g>
                   )}
                </g>
              );
            })}
          </g>
        </svg>

        <div className="node-layer" style={{ transform: cssZoomTransform(transform) }}>
          {renderNodes.map((node) => {
            const faded = dimSet ? !dimSet.has(node.id) : false;
            const isPivot = pivotNodeId === node.id;
            const isNeighbor = Boolean(dimSet?.has(node.id) && !isPivot);
            return (
              <button
                type="button"
                key={node.id}
                className={`node-card ${node.type} ${faded ? 'node-dim' : ''} ${selectedNodeId === node.id ? 'node-selected' : ''} ${isPivot ? 'node-pivot' : ''} ${isNeighbor ? 'node-neighbor' : ''} ${draggingNodeId === node.id ? 'node-dragging' : ''}`}
                style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
                onPointerDown={(event) => {
                  if (node.type !== 'table' || !stageRef.current) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  const rect = stageRef.current.getBoundingClientRect();
                  const worldX = (event.clientX - rect.left - transform.x) / transform.k;
                  const worldY = (event.clientY - rect.top - transform.y) / transform.k;
                  dragStateRef.current = {
                    id: node.id,
                    offsetX: worldX - node.x,
                    offsetY: worldY - node.y
                  };
                  setDraggingNodeId(node.id);
                }}
                onMouseEnter={() => setHoveredNodeId(node.id)}
                onMouseLeave={() => setHoveredNodeId((id) => (id === node.id ? null : id))}
                onClick={() => {
                  if (node.isCluster) {
                    setCollapsedGroups((prev) => {
                      const next = new Set(prev);
                      if (next.has(node.group)) {
                        next.delete(node.group);
                      } else {
                        next.add(node.group);
                      }
                      return next;
                    });
                    return;
                  }
                  setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
                }}
              >
                <div className="node-title">{node.label}</div>
                {node.childCount ? <div className="node-meta"><span>{node.childCount} nodes</span></div> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function cssZoomTransform(t: ZoomTransform): string {
  // CSS transforms need a CSS-compatible format; d3's toString() is SVG-oriented.
  return `matrix(${t.k}, 0, 0, ${t.k}, ${t.x}, ${t.y})`;
}

function defaultCollapsedGroups(data: GraphData): string[] {
  void data;
  return [];
}

function edgePath(
  source: SimNode,
  target: SimNode,
  mode: 'none' | 'soft' | 'grouped',
  groupCenter: Map<string, { x: number; y: number }>,
  parallelIndex = 0,
  parallelTotal = 1
): string {
  const sx = source.x + 90;
  const sy = source.y + 24;
  const tx = target.x;
  const ty = target.y + 24;
  const offset = ((parallelIndex - (parallelTotal - 1) / 2) * 14);

  if (mode === 'none') {
    return `M ${sx} ${sy + offset} L ${tx} ${ty + offset}`;
  }

  if (mode === 'grouped') {
    const sourceGroup = groupCenter.get(source.group);
    const targetGroup = groupCenter.get(target.group);
    if (sourceGroup && targetGroup) {
      const c1x = sx + Math.max(36, (sourceGroup.x - sx) * 0.6);
      const c1y = sy + (sourceGroup.y - sy) * 0.6 + offset;
      const c2x = tx + Math.min(-36, (targetGroup.x - tx) * 0.6);
      const c2y = ty + (targetGroup.y - ty) * 0.6 + offset;
      return `M ${sx} ${sy + offset} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty + offset}`;
    }
  }

  const dx = Math.max(40, Math.abs(tx - sx) * 0.45);
  return `M ${sx} ${sy + offset} C ${sx + dx} ${sy + offset}, ${tx - dx} ${ty + offset}, ${tx} ${ty + offset}`;
}

function placeUnconnectedNodes(nodes: SimNode[], links: SimLink[], width: number, height: number): SimNode[] {
  if (!nodes.length) {
    return nodes;
  }

  const degree = new Map<string, number>();
  for (const node of nodes) {
    degree.set(node.id, 0);
  }
  for (const link of links) {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
    degree.set(sourceId, (degree.get(sourceId) ?? 0) + 1);
    degree.set(targetId, (degree.get(targetId) ?? 0) + 1);
  }

  const isolated = nodes
    .filter((node) => !node.isCluster && (degree.get(node.id) ?? 0) === 0)
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label));

  if (!isolated.length) {
    return nodes;
  }

  const stackLeft = 24;
  const stackTop = 24;
  const rowStep = 74;
  const colStep = 220;
  const cardWidth = 190;
  const graphGap = 160;
  const stackBottom = Math.max(stackTop + rowStep, height - 24);

  const positioned = new Map<string, { x: number; y: number }>();
  let col = 0;
  let y = stackTop;

  for (const node of isolated) {
    if (y + rowStep > stackBottom) {
      col += 1;
      y = stackTop;
    }
    positioned.set(node.id, { x: stackLeft + col * colStep, y });
    y += rowStep;
  }

  const rightMostStackX = stackLeft + col * colStep + cardWidth;
  const connectedMinX = nodes
    .filter((node) => !positioned.has(node.id))
    .reduce((min, node) => Math.min(min, node.x), Number.POSITIVE_INFINITY);
  const requiredConnectedMinX = Math.min(width - 200, rightMostStackX + graphGap);
  const shiftX = Number.isFinite(connectedMinX) ? Math.max(0, requiredConnectedMinX - connectedMinX) : 0;

  return nodes.map((node) => {
    const stackPos = positioned.get(node.id);
    if (stackPos) {
      return { ...node, x: stackPos.x, y: stackPos.y };
    }
    if (shiftX > 0) {
      return { ...node, x: node.x + shiftX };
    }
    return node;
  });
}

