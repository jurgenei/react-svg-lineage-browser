import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { select, zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from 'd3';
import type { GraphData, SimLink, SimNode } from '../types/graph';
import { useForceLayout } from '../hooks/useForceLayout';
import { buildVisibleGraph } from '../utils/graph';
import { getCategoryColor } from '../utils/categoryConfig';

interface LineageGraphProps {
  data: GraphData;
  width?: number;
  height?: number;
}

interface EdgeRenderItem {
  key: string;
  edgeKey: string;
  links: SimLink[];
  primaryLink: SimLink;
  source: SimNode;
  target: SimNode;
  labelLines: string[];
  strokeWidth: number;
  edgeTypeClass: string;
  dirClass: string;
  faded: boolean;
  isDirect: boolean;
  showDirectStyling: boolean;
}

interface LineJumpPoint {
  x: number;
  y: number;
}

interface GraphUiPrefs {
  focusMode: boolean;
  showDirectEdges: boolean;
  orthogonalPorts: boolean;
  routingMode: 'smooth' | 'manhattan';
  edgeMode: 'none' | 'soft' | 'grouped';
  showHelpPanel: boolean;
  showLegendPanel: boolean;
  helpPanelPos: { x: number; y: number };
  legendPanelPos: { x: number; y: number };
  cameraTransform: { x: number; y: number; k: number };
  selectedNodeId: string | null;
}

type PanelName = 'help' | 'legend';

interface DragPanelState {
  panel: PanelName;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
}

const GRAPH_UI_PREFS_KEY = 'lineage.exploring.graphUiPrefs.v1';

function readGraphUiPrefs(): Partial<GraphUiPrefs> {
  if (typeof window === 'undefined') {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(GRAPH_UI_PREFS_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Partial<GraphUiPrefs>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readStoredTransform(value: unknown): ZoomTransform {
  if (!value || typeof value !== 'object') {
    return zoomIdentity;
  }
  const maybe = value as { x?: unknown; y?: unknown; k?: unknown };
  const x = typeof maybe.x === 'number' && Number.isFinite(maybe.x) ? maybe.x : 0;
  const y = typeof maybe.y === 'number' && Number.isFinite(maybe.y) ? maybe.y : 0;
  const k = typeof maybe.k === 'number' && Number.isFinite(maybe.k) && maybe.k > 0 ? maybe.k : 1;
  return zoomIdentity.translate(x, y).scale(k);
}

function isIdentityTransform(t: ZoomTransform): boolean {
  return Math.abs(t.x) < 1e-6 && Math.abs(t.y) < 1e-6 && Math.abs(t.k - 1) < 1e-6;
}

export function LineageGraph({ data, width = 1400, height = 820 }: LineageGraphProps) {
  const initialPrefsRef = useRef<Partial<GraphUiPrefs> | null>(null);
  if (initialPrefsRef.current === null) {
    initialPrefsRef.current = readGraphUiPrefs();
  }
  const initialPrefs = initialPrefsRef.current;

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(defaultCollapsedGroups(data)));
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialPrefs.selectedNodeId ?? null);
  const [focusMode, setFocusMode] = useState(initialPrefs.focusMode ?? false);
  const [showDirectEdges, setShowDirectEdges] = useState(initialPrefs.showDirectEdges ?? false);
  const [orthogonalPorts, setOrthogonalPorts] = useState(initialPrefs.orthogonalPorts ?? true);
  const [routingMode, setRoutingMode] = useState<'smooth' | 'manhattan'>(initialPrefs.routingMode ?? 'smooth');
  const [edgeMode, setEdgeMode] = useState<'none' | 'soft' | 'grouped'>(initialPrefs.edgeMode ?? 'soft');
  const [showHelpPanel, setShowHelpPanel] = useState(initialPrefs.showHelpPanel ?? false);
  const [showLegendPanel, setShowLegendPanel] = useState(initialPrefs.showLegendPanel ?? false);
  const [helpPanelPos, setHelpPanelPos] = useState<{ x: number; y: number }>(() => initialPrefs.helpPanelPos ?? { x: Math.max(10, width - 250), y: 10 });
  const [legendPanelPos, setLegendPanelPos] = useState<{ x: number; y: number }>(() => initialPrefs.legendPanelPos ?? { x: 10, y: 10 });
  const [transform, setTransform] = useState<ZoomTransform>(() => readStoredTransform(initialPrefs.cameraTransform));
  const [searchTerm, setSearchTerm] = useState('');
  const [tableMatches, setTableMatches] = useState<string[]>([]);
  const [tableMatchIndex, setTableMatchIndex] = useState(-1);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [manualPositions, setManualPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [nodeSizes, setNodeSizes] = useState<Map<string, { width: number; height: number }>>(new Map());

  const svgRef = useRef<SVGSVGElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const dragStateRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const nodeElementsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const nodeObserversRef = useRef<Map<string, ResizeObserver>>(new Map());
  const nodeRefCallbacksRef = useRef<Map<string, (element: HTMLButtonElement | null) => void>>(new Map());
  const [dragPanelState, setDragPanelState] = useState<DragPanelState | null>(null);

  const registerNodeElement = useCallback((nodeId: string, element: HTMLButtonElement | null) => {
    const currentElement = nodeElementsRef.current.get(nodeId);

    if (!element) {
      const observer = nodeObserversRef.current.get(nodeId);
      if (observer) {
        observer.disconnect();
        nodeObserversRef.current.delete(nodeId);
      }
      nodeElementsRef.current.delete(nodeId);
      return;
    }

    if (currentElement === element) {
      return;
    }

    const previousObserver = nodeObserversRef.current.get(nodeId);
    if (previousObserver) {
      previousObserver.disconnect();
    }

    nodeElementsRef.current.set(nodeId, element);

    const syncNodeSize = (target: HTMLElement) => {
      const nextSize = { width: target.offsetWidth, height: target.offsetHeight };
      setNodeSizes((prev) => {
        const existing = prev.get(nodeId);
        if (existing && existing.width === nextSize.width && existing.height === nextSize.height) {
          return prev;
        }
        const next = new Map(prev);
        next.set(nodeId, nextSize);
        return next;
      });
    };

    syncNodeSize(element);

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        syncNodeSize(entry.target as HTMLElement);
      }
    });
    observer.observe(element);
    nodeObserversRef.current.set(nodeId, observer);
  }, []);

  const getNodeRefCallback = useCallback(
    (nodeId: string) => {
      const existing = nodeRefCallbacksRef.current.get(nodeId);
      if (existing) {
        return existing;
      }
      const callback = (element: HTMLButtonElement | null) => {
        registerNodeElement(nodeId, element);
      };
      nodeRefCallbacksRef.current.set(nodeId, callback);
      return callback;
    },
    [registerNodeElement]
  );

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
  const { nodes, links } = useForceLayout(visibleGraph.nodes, visibleGraph.links, width, height, groupOrder, nodeSizes);

   const nodesWithStacks = useMemo(() => arrangeComponentsBySize(nodes, links, width, height), [nodes, links, width, height]);

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
    if (focusMode) {
      const pivot = selectedNodeId ?? hoveredNodeId;
      if (!pivot) {
        return null;
      }
      return highlightState?.related ?? null;
    }
    if (!selectedNodeId) {
      return null;
    }
    const related = new Set<string>([selectedNodeId]);
    for (const link of links) {
      const src = typeof link.source === 'string' ? link.source : link.source.id;
      const dst = typeof link.target === 'string' ? link.target : link.target.id;
      if (src === selectedNodeId || dst === selectedNodeId) {
        related.add(src);
        related.add(dst);
      }
    }
    return related;
  }, [focusMode, selectedNodeId, hoveredNodeId, highlightState, links]);

  const highlightedNodeIds = useMemo(() => {
    if (focusMode) {
      return highlightState?.related ?? new Set<string>();
    }

    const highlighted = new Set<string>();
    if (!selectedNodeId) {
      return highlighted;
    }

    highlighted.add(selectedNodeId);
    for (const link of links) {
      const src = typeof link.source === 'string' ? link.source : link.source.id;
      const dst = typeof link.target === 'string' ? link.target : link.target.id;
      if (src === selectedNodeId || dst === selectedNodeId) {
        highlighted.add(src);
        highlighted.add(dst);
      }
    }

    return highlighted;
  }, [focusMode, highlightState, selectedNodeId, links]);

  const highlightedRenderNodes = useMemo(
    () => renderNodes.filter((node) => highlightedNodeIds.has(node.id)),
    [renderNodes, highlightedNodeIds]
  );

  const unselectedRenderNodes = useMemo(
    () => renderNodes.filter((node) => !highlightedNodeIds.has(node.id)),
    [renderNodes, highlightedNodeIds]
  );

  const edgeRenderItems = useMemo(() => {
    const items: EdgeRenderItem[] = [];

    const grouped = new Map<string, SimLink[]>();
    for (const link of renderLinks) {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      const key = `${sourceId}|${targetId}`;
      const arr = grouped.get(key) ?? [];
      arr.push(link);
      grouped.set(key, arr);
    }

    for (const [pairKey, bundle] of grouped.entries()) {
      const [sourceId, targetId] = pairKey.split('|');
      const source = nodeMap.get(sourceId);
      const target = nodeMap.get(targetId);
      if (!source || !target) {
        continue;
      }

      const isDirect =
        highlightState?.directLinks.has(`${source.id}->${target.id}`) ||
        highlightState?.directLinks.has(`${target.id}->${source.id}`) ||
        false;
      const showDirectStyling = showDirectEdges && isDirect;

      // Determine dirClass first
      let dirClass = '';
      if (pivotNodeId && isDirect) {
        if (source.id === pivotNodeId) {
          dirClass = 'edge-flow-outgoing';
        } else if (target.id === pivotNodeId) {
          dirClass = 'edge-flow-incoming';
        }
      }

      // In focus mode, fade all edges EXCEPT those with outgoing/incoming dirClass
      let faded = false;
      if (focusMode && pivotNodeId) {
        faded = !dirClass; // Only keep non-faded if dirClass is set
      } else if (dimSet) {
        // In selection mode, use existing dimSet logic
        faded = !(dimSet.has(source.id) && dimSet.has(target.id));
      }

      const totalWeight = bundle.reduce((sum, link) => sum + (link.weight ?? 1), 0);
      const baseStrokeWidth = Math.min(12, 2 + Math.log2(totalWeight + 1) * 1.9);
      const isDirectionalFocusEdge = dirClass === 'edge-flow-incoming' || dirClass === 'edge-flow-outgoing';
      const strokeWidth = isDirectionalFocusEdge ? Math.max(1.8, baseStrokeWidth * 0.72) : baseStrokeWidth;
      const labelLines = bundle
        .map((link) => link.label ?? link.type)
        .filter((value, index, arr) => Boolean(value) && arr.indexOf(value) === index);
      const typeSet = new Set(bundle.map((link) => link.type.toLowerCase()));
      const edgeTypeClass = typeSet.size === 1 ? `edge-${bundle[0].type.toLowerCase()}` : 'edge-flow';

      items.push({
        key: `${source.id}:${target.id}`,
        edgeKey: bundle[0].edgeKey ?? `${source.id}|${target.id}`,
        links: bundle,
        primaryLink: bundle[0],
        source,
        target,
        labelLines,
        strokeWidth,
        edgeTypeClass,
        dirClass,
        faded,
        isDirect,
        showDirectStyling
      });
    }

    return items;
  }, [renderLinks, nodeMap, highlightState, dimSet, pivotNodeId]);

  const highlightedEdgeItems = useMemo(
    () => edgeRenderItems.filter((item) => highlightedNodeIds.has(item.source.id) && highlightedNodeIds.has(item.target.id)),
    [edgeRenderItems, highlightedNodeIds]
  );

  const displayedHighlightedEdgeItems = useMemo(
    () => highlightedEdgeItems.filter((item) => showDirectEdges || !item.isDirect),
    [highlightedEdgeItems, showDirectEdges]
  );

  const nonHighlightedEdgeItems = useMemo(
    () => edgeRenderItems.filter((item) => !(highlightedNodeIds.has(item.source.id) && highlightedNodeIds.has(item.target.id))),
    [edgeRenderItems, highlightedNodeIds]
  );

  const displayedNonHighlightedEdgeItems = useMemo(() => {
    if (showDirectEdges) {
      return nonHighlightedEdgeItems;
    }
    const directItems = highlightedEdgeItems.filter((item) => item.isDirect);
    return nonHighlightedEdgeItems.concat(directItems);
  }, [showDirectEdges, nonHighlightedEdgeItems, highlightedEdgeItems]);

  const fadedEdgeItems = useMemo(() => {
    const seen = new Set<string>();
    const all = displayedNonHighlightedEdgeItems.concat(displayedHighlightedEdgeItems);
    const items: EdgeRenderItem[] = [];
    for (const item of all) {
      const isActive = item.dirClass === 'edge-flow-incoming' || item.dirClass === 'edge-flow-outgoing';
      if (isActive || seen.has(item.key)) {
        continue;
      }
      seen.add(item.key);
      // Keep non-active edges subdued even when they were previously non-faded.
      items.push(item.faded ? item : { ...item, faded: true });
    }
    return items;
  }, [displayedNonHighlightedEdgeItems, displayedHighlightedEdgeItems]);

  const emphasizedEdgeItems = useMemo(() => {
    const seen = new Set<string>();
    const all = displayedNonHighlightedEdgeItems.concat(displayedHighlightedEdgeItems);
    const items: EdgeRenderItem[] = [];
    for (const item of all) {
      const isActive = item.dirClass === 'edge-flow-incoming' || item.dirClass === 'edge-flow-outgoing';
      if (!isActive || seen.has(item.key)) {
        continue;
      }
      seen.add(item.key);
      items.push(item);
    }
    return items;
  }, [displayedNonHighlightedEdgeItems, displayedHighlightedEdgeItems]);

  const manhattanLineJumps = useMemo(() => {
    const jumps = new Map<string, LineJumpPoint[]>();
    if (routingMode !== 'manhattan') {
      return jumps;
    }

    const endpointExclusion = 20;

    const routes = emphasizedEdgeItems.map((item) => ({
      key: item.key,
      points: manhattanRoutePoints(item.source, item.target, nodeSizes, orthogonalPorts)
    }));

    for (let i = 0; i < routes.length; i += 1) {
      const a = routes[i];
      const aSegments = orthSegments(a.points);
      for (let j = i + 1; j < routes.length; j += 1) {
        const b = routes[j];
        const bSegments = orthSegments(b.points);

        for (const sa of aSegments) {
          if (sa.orientation !== 'h') {
            continue;
          }
          for (const sb of bSegments) {
            if (sb.orientation !== 'v') {
              continue;
            }

            const ix = sb.x1;
            const iy = sa.y1;
            const withinA =
              ix > Math.min(sa.x1, sa.x2) + endpointExclusion &&
              ix < Math.max(sa.x1, sa.x2) - endpointExclusion;
            const withinB =
              iy > Math.min(sb.y1, sb.y2) + endpointExclusion &&
              iy < Math.max(sb.y1, sb.y2) - endpointExclusion;
            if (!withinA || !withinB) {
              continue;
            }

            const arr = jumps.get(a.key) ?? [];
            if (!arr.some((p) => Math.abs(p.x - ix) < 0.5 && Math.abs(p.y - iy) < 0.5)) {
              arr.push({ x: ix, y: iy });
            }
            jumps.set(a.key, arr);
          }
        }

        for (const sb of bSegments) {
          if (sb.orientation !== 'h') {
            continue;
          }
          for (const sa of aSegments) {
            if (sa.orientation !== 'v') {
              continue;
            }

            const ix = sa.x1;
            const iy = sb.y1;
            const withinB =
              ix > Math.min(sb.x1, sb.x2) + endpointExclusion &&
              ix < Math.max(sb.x1, sb.x2) - endpointExclusion;
            const withinA =
              iy > Math.min(sa.y1, sa.y2) + endpointExclusion &&
              iy < Math.max(sa.y1, sa.y2) - endpointExclusion;
            if (!withinA || !withinB) {
              continue;
            }

            const arr = jumps.get(b.key) ?? [];
            if (!arr.some((p) => Math.abs(p.x - ix) < 0.5 && Math.abs(p.y - iy) < 0.5)) {
              arr.push({ x: ix, y: iy });
            }
            jumps.set(b.key, arr);
          }
        }
      }
    }

    for (const [key, points] of jumps.entries()) {
      points.sort((p1, p2) => p1.x - p2.x || p1.y - p2.y);
      jumps.set(key, points);
    }

    return jumps;
  }, [routingMode, emphasizedEdgeItems, nodeSizes, orthogonalPorts]);

  const edgeLabelPositions = useMemo(() => {
    const lineHeight = 13;
    const placements: Array<{ key: string; x: number; y: number; w: number; h: number }> = [];
    const byKey = new Map<string, { x: number; y: number }>();

    const highlightedRects = Array.from(highlightedNodeIds)
      .map((nodeId) => {
        const node = nodeMap.get(nodeId);
        if (!node) {
          return null;
        }
        const measured = nodeSizes.get(nodeId);
        return {
          x: node.x,
          y: node.y,
          w: measured?.width ?? 190,
          h: measured?.height ?? 48
        };
      })
      .filter((rect): rect is { x: number; y: number; w: number; h: number } => rect !== null);

    for (const item of emphasizedEdgeItems) {
      if (!item.labelLines.length || item.faded) {
        continue;
      }
      const { start, end } = getAnchoredEndpoints(item.source, item.target, nodeSizes, 0, 1, orthogonalPorts);
      let baseX = (start.x + end.x) / 2;
      let baseY = (start.y + end.y) / 2;
      const longestLabel = item.labelLines.reduce((max, text) => Math.max(max, text.length), 0);
      const w = Math.max(longestLabel * 6.3 + 18, 44);
      const h = Math.max(18, item.labelLines.length * lineHeight + 8);

      const step = 14;
      let attempts = 0;
      while (attempts < 18) {
        const intersects = placements.some((p) => Math.abs(baseX - p.x) < (w + p.w) / 2 + 6 && Math.abs(baseY - p.y) < (h + p.h) / 2 + 4);
        const overlapsHighlightedNode = highlightedRects.some(
          (rect) =>
            Math.abs(baseX - (rect.x + rect.w / 2)) < (w + rect.w) / 2 + 10 &&
            Math.abs(baseY - (rect.y + rect.h / 2)) < (h + rect.h) / 2 + 10
        );

        if (!intersects && !overlapsHighlightedNode) {
          break;
        }
        const dir = attempts % 2 === 0 ? 1 : -1;
        const band = Math.floor(attempts / 2) + 1;
        baseY += dir * band * step;
        if (overlapsHighlightedNode) {
          baseX += dir * 6;
        }
        attempts += 1;
      }

      placements.push({ key: item.key, x: baseX, y: baseY, w, h });
      byKey.set(item.key, { x: baseX, y: baseY });
    }

    return byKey;
  }, [emphasizedEdgeItems, nodeSizes, orthogonalPorts, highlightedNodeIds, nodeMap]);

  useEffect(() => {
    if (!svgRef.current) {
      return;
    }
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => setTransform(event.transform));
    zoomBehaviorRef.current = zoomBehavior;
    const selection = select(svgRef.current);
    selection.call(zoomBehavior as never);
    if (!isIdentityTransform(transform)) {
      selection.call(zoomBehavior.transform as never, transform);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const prefs: GraphUiPrefs = {
      focusMode,
      showDirectEdges,
      orthogonalPorts,
      routingMode,
      edgeMode,
      showHelpPanel,
      showLegendPanel,
      helpPanelPos,
      legendPanelPos,
      cameraTransform: { x: transform.x, y: transform.y, k: transform.k },
      selectedNodeId
    };
    try {
      window.localStorage.setItem(GRAPH_UI_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore storage quota/privacy mode errors and keep UI responsive.
    }
  }, [focusMode, showDirectEdges, orthogonalPorts, routingMode, edgeMode, showHelpPanel, showLegendPanel, helpPanelPos, legendPanelPos, transform, selectedNodeId]);

  useEffect(() => {
    if (!dragPanelState) {
      return;
    }
    const dragState = dragPanelState;

    function clampPanelPosition(panel: PanelName, x: number, y: number) {
      const panelWidth = panel === 'help' ? 240 : 190;
      const panelHeight = 150;
      return {
        x: clamp(x, 6, Math.max(6, width - panelWidth - 6)),
        y: clamp(y, 6, Math.max(6, height - panelHeight - 6))
      };
    }

    function handlePointerMove(event: PointerEvent) {
      const dx = event.clientX - dragState.startClientX;
      const dy = event.clientY - dragState.startClientY;
      const next = clampPanelPosition(dragState.panel, dragState.startX + dx, dragState.startY + dy);
      if (dragState.panel === 'help') {
        setHelpPanelPos(next);
      } else {
        setLegendPanelPos(next);
      }
    }

    function handlePointerUp() {
      setDragPanelState(null);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragPanelState, width, height]);

  useEffect(() => {
    return () => {
      for (const observer of nodeObserversRef.current.values()) {
        observer.disconnect();
      }
      nodeObserversRef.current.clear();
      nodeElementsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const validNodeIds = new Set(visibleGraph.nodes.map((n) => n.id));
    setSelectedNodeId((prev) => (prev && !validNodeIds.has(prev) ? null : prev));
    setPendingFocusId((prev) => (prev && !validNodeIds.has(prev) ? null : prev));
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

    setNodeSizes((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      let changed = false;
      const next = new Map<string, { width: number; height: number }>();
      for (const [id, size] of prev.entries()) {
        if (validNodeIds.has(id)) {
          next.set(id, size);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    for (const key of nodeRefCallbacksRef.current.keys()) {
      if (!validNodeIds.has(key)) {
        nodeRefCallbacksRef.current.delete(key);
      }
    }
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

  // Auto-fit viewport on first load or data change
  const hasInitialFitRef = useRef(!isIdentityTransform(transform));
  useEffect(() => {
    if (!svgRef.current || !zoomBehaviorRef.current || hasInitialFitRef.current || nodesWithManualPositions.length === 0) {
      return;
    }

    // Compute bounding box of all nodes
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const node of nodesWithManualPositions) {
      minX = Math.min(minX, node.x - 120);
      minY = Math.min(minY, node.y - 48);
      maxX = Math.max(maxX, node.x + 120);
      maxY = Math.max(maxY, node.y + 48);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return;
    }

    const padding = 40;
    const boundWidth = maxX - minX + padding * 2;
    const boundHeight = maxY - minY + padding * 2;

    const scale = Math.min(width / boundWidth, height / boundHeight, 1.0);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const tx = width / 2 - centerX * scale;
    const ty = height / 2 - centerY * scale;

    const targetTransform = zoomIdentity.translate(tx, ty).scale(scale);

    select(svgRef.current)
      .transition()
      .duration(500)
      .call(zoomBehaviorRef.current.transform as never, targetTransform);

    hasInitialFitRef.current = true;
  }, [nodesWithManualPositions.length, width, height]);

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

  function resetZoomView() {
    if (!svgRef.current || !zoomBehaviorRef.current) {
      return;
    }
    select(svgRef.current)
      .transition()
      .duration(240)
      .call(zoomBehaviorRef.current.transform as never, zoomIdentity);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      const isTypingTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if (isTypingTarget) {
        return;
      }

      if (event.key === 'Escape') {
        setSelectedNodeId(null);
        setHoveredNodeId(null);
        return;
      }
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        setFocusMode((v) => !v);
        return;
      }
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        resetZoomView();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function renderNodeCard(node: SimNode) {
    const faded = dimSet ? !dimSet.has(node.id) : false;
    const isPivot = pivotNodeId === node.id;
    const isNeighbor = Boolean(dimSet?.has(node.id) && !isPivot);
    return (
      <button
        ref={getNodeRefCallback(node.id)}
        type="button"
        key={node.id}
        className={`node-card ${node.type} ${faded ? 'node-dim' : ''} ${selectedNodeId === node.id ? 'node-selected' : ''} ${isPivot ? 'node-pivot' : ''} ${isNeighbor ? 'node-neighbor' : ''} ${draggingNodeId === node.id ? 'node-dragging' : ''}`}
        style={{ transform: `translate(${node.x}px, ${node.y}px)`, backgroundColor: getCategoryColor(node.dominant_category) }}
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
  }

  function beginPanelDrag(panel: PanelName, event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const pos = panel === 'help' ? helpPanelPos : legendPanelPos;
    setDragPanelState({
      panel,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: pos.x,
      startY: pos.y
    });
  }

  function renderEdge(item: EdgeRenderItem, showLabel: boolean) {
    const { start, end } = getAnchoredEndpoints(
      item.source,
      item.target,
      nodeSizes,
      0,
      1,
      orthogonalPorts
    );
    const sx = start.x;
    const sy = start.y;
    const tx = end.x;
    const ty = end.y;
    const defaultLabelX = (sx + tx) / 2;
    const defaultLabelY = (sy + ty) / 2;
    const adjusted = edgeLabelPositions.get(item.key);
    const labelX = adjusted?.x ?? defaultLabelX;
    const labelY = adjusted?.y ?? defaultLabelY;
    const longestLabel = item.labelLines.reduce((max, text) => Math.max(max, text.length), 0);
    const labelWidth = Math.max(longestLabel * 6.3 + 18, 44);
    const lineHeight = 13;
    const labelHeight = Math.max(18, item.labelLines.length * lineHeight + 8);
    const labelTop = labelY - labelHeight / 2;

    const pathD =
      routingMode === 'manhattan'
        ? manhattanEdgePath(item.source, item.target, nodeSizes, orthogonalPorts)
        : edgePath(
            item.source,
            item.target,
            edgeMode,
            groupCenter,
            0,
            1,
            nodeSizes,
            orthogonalPorts
          );

    const jumpPoints = manhattanLineJumps.get(item.key) ?? [];
    const jumpArcPath = jumpPointsToPath(jumpPoints, 6, 7);

    return (
      <g key={item.key}>
        <path
          d={pathD}
          className={`edge ${item.edgeTypeClass} ${item.dirClass} ${item.faded ? 'edge-dim' : ''} ${item.showDirectStyling ? 'edge-direct' : ''}`}
          style={{ strokeWidth: item.strokeWidth }}
          markerStart="url(#arrow-start-dot)"
          markerEnd="url(#arrow-end)"
        >
          <title>{item.labelLines.join('\n')}</title>
        </path>
        {routingMode === 'manhattan' && jumpArcPath && (
          <>
            <path
              d={jumpArcPath}
              fill="none"
              stroke="var(--ing-white)"
              strokeWidth={item.strokeWidth + 2.2}
              strokeLinecap="round"
              pointerEvents="none"
            />
            <path
              d={jumpArcPath}
              className={`edge ${item.edgeTypeClass} ${item.dirClass} ${item.faded ? 'edge-dim' : ''} ${item.showDirectStyling ? 'edge-direct' : ''}`}
              style={{ strokeWidth: item.strokeWidth }}
              fill="none"
              strokeLinecap="round"
              pointerEvents="none"
            />
          </>
        )}
        {showLabel && item.labelLines.length > 0 && !item.faded && (
          <g className="edge-label-group">
            <rect
              x={labelX - labelWidth / 2}
              y={labelTop}
              width={labelWidth}
              height={labelHeight}
              rx="4"
              ry="4"
              className={`edge-label-bg ${item.edgeTypeClass} ${item.dirClass}`}
            />
            <text
              x={labelX}
              y={labelTop + lineHeight}
              textAnchor="middle"
              className="edge-label"
            >
              {item.labelLines.map((text, index) => (
                <tspan key={`${item.key}-${index}`} x={labelX} dy={index === 0 ? 0 : lineHeight}>
                  {text}
                </tspan>
              ))}
            </text>
          </g>
        )}
      </g>
    );
  }

  return (
    <div className="graph-shell">
      <div className="toolbar">
        <button onClick={() => setCollapsedGroups(new Set(groupOrder))}>Collapse all groups</button>
        <button onClick={() => setCollapsedGroups(new Set())}>Expand all groups</button>
        <button onClick={() => setFocusMode((v) => !v)}>{focusMode ? 'Disable focus mode' : 'Enable focus mode'}</button>
        <label style={{ opacity: focusMode ? 1 : 0.5, pointerEvents: focusMode ? 'auto' : 'none' }}>
          <input type="checkbox" checked={showDirectEdges} onChange={(e) => setShowDirectEdges(e.target.checked)} disabled={!focusMode} />
          Show direct edges
        </label>
        <label>
          <input
            type="checkbox"
            checked={orthogonalPorts}
            onChange={(e) => setOrthogonalPorts(e.target.checked)}
          />
          Perpendicular box ports
        </label>
        <label>
          Routing:
          <select value={routingMode} onChange={(e) => setRoutingMode(e.target.value as 'smooth' | 'manhattan')}>
            <option value="smooth">smooth</option>
            <option value="manhattan">manhattan</option>
          </select>
        </label>
        <button onClick={resetZoomView}>Reset zoom</button>
        <button onClick={() => setShowLegendPanel((v) => !v)}>{showLegendPanel ? 'Hide legend' : 'Show legend'}</button>
        <button onClick={() => setShowHelpPanel((v) => !v)}>{showHelpPanel ? 'Hide help' : 'Show help'}</button>
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

      <div
        ref={stageRef}
        className="graph-stage"
        style={{ width, height }}
        onClick={(event) => {
          const target = event.target;
          if (target instanceof Element && target.closest('.node-card')) {
            return;
          }
          setSelectedNodeId(null);
        }}
      >
        {showHelpPanel && (
          <div className="overlay-panel overlay-help" style={{ left: helpPanelPos.x, top: helpPanelPos.y }}>
            <div className="overlay-panel-drag-handle" onPointerDown={(e) => beginPanelDrag('help', e)}><strong>Shortcuts</strong></div>
            <div><kbd>Esc</kbd> clear selection</div>
            <div><kbd>F</kbd> toggle focus mode</div>
            <div><kbd>R</kbd> reset zoom</div>
            <div>Click canvas to clear current node selection.</div>
          </div>
        )}
        {showLegendPanel && (
          <div className="overlay-panel overlay-legend" style={{ left: legendPanelPos.x, top: legendPanelPos.y }}>
            <div className="overlay-panel-drag-handle" onPointerDown={(e) => beginPanelDrag('legend', e)}><strong>Legend</strong></div>
            <div><span className="legend-dot legend-calls" /> calls</div>
            <div><span className="legend-dot legend-reads" /> reads</div>
            <div><span className="legend-dot legend-writes" /> writes</div>
            <div><span className="legend-dot legend-outgoing" /> outgoing (focus)</div>
            <div><span className="legend-dot legend-incoming" /> incoming (focus)</div>
          </div>
        )}
        <svg ref={svgRef} width={width} height={height} className="edge-layer edge-layer-low">
          <defs>
            <marker id="arrow-start-dot" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="3.5" markerHeight="3.5" orient="auto">
              <circle cx="5" cy="5" r="4" fill="context-stroke" />
            </marker>
            <marker id="arrow-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="3.5" markerHeight="3.5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          <g transform={transform.toString()}>
            {fadedEdgeItems.map((item) => renderEdge(item, false))}
          </g>
        </svg>

        <div className="node-layer" style={{ transform: cssZoomTransform(transform) }}>
          {unselectedRenderNodes.map((node) => renderNodeCard(node))}
        </div>

        <div className="node-layer node-layer-highlight" style={{ transform: cssZoomTransform(transform) }}>
          {highlightedRenderNodes.map((node) => renderNodeCard(node))}
        </div>

        <svg width={width} height={height} className="edge-layer edge-layer-highlight">
          <g transform={transform.toString()}>
            {emphasizedEdgeItems.map((item) => renderEdge(item, true))}
          </g>
        </svg>
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
  parallelTotal = 1,
  nodeSizes: Map<string, { width: number; height: number }>,
  orthogonalPorts = false
): string {
  const anchors = getAnchoredEndpoints(source, target, nodeSizes, parallelIndex, parallelTotal, orthogonalPorts);
  const { start, end } = anchors;
  const sx = start.x;
  const sy = start.y;
  const tx = end.x;
  const ty = end.y;
  const sourceStubX = sx + anchors.startNormal.x * 18;
  const sourceStubY = sy + anchors.startNormal.y * 18;
  const targetStubX = tx + anchors.endNormal.x * 18;
  const targetStubY = ty + anchors.endNormal.y * 18;

  if (mode === 'none') {
    if (orthogonalPorts) {
      return `M ${sx} ${sy} L ${sourceStubX} ${sourceStubY} L ${targetStubX} ${targetStubY} L ${tx} ${ty}`;
    }
    return `M ${sx} ${sy} L ${tx} ${ty}`;
  }

  if (mode === 'grouped') {
    const sourceGroup = groupCenter.get(source.group);
    const targetGroup = groupCenter.get(target.group);
    if (sourceGroup && targetGroup) {
      const c1x = sourceStubX + (sourceGroup.x - sourceStubX) * 0.62;
      const c1y = sourceStubY + (sourceGroup.y - sourceStubY) * 0.62;
      const c2x = targetStubX + (targetGroup.x - targetStubX) * 0.62;
      const c2y = targetStubY + (targetGroup.y - targetStubY) * 0.62;
      if (orthogonalPorts) {
        return `M ${sx} ${sy} L ${sourceStubX} ${sourceStubY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${targetStubX} ${targetStubY} L ${tx} ${ty}`;
      }
      return `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
    }
  }

  const dx = tx - sx;
  const dy = ty - sy;
  const distance = Math.hypot(dx, dy) || 1;
  const bend = Math.max(34, Math.min(180, distance * 0.45));
  const c1x = sourceStubX + (orthogonalPorts ? 0 : dx * 0.28) + anchors.startNormal.x * bend;
  const c1y = sourceStubY + (orthogonalPorts ? 0 : dy * 0.28) + anchors.startNormal.y * bend;
  const c2x = targetStubX - (orthogonalPorts ? 0 : dx * 0.28) + anchors.endNormal.x * bend;
  const c2y = targetStubY - (orthogonalPorts ? 0 : dy * 0.28) + anchors.endNormal.y * bend;
  if (orthogonalPorts) {
    return `M ${sx} ${sy} L ${sourceStubX} ${sourceStubY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${targetStubX} ${targetStubY} L ${tx} ${ty}`;
  }
  return `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
}

type NodeSide = 'left' | 'right' | 'top' | 'bottom';

interface AnchorPoint {
  x: number;
  y: number;
  side: NodeSide;
}

function getNodeRect(node: SimNode, nodeSizes: Map<string, { width: number; height: number }>) {
  const measured = nodeSizes.get(node.id);
  return {
    x: node.x,
    y: node.y,
    width: measured?.width ?? 190,
    height: measured?.height ?? 48
  };
}

function getRectCenter(rect: { x: number; y: number; width: number; height: number }) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2
  };
}

function anchorToRectBorder(
  rect: { x: number; y: number; width: number; height: number },
  toward: { x: number; y: number }
): AnchorPoint {
  const center = getRectCenter(rect);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;

  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
    return {
      x: rect.x + rect.width,
      y: center.y,
      side: 'right'
    };
  }

  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);

  const point = {
    x: center.x + dx * scale,
    y: center.y + dy * scale
  };
  return {
    ...point,
    side: inferAnchorSide(rect, point)
  };
}

function getAnchoredEndpoints(
  source: SimNode,
  target: SimNode,
  nodeSizes: Map<string, { width: number; height: number }>,
  parallelIndex = 0,
  parallelTotal = 1,
  orthogonalPorts = false
) {
  const sourceRect = getNodeRect(source, nodeSizes);
  const targetRect = getNodeRect(target, nodeSizes);
  const sourceCenter = getRectCenter(sourceRect);
  const targetCenter = getRectCenter(targetRect);
  const base = orthogonalPorts
    ? anchorOrthogonalPorts(sourceRect, targetRect)
    : {
        start: anchorToRectBorder(sourceRect, targetCenter),
        end: anchorToRectBorder(targetRect, sourceCenter)
      };
  const offset = parallelOffsetDistance(parallelIndex, parallelTotal);

  const { start, end } = orthogonalPorts
    ? offsetOrthogonalPorts(base.start, base.end, sourceRect, targetRect, offset)
    : offsetAlongLineNormal(base.start, base.end, offset);

  return {
    start,
    end,
    startNormal: sideNormal(start.side),
    endNormal: sideNormal(end.side)
  };
}

function parallelOffsetDistance(index: number, total: number) {
  return (index - (total - 1) / 2) * 14;
}

function sideNormal(side: NodeSide) {
  if (side === 'left') {
    return { x: -1, y: 0 };
  }
  if (side === 'right') {
    return { x: 1, y: 0 };
  }
  if (side === 'top') {
    return { x: 0, y: -1 };
  }
  return { x: 0, y: 1 };
}

function inferAnchorSide(
  rect: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number }
): NodeSide {
  const distances: Array<{ side: NodeSide; distance: number }> = [
    { side: 'left', distance: Math.abs(point.x - rect.x) },
    { side: 'right', distance: Math.abs(point.x - (rect.x + rect.width)) },
    { side: 'top', distance: Math.abs(point.y - rect.y) },
    { side: 'bottom', distance: Math.abs(point.y - (rect.y + rect.height)) }
  ];
  distances.sort((a, b) => a.distance - b.distance);
  return distances[0].side;
}

function anchorOrthogonalPorts(
  sourceRect: { x: number; y: number; width: number; height: number },
  targetRect: { x: number; y: number; width: number; height: number }
) {
  const sourceCenter = getRectCenter(sourceRect);
  const targetCenter = getRectCenter(targetRect);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const guard = 8;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const sourceSide: NodeSide = dx >= 0 ? 'right' : 'left';
    const targetSide: NodeSide = dx >= 0 ? 'left' : 'right';
    const sourceY = clamp(targetCenter.y, sourceRect.y + guard, sourceRect.y + sourceRect.height - guard);
    const targetY = clamp(sourceCenter.y, targetRect.y + guard, targetRect.y + targetRect.height - guard);
    return {
      start: {
        x: sourceSide === 'right' ? sourceRect.x + sourceRect.width : sourceRect.x,
        y: sourceY,
        side: sourceSide
      },
      end: {
        x: targetSide === 'right' ? targetRect.x + targetRect.width : targetRect.x,
        y: targetY,
        side: targetSide
      }
    };
  }

  const sourceSide: NodeSide = dy >= 0 ? 'bottom' : 'top';
  const targetSide: NodeSide = dy >= 0 ? 'top' : 'bottom';
  const sourceX = clamp(targetCenter.x, sourceRect.x + guard, sourceRect.x + sourceRect.width - guard);
  const targetX = clamp(sourceCenter.x, targetRect.x + guard, targetRect.x + targetRect.width - guard);
  return {
    start: {
      x: sourceX,
      y: sourceSide === 'bottom' ? sourceRect.y + sourceRect.height : sourceRect.y,
      side: sourceSide
    },
    end: {
      x: targetX,
      y: targetSide === 'bottom' ? targetRect.y + targetRect.height : targetRect.y,
      side: targetSide
    }
  };
}

function offsetAlongLineNormal(start: AnchorPoint, end: AnchorPoint, distance: number) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    return { start, end };
  }
  const nx = -dy / length;
  const ny = dx / length;
  return {
    start: { ...start, x: start.x + nx * distance, y: start.y + ny * distance },
    end: { ...end, x: end.x + nx * distance, y: end.y + ny * distance }
  };
}

function offsetOrthogonalPorts(
  start: AnchorPoint,
  end: AnchorPoint,
  sourceRect: { x: number; y: number; width: number; height: number },
  targetRect: { x: number; y: number; width: number; height: number },
  distance: number
) {
  return {
    start: offsetOnEdge(start, sourceRect, distance),
    end: offsetOnEdge(end, targetRect, distance)
  };
}

function offsetOnEdge(
  point: AnchorPoint,
  rect: { x: number; y: number; width: number; height: number },
  distance: number
): AnchorPoint {
  const guard = 8;
  if (point.side === 'left' || point.side === 'right') {
    return {
      ...point,
      y: clamp(point.y + distance, rect.y + guard, rect.y + rect.height - guard)
    };
  }
  return {
    ...point,
    x: clamp(point.x + distance, rect.x + guard, rect.x + rect.width - guard)
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function manhattanEdgePath(
  source: SimNode,
  target: SimNode,
  nodeSizes: Map<string, { width: number; height: number }>,
  orthogonalPorts = false
): string {
  const points = manhattanRoutePoints(source, target, nodeSizes, orthogonalPorts);
  return roundedOrthogonalPath(points, 12);
}

function manhattanRoutePoints(
  source: SimNode,
  target: SimNode,
  nodeSizes: Map<string, { width: number; height: number }>,
  orthogonalPorts = false
): Array<{ x: number; y: number }> {
  const anchors = getAnchoredEndpoints(source, target, nodeSizes, 0, 1, orthogonalPorts);
  const sx = anchors.start.x;
  const sy = anchors.start.y;
  const tx = anchors.end.x;
  const ty = anchors.end.y;

  const dx = tx - sx;
  const dy = ty - sy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const mx = sx + dx * 0.5;
    return [
      { x: sx, y: sy },
      { x: mx, y: sy },
      { x: mx, y: ty },
      { x: tx, y: ty }
    ];
  }
  const my = sy + dy * 0.5;
  return [
    { x: sx, y: sy },
    { x: sx, y: my },
    { x: tx, y: my },
    { x: tx, y: ty }
  ];
}

interface OrthSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  orientation: 'h' | 'v';
}

function orthSegments(points: Array<{ x: number; y: number }>): OrthSegment[] {
  const segments: OrthSegment[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) {
      continue;
    }
    if (Math.abs(a.y - b.y) < 1e-6) {
      segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, orientation: 'h' });
    } else if (Math.abs(a.x - b.x) < 1e-6) {
      segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, orientation: 'v' });
    }
  }
  return segments;
}

function jumpPointsToPath(points: Array<{ x: number; y: number }>, radius: number, height: number): string {
  if (!points.length) {
    return '';
  }
  return points
    .map((point) => `M ${point.x - radius} ${point.y} Q ${point.x} ${point.y - height} ${point.x + radius} ${point.y}`)
    .join(' ');
}

function roundedOrthogonalPath(points: Array<{ x: number; y: number }>, cornerRadius: number): string {
  if (points.length < 2) {
    return '';
  }

  const compact: Array<{ x: number; y: number }> = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = compact[compact.length - 1];
    const curr = points[i];
    if (Math.abs(prev.x - curr.x) > 1e-6 || Math.abs(prev.y - curr.y) > 1e-6) {
      compact.push(curr);
    }
  }

  if (compact.length < 2) {
    return '';
  }

  let d = `M ${compact[0].x} ${compact[0].y}`;
  for (let i = 1; i < compact.length - 1; i += 1) {
    const prev = compact[i - 1];
    const curr = compact[i];
    const next = compact[i + 1];

    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);

    if (len1 < 1e-6 || len2 < 1e-6) {
      d += ` L ${curr.x} ${curr.y}`;
      continue;
    }

    const sameDir = Math.abs(v1x * v2y - v1y * v2x) < 1e-6;
    if (sameDir) {
      d += ` L ${curr.x} ${curr.y}`;
      continue;
    }

    const r = Math.min(cornerRadius, len1 * 0.5, len2 * 0.5);
    const inX = curr.x - (v1x / len1) * r;
    const inY = curr.y - (v1y / len1) * r;
    const outX = curr.x + (v2x / len2) * r;
    const outY = curr.y + (v2y / len2) * r;

    d += ` L ${inX} ${inY}`;
    d += ` Q ${curr.x} ${curr.y} ${outX} ${outY}`;
  }

  const last = compact[compact.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

interface ComponentGroup {
  id: number;
  nodeIds: Set<string>;
  nodes: SimNode[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

function arrangeComponentsBySize(nodes: SimNode[], links: SimLink[], width: number, height: number): SimNode[] {
  if (!nodes.length) {
    return nodes;
  }

  // Group nodes by connected_component_id
  const componentMap = new Map<number, ComponentGroup>();
  
  for (const node of nodes) {
    const compId = node.connected_component_id ?? -1;
    if (!componentMap.has(compId)) {
      componentMap.set(compId, {
        id: compId,
        nodeIds: new Set(),
        nodes: [],
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
        width: 0,
        height: 0,
      });
    }
    const comp = componentMap.get(compId)!;
    comp.nodeIds.add(node.id);
    comp.nodes.push(node);
    comp.minX = Math.min(comp.minX, node.x);
    comp.maxX = Math.max(comp.maxX, node.x);
    comp.minY = Math.min(comp.minY, node.y);
    comp.maxY = Math.max(comp.maxY, node.y);
  }

  // Calculate bounding boxes
  for (const comp of componentMap.values()) {
    comp.width = (comp.maxX - comp.minX) + 260; // node width (~190) + padding
    comp.height = (comp.maxY - comp.minY) + 100; // node height (~48) + padding
  }

  // Sort components by size (smallest first) except the largest
  const components = Array.from(componentMap.values());
  const largestComp = components.reduce((max, c) => (c.nodes.length > max.nodes.length ? c : max));
  const smallerComps = components.filter((c) => c.id !== largestComp.id).sort((a, b) => a.nodes.length - b.nodes.length);

  // Layout parameters
  const stackLeft = 24;
  const stackTop = 24;
  const compGap = 16; // gap between small components
  const mainGraphGap = 160; // gap between stacked components and main graph
  const maxStackHeight = height - 48;
  const maxStackWidth = Math.min(400, width * 0.25); // max width for stacked components

  // Position smaller components in a grid on the left/top
  const positioned = new Map<number, { offsetX: number; offsetY: number }>();
  let currentX = stackLeft;
  let currentY = stackTop;
  let maxYInColumn = stackTop;

  for (const comp of smallerComps) {
    // Check if component fits in current column
    if (currentY + comp.height + compGap > maxStackHeight) {
      // Move to next column
      currentX += maxStackWidth + compGap;
      currentY = stackTop;
      maxYInColumn = stackTop;
    }

    positioned.set(comp.id, { offsetX: currentX, offsetY: currentY });
    currentY += comp.height + compGap;
    maxYInColumn = Math.max(maxYInColumn, currentY);
  }

  const rightMostStackX = currentX + maxStackWidth;
  const mainGraphMinX = Math.min(width - 200, rightMostStackX + mainGraphGap);

  // Shift main graph (largest component) to the right if needed
  const largestMinX = largestComp.nodes.reduce((min, n) => Math.min(min, n.x), Number.POSITIVE_INFINITY);
  const shiftX = Number.isFinite(largestMinX) ? Math.max(0, mainGraphMinX - largestMinX) : 0;

  // Apply positioning
  return nodes.map((node) => {
    const compId = node.connected_component_id ?? -1;
    
    // If node is in a smaller component, reposition it within that component's bounds
    if (compId !== largestComp.id && positioned.has(compId)) {
      const comp = componentMap.get(compId)!;
      const offset = positioned.get(compId)!;
      const relativeX = node.x - comp.minX;
      const relativeY = node.y - comp.minY;
      return {
        ...node,
        x: offset.offsetX + relativeX + 20,
        y: offset.offsetY + relativeY + 20,
      };
    }

    // Largest component (main graph) gets shifted right if needed
    if (shiftX > 0) {
      return { ...node, x: node.x + shiftX };
    }

    return node;
  });
}

