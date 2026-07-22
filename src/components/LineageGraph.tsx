import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  easeCubicInOut,
  easeCubicOut,
  select,
  zoom,
  zoomIdentity,
  type D3ZoomEvent,
  type ZoomBehavior,
  type ZoomTransform
} from 'd3';
import type { DetailLayoutMode, GraphData, LayoutEngine, SimLink, SimNode } from '../types/graph';
import { useForceLayout } from '../hooks/useForceLayout';
import { buildLocalSugiyamaLayout, buildVisibleGraph, collectNeighborhood } from '../utils/graph';
import { getCategoryColor } from '../utils/categoryConfig';

interface LineageGraphProps {
  data: GraphData;
  width?: number;
  height?: number;
  layoutEngine?: LayoutEngine;
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
  isBidirectionalBundle: boolean;
  parallelIndex: number;
  parallelTotal: number;
  sharedSourcePort: AnchorPoint | null;
  sharedTargetPort: AnchorPoint | null;
  // New bundling fields
  directionality: 'incoming' | 'outgoing' | 'both' | 'none';  // relative to pivot/selected node
  bundleColor: 'orange' | 'blue' | 'purple' | 'default';    // based on directionality
  sharedEdges?: SimLink[];                                     // edges in the shared bundle portion
  divergingEdges?: SimLink[];                                 // edges that diverge from shared bundle
  labelGroupKey?: string;                                     // for grouping same-label edges
}

interface LineJumpPoint {
  x: number;
  y: number;
}

interface PurpleHybridEdgeHint {
  pivotX: number;
  pivotY: number;
  junctionX: number;
  junctionY: number;
  outgoingFromPivot: boolean;
  pivotIsSource: boolean;
}

interface PurpleHybridTrunkItem {
  key: string;
  pathD: string;
  className: string;
  strokeWidth: number;
  opacity?: number;
  faded: boolean;
}

interface GraphUiPrefs {
  focusDimStrength: number;
  autoZoomEnabled: boolean;
  showDirectEdges: boolean;
  orthogonalPorts: boolean;
  routingMode: 'smooth' | 'manhattan' | 'octolinear';
  edgeMode: 'none' | 'soft' | 'grouped';
  showHelpPanel: boolean;
  showLegendPanel: boolean;
  helpPanelPos: { x: number; y: number };
  legendPanelPos: { x: number; y: number };
  cameraTransform: { x: number; y: number; k: number };
  selectedNodeId: string | null;
  toolbarPosition: 'top' | 'bottom' | 'left' | 'right';
  detailLayoutMode: DetailLayoutMode;
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

const OCTOLINEAR_PRIMARY_OFFSETS = [0, 24, -24, 48, -48];
const OCTOLINEAR_SECONDARY_OFFSETS = [72, -72, 96, -96];
const OCTOLINEAR_CLEARANCE = 22;
const OCTOLINEAR_OBSTACLE_RANGE = 420;
const OCTOLINEAR_CACHE_LIMIT = 1200;
const EDGE_OUTSIDE_HIT_GAP = 6;
const octolinearRouteCache = new Map<string, Array<{ x: number; y: number }>>();

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

export function LineageGraph({ data, width = 1400, height = 820, layoutEngine = 'auto' }: LineageGraphProps) {
  const initialPrefsRef = useRef<Partial<GraphUiPrefs> | null>(null);
  if (initialPrefsRef.current === null) {
    initialPrefsRef.current = readGraphUiPrefs();
  }
  const initialPrefs = initialPrefsRef.current;

   const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(defaultCollapsedGroups(data)));
   const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
   const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialPrefs.selectedNodeId ?? null);
   const [focusDimStrength, setFocusDimStrength] = useState(() => {
     const stored = initialPrefs.focusDimStrength;
     if (typeof stored === 'number' && Number.isFinite(stored)) {
       return Math.max(0, Math.min(100, stored));
     }
     return 85;
   });
   const [autoZoomEnabled, setAutoZoomEnabled] = useState(initialPrefs.autoZoomEnabled ?? true);
  const [showDirectEdges, setShowDirectEdges] = useState(initialPrefs.showDirectEdges ?? false);
  const [orthogonalPorts, setOrthogonalPorts] = useState(initialPrefs.orthogonalPorts ?? true);
  const [routingMode, setRoutingMode] = useState<'smooth' | 'manhattan' | 'octolinear'>(initialPrefs.routingMode ?? 'smooth');
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
   const [localRootNodeId, setLocalRootNodeId] = useState<string | null>(null);
   const [isLocalContext, setIsLocalContext] = useState(false);
   const [manualPositions, setManualPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
   const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
   const [nodeSizes, setNodeSizes] = useState<Map<string, { width: number; height: number }>>(new Map());
   const [toolbarPosition, setToolbarPosition] = useState<'top' | 'bottom' | 'left' | 'right'>(initialPrefs.toolbarPosition ?? 'top');
    const [detailLayoutMode, setDetailLayoutMode] = useState<DetailLayoutMode>(
      initialPrefs.detailLayoutMode === 'sugiyama' ? 'sugiyama' : 'force'
    );

  const svgRef = useRef<SVGSVGElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const syncingScrollFromTransformRef = useRef(false);
  const syncingTransformFromScrollRef = useRef(false);
  const dragStateRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const nodeElementsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const nodeObserversRef = useRef<Map<string, ResizeObserver>>(new Map());
  const nodeRefCallbacksRef = useRef<Map<string, (element: HTMLButtonElement | null) => void>>(new Map());
   const preLocalTransformRef = useRef<ZoomTransform | null>(null);
   const pendingFocusDurationRef = useRef(280);
   const pendingFocusScaleRef = useRef<number | null>(null);
   const dragStartClientRef = useRef<{ x: number; y: number } | null>(null);
   const dragMovedRef = useRef(false);
   const suppressNextNodeClickRef = useRef(false);
   const [dragPanelState, setDragPanelState] = useState<DragPanelState | null>(null);
   const preLocalNodePositionsRef = useRef<Map<string, { x: number; y: number }> | null>(null);
    const lastSugiyamaCenteredPivotRef = useRef<string | null>(null);
    const lastLocalGraphCenteredKeyRef = useRef<string | null>(null);

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
  const activeGraph = useMemo(() => {
    if (!isLocalContext || !localRootNodeId) {
      return visibleGraph;
    }
    const relatedNodeIds = collectNeighborhood(visibleGraph, localRootNodeId);
    const nodes = visibleGraph.nodes.filter((node) => relatedNodeIds.has(node.id));
    const links = visibleGraph.links.filter((link) => {
      const src = typeof link.source === 'string' ? link.source : link.source.id;
      const dst = typeof link.target === 'string' ? link.target : link.target.id;
      return relatedNodeIds.has(src) && relatedNodeIds.has(dst);
    });
    return { nodes, links };
  }, [visibleGraph, isLocalContext, localRootNodeId]);
  const { nodes, links } = useForceLayout(
    activeGraph.nodes,
    activeGraph.links,
    width,
    height,
    groupOrder,
    nodeSizes,
    layoutEngine,
    {
      isLocalContext,
      localRootNodeId
    }
  );
  const localRootNodeLabel = useMemo(() => {
    if (!localRootNodeId) {
      return '';
    }
    return visibleGraph.nodes.find((node) => node.id === localRootNodeId)?.label ?? localRootNodeId;
  }, [visibleGraph.nodes, localRootNodeId]);

  // Adjust canvas dimensions when toolbar is on left/right.
  const toolbarWidth = toolbarPosition === 'left' || toolbarPosition === 'right' ? 280 : 0;
  const canvasWidth = Math.max(400, width - toolbarWidth);
  const canvasHeight = height;

   const nodesWithStacks = useMemo(() => arrangeComponentsBySize(nodes, links, canvasWidth, canvasHeight), [nodes, links, canvasWidth, canvasHeight]);

  const sugiyamaPivotNodeId = useMemo(() => {
    if (!isLocalContext || detailLayoutMode !== 'sugiyama') {
      return null;
    }
    if (selectedNodeId && activeGraph.nodes.some((node) => node.id === selectedNodeId)) {
      return selectedNodeId;
    }
    if (localRootNodeId && activeGraph.nodes.some((node) => node.id === localRootNodeId)) {
      return localRootNodeId;
    }
    return null;
  }, [isLocalContext, detailLayoutMode, selectedNodeId, localRootNodeId, activeGraph.nodes]);

  const useSugiyamaLocalLayout = Boolean(sugiyamaPivotNodeId);
  const sugiyamaInOutNeighborIds = useMemo(() => {
    if (!useSugiyamaLocalLayout || !sugiyamaPivotNodeId) {
      return new Set<string>();
    }
    const toPivot = new Set<string>();
    const fromPivot = new Set<string>();
    for (const link of links) {
      const src = typeof link.source === 'string' ? link.source : link.source.id;
      const dst = typeof link.target === 'string' ? link.target : link.target.id;
      if (dst === sugiyamaPivotNodeId && src !== sugiyamaPivotNodeId) {
        toPivot.add(src);
      }
      if (src === sugiyamaPivotNodeId && dst !== sugiyamaPivotNodeId) {
        fromPivot.add(dst);
      }
    }
    const inOut = new Set<string>();
    for (const nodeId of toPivot) {
      if (fromPivot.has(nodeId)) {
        inOut.add(nodeId);
      }
    }
    return inOut;
  }, [useSugiyamaLocalLayout, sugiyamaPivotNodeId, links]);
  const nodesWithDetailLayout = useMemo(() => {
    if (!useSugiyamaLocalLayout || !sugiyamaPivotNodeId) {
      return nodesWithStacks;
    }
    const sugiyamaPositions = buildLocalSugiyamaLayout(nodesWithStacks, links, sugiyamaPivotNodeId, canvasWidth, canvasHeight, {
      maxRowsPerColumn: 8,
    });
    return nodesWithStacks.map((node) => {
      const position = sugiyamaPositions.get(node.id);
      return position ? { ...node, x: position.x, y: position.y } : node;
    });
  }, [useSugiyamaLocalLayout, sugiyamaPivotNodeId, nodesWithStacks, links, width, height]);

  const nodesWithManualPositions = useMemo(() => {
    // Sugiyama mode is deterministic; do not apply stale drag positions from other modes.
    if (useSugiyamaLocalLayout || manualPositions.size === 0) {
      return nodesWithDetailLayout;
    }
    return nodesWithDetailLayout.map((node) => {
      const fixed = manualPositions.get(node.id);
      return fixed ? { ...node, x: fixed.x, y: fixed.y } : node;
    });
  }, [nodesWithDetailLayout, manualPositions, useSugiyamaLocalLayout]);

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
    const maxX = ((canvasWidth - transform.x) / transform.k) + padding;
    const maxY = ((canvasHeight - transform.y) / transform.k) + padding;
    return { minX, minY, maxX, maxY };
  }, [transform, canvasWidth, canvasHeight]);

  const scrollWorldBounds = useMemo(() => {
    if (!nodesWithManualPositions.length) {
      const halfW = canvasWidth / Math.max(transform.k, 0.001) / 2;
      const halfH = canvasHeight / Math.max(transform.k, 0.001) / 2;
      return { minX: -halfW, minY: -halfH, maxX: halfW, maxY: halfH };
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const node of nodesWithManualPositions) {
      const measured = nodeSizes.get(node.id);
      const nodeWidth = measured?.width ?? 190;
      const nodeHeight = measured?.height ?? 48;
      minX = Math.min(minX, node.x - nodeWidth * 0.65);
      minY = Math.min(minY, node.y - nodeHeight * 0.75);
      maxX = Math.max(maxX, node.x + nodeWidth * 1.15);
      maxY = Math.max(maxY, node.y + nodeHeight * 1.15);
    }

    const margin = 260;
    minX -= margin;
    minY -= margin;
    maxX += margin;
    maxY += margin;

    const minWorldWidth = canvasWidth / Math.max(transform.k, 0.001);
    const minWorldHeight = canvasHeight / Math.max(transform.k, 0.001);
    const worldWidth = Math.max(1, maxX - minX);
    const worldHeight = Math.max(1, maxY - minY);
    if (worldWidth < minWorldWidth) {
      const cx = (minX + maxX) / 2;
      minX = cx - minWorldWidth / 2;
      maxX = cx + minWorldWidth / 2;
    }
    if (worldHeight < minWorldHeight) {
      const cy = (minY + maxY) / 2;
      minY = cy - minWorldHeight / 2;
      maxY = cy + minWorldHeight / 2;
    }

    return { minX, minY, maxX, maxY };
  }, [nodesWithManualPositions, nodeSizes, canvasWidth, canvasHeight, transform.k]);

  const scrollContentSize = useMemo(() => {
    const worldWidth = Math.max(1, scrollWorldBounds.maxX - scrollWorldBounds.minX);
    const worldHeight = Math.max(1, scrollWorldBounds.maxY - scrollWorldBounds.minY);
    return {
      width: Math.max(canvasWidth + 1, Math.ceil(worldWidth * transform.k)),
      height: Math.max(canvasHeight + 1, Math.ceil(worldHeight * transform.k))
    };
  }, [scrollWorldBounds, transform.k, canvasWidth, canvasHeight]);

  const onViewportScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (syncingScrollFromTransformRef.current) {
        return;
      }
      if (!zoomBehaviorRef.current || !svgRef.current) {
        return;
      }

      const viewport = event.currentTarget;
      const k = transform.k;
      const worldX = scrollWorldBounds.minX + viewport.scrollLeft / k;
      const worldY = scrollWorldBounds.minY + viewport.scrollTop / k;
      const targetTransform = zoomIdentity.translate(-(worldX * k), -(worldY * k)).scale(k);

      syncingTransformFromScrollRef.current = true;
      select(svgRef.current).call(zoomBehaviorRef.current.transform as never, targetTransform);
    },
    [transform.k, scrollWorldBounds]
  );

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

   const pivotNodeId = selectedNodeId;
   const dimRatio = focusDimStrength / 100;
   // 0% keeps everything fully visible; 100% fully hides dimmed items.
   const dimmedNodeOpacity = 1 - dimRatio;
   const dimmedEdgeOpacity = 1 - dimRatio;

   const highlightState = useMemo(() => {
     if (!pivotNodeId) {
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
   }, [pivotNodeId, links]);

   const dimSet = useMemo(() => {
     // Only dim when a node is explicitly selected.
     if (!selectedNodeId) {
       return null;
     }
     return highlightState?.related ?? null;
   }, [selectedNodeId, highlightState]);

   const highlightedNodeIds = useMemo(() => {
     // Focus mode is always active.
     return highlightState?.related ?? new Set<string>();
   }, [highlightState]);

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
    const labelGrouped = new Map<string, SimLink[]>();
    for (const link of renderLinks) {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      const key = `${sourceId}|${targetId}`;
      const arr = grouped.get(key) ?? [];
      arr.push(link);
      grouped.set(key, arr);

      const normalizedLabel = (link.label ?? link.type ?? '').trim().toLowerCase();
      if (normalizedLabel) {
        const undirected = sourceId < targetId ? `${sourceId}|${targetId}` : `${targetId}|${sourceId}`;
        const labelKey = `${undirected}|${normalizedLabel}`;
        const labelGroup = labelGrouped.get(labelKey) ?? [];
        labelGroup.push(link);
        labelGrouped.set(labelKey, labelGroup);
      }
    }

    const bidirectionalBundleKeys = new Set<string>();

    // Check bidirectionality across ALL edges between any two nodes (regardless of label)
    const pairDirections = new Map<string, Set<string>>();
    for (const link of renderLinks) {
      const src = typeof link.source === 'string' ? link.source : link.source.id;
      const dst = typeof link.target === 'string' ? link.target : link.target.id;
      const undirected = src < dst ? `${src}|${dst}` : `${dst}|${src}`;
      if (!pairDirections.has(undirected)) {
        pairDirections.set(undirected, new Set());
      }
      pairDirections.get(undirected)!.add(`${src}->${dst}`);
    }

    // Mark pairs as bidirectional if they have edges in both directions
    for (const [undirected, directions] of pairDirections.entries()) {
      if (directions.size >= 2) {
        const [leftId, rightId] = undirected.split('|');
        bidirectionalBundleKeys.add(`${leftId}|${rightId}`);
        bidirectionalBundleKeys.add(`${rightId}|${leftId}`);
      }
    }

    const processedBundlePairs = new Set<string>();

    for (const [pairKey, bundle] of grouped.entries()) {
      const [sourceId, targetId] = pairKey.split('|');
      const source = nodeMap.get(sourceId);
      const target = nodeMap.get(targetId);
      if (!source || !target) {
        continue;
      }

      const reversePairKey = `${targetId}|${sourceId}`;
      const isBidirectionalPair = bidirectionalBundleKeys.has(pairKey) && grouped.has(reversePairKey);
      if (isBidirectionalPair) {
        const undirectedKey = sourceId < targetId ? `${sourceId}|${targetId}` : `${targetId}|${sourceId}`;
        if (processedBundlePairs.has(undirectedKey)) {
          continue;
        }
        processedBundlePairs.add(undirectedKey);

        const reverseLinks = grouped.get(reversePairKey) ?? [];
        const mergedLinks = bundle.concat(reverseLinks);
        const commonLabel = (bundle[0].label ?? bundle[0].type) || (reverseLinks[0]?.label ?? reverseLinks[0]?.type) || 'flow';
        const isBundleSelected = Boolean(pivotNodeId && (sourceId === pivotNodeId || targetId === pivotNodeId));
        const faded = Boolean(pivotNodeId && !isBundleSelected);
        const totalWeight = mergedLinks.reduce((sum, link) => sum + (link.weight ?? 1), 0);
        const strokeWidth = Math.min(12, 2 + Math.log2(totalWeight + 1) * 1.9);

        items.push({
          key: `${undirectedKey}:bundle`,
          edgeKey: `${undirectedKey}:bundle`,
          links: mergedLinks,
          primaryLink: mergedLinks[0],
          source,
          target,
          labelLines: [commonLabel],
          strokeWidth,
          edgeTypeClass: isBundleSelected ? 'edge-bundle-bidirectional-selected' : 'edge-bundle-bidirectional',
          dirClass: isBundleSelected ? 'edge-flow-bidirectional' : '',
          faded,
          isDirect: isBundleSelected,
          showDirectStyling: false,
          isBidirectionalBundle: true,
          parallelIndex: 0,
          parallelTotal: 1,
          sharedSourcePort: null,
          sharedTargetPort: null,
          directionality: 'both',
          bundleColor: 'purple'
        });
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

       // In focus mode (always active), fade all edges EXCEPT those with outgoing/incoming dirClass or when no node selected
       let faded = false;
       if (pivotNodeId) {
         faded = !dirClass; // Only keep non-faded if dirClass is set
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

      // Classify edge directionality and assign bundle color
      const directionality = classifyEdgeDirectionality(sourceId, targetId, pivotNodeId);
      const bundleColor = getBundleColor(directionality);

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
        showDirectStyling,
        isBidirectionalBundle: false,
        parallelIndex: 0,
        parallelTotal: 1,
        sharedSourcePort: null,
        sharedTargetPort: null,
        directionality,
        bundleColor
      });
    }

    if (edgeMode === 'grouped') {
      // Analyze colors per node+side to assign discrete port positions
      const colorsByNodeSide = new Map<string, Set<string>>();
      const colorGroupsPerNodeSide = new Map<string, Array<{ color: string; position: 'begin' | 'middle' | 'end' }>>();

      // Count unique colors for each node + side combination
      for (const item of items) {
        // Source side
        const sourceKey = `${item.source.id}|source`;
        if (!colorsByNodeSide.has(sourceKey)) {
          colorsByNodeSide.set(sourceKey, new Set());
        }
        colorsByNodeSide.get(sourceKey)!.add(item.bundleColor);

        // Target side
        const targetKey = `${item.target.id}|target`;
        if (!colorsByNodeSide.has(targetKey)) {
          colorsByNodeSide.set(targetKey, new Set());
        }
        colorsByNodeSide.get(targetKey)!.add(item.bundleColor);
      }

      // Assign port positions based on color count
      for (const [key, colors] of colorsByNodeSide.entries()) {
        const colorArray = Array.from(colors).sort();
        let positions: Array<{ color: string; position: 'begin' | 'middle' | 'end' }>;

        if (colorArray.length === 1) {
          // 1 color: use middle port only
          positions = [{ color: colorArray[0], position: 'middle' }];
        } else if (colorArray.length === 2) {
          // 2 colors: use begin and end, skip middle
          // Purple gets preference for first position if present
          const hasPurple = colorArray.includes('purple');
          if (hasPurple) {
            const other = colorArray.find(c => c !== 'purple')!;
            positions = [
              { color: 'purple', position: 'begin' },
              { color: other, position: 'end' }
            ];
          } else {
            positions = [
              { color: colorArray[0], position: 'begin' },
              { color: colorArray[1], position: 'end' }
            ];
          }
        } else {
          // 3+ colors: use all ports, purple goes to middle
          const purpleIdx = colorArray.indexOf('purple');
          if (purpleIdx !== -1) {
            // Remove purple and assign it to middle
            const others = colorArray.filter(c => c !== 'purple');
            positions = [
              { color: others[0] ?? 'default', position: 'begin' },
              { color: 'purple', position: 'middle' },
              { color: others[1] ?? 'default', position: 'end' }
            ];
          } else {
            positions = [
              { color: colorArray[0], position: 'begin' },
              { color: colorArray[1], position: 'middle' },
              { color: colorArray[2], position: 'end' }
            ];
          }
        }

        colorGroupsPerNodeSide.set(key, positions);
      }

      const portAxisQuantum = 6;
      const quantizePortAxis = (value: number) => Math.round(value / portAxisQuantum);
      const portSignature = (point: AnchorPoint) => {
        const axis = point.side === 'left' || point.side === 'right' ? point.y : point.x;
        return `${point.side}:${quantizePortAxis(axis)}`;
      };

      // Helper to get port position for a color on a node side
      const getPortPosition = (nodeId: string, direction: 'source' | 'target', color: string): 'begin' | 'middle' | 'end' => {
        const key = `${nodeId}|${direction}`;
        const groups = colorGroupsPerNodeSide.get(key) || [];
        const group = groups.find(g => g.color === color);
        return group?.position || 'middle';
      };

      const baseAnchorsByItem = new Map<string, { start: AnchorPoint; end: AnchorPoint }>();
      for (const item of items) {
        const sourcePortPos = getPortPosition(item.source.id, 'source', item.bundleColor);
        const targetPortPos = getPortPosition(item.target.id, 'target', item.bundleColor);
        const forcedPortSides = resolveSugiyamaInOutNeighborPortSides(item);

        const anchors = getAnchoredEndpoints(
          item.source,
          item.target,
          nodeSizes,
          item.parallelIndex,
          item.parallelTotal,
          orthogonalPorts,
          item.sharedSourcePort,
          item.sharedTargetPort,
          'middle',
          'middle',
          forcedPortSides.source,
          forcedPortSides.target
        );
        baseAnchorsByItem.set(item.key, { start: anchors.start, end: anchors.end });
      }
      // Bundle outgoing edges only when source + label + source-port match.
      const outgoingBySourceLabelPort = new Map<string, EdgeRenderItem[]>();
      for (const item of items) {
        if (item.labelLines.length !== 1) {
          continue;
        }
        const normalized = item.labelLines[0].trim().toLowerCase();
        if (!normalized) {
          continue;
        }
        const anchors = baseAnchorsByItem.get(item.key);
        if (!anchors) {
          continue;
        }
        const key = `${item.source.id}|${normalized}|${portSignature(anchors.start)}`;
        const arr = outgoingBySourceLabelPort.get(key) ?? [];
        arr.push(item);
        outgoingBySourceLabelPort.set(key, arr);
      }
      for (const groupItems of outgoingBySourceLabelPort.values()) {
        if (groupItems.length < 2) {
          continue;
        }
        const anchor = baseAnchorsByItem.get(groupItems[0].key)?.start;
        if (!anchor) {
          continue;
        }
        const sharedPort: AnchorPoint = { x: anchor.x, y: anchor.y, side: anchor.side };
        for (const item of groupItems) {
          item.sharedSourcePort = sharedPort;
        }
      }
      // Bundle incoming edges only when target + label + target-port match.
      const incomingByTargetLabelPort = new Map<string, EdgeRenderItem[]>();
      for (const item of items) {
        if (item.labelLines.length !== 1) {
          continue;
        }
        const normalized = item.labelLines[0].trim().toLowerCase();
        if (!normalized) {
          continue;
        }
        const anchors = baseAnchorsByItem.get(item.key);
        if (!anchors) {
          continue;
        }
        const key = `${item.target.id}|${normalized}|${portSignature(anchors.end)}`;
        const arr = incomingByTargetLabelPort.get(key) ?? [];
        arr.push(item);
        incomingByTargetLabelPort.set(key, arr);
      }
      for (const groupItems of incomingByTargetLabelPort.values()) {
        if (groupItems.length < 2) {
          continue;
        }
        const anchor = baseAnchorsByItem.get(groupItems[0].key)?.end;
        if (!anchor) {
          continue;
        }
        const sharedPort: AnchorPoint = { x: anchor.x, y: anchor.y, side: anchor.side };
        for (const item of groupItems) {
          item.sharedTargetPort = sharedPort;
        }
      }

      // Fallback for non-Sugiyama bidirectional bundles.
      for (const item of items) {
        if (!item.isBidirectionalBundle || item.sharedSourcePort || item.sharedTargetPort) {
          continue;
        }
        const anchors = baseAnchorsByItem.get(item.key);
        if (anchors) {
          item.sharedSourcePort = { x: anchors.start.x, y: anchors.start.y, side: anchors.start.side };
          item.sharedTargetPort = { x: anchors.end.x, y: anchors.end.y, side: anchors.end.side };
        }
      }
    }
    return items;
  }, [
    renderLinks,
    nodeMap,
    highlightState,
    dimSet,
    pivotNodeId,
    nodeSizes,
    edgeMode,
    orthogonalPorts,
    useSugiyamaLocalLayout,
    sugiyamaPivotNodeId,
    sugiyamaInOutNeighborIds,
  ]);

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
      const isActive =
        item.dirClass === 'edge-flow-incoming' ||
        item.dirClass === 'edge-flow-outgoing' ||
        item.dirClass === 'edge-flow-bidirectional';
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
      const isActive =
        item.dirClass === 'edge-flow-incoming' ||
        item.dirClass === 'edge-flow-outgoing' ||
        item.dirClass === 'edge-flow-bidirectional';
      if (!isActive || seen.has(item.key)) {
        continue;
      }
      seen.add(item.key);
      items.push(item);
    }
    return items;
  }, [displayedNonHighlightedEdgeItems, displayedHighlightedEdgeItems]);

  const purpleHybridState = useMemo(() => {
    const hints = new Map<string, PurpleHybridEdgeHint>();
    const fadedTrunks: PurpleHybridTrunkItem[] = [];
    const emphasizedTrunks: PurpleHybridTrunkItem[] = [];

    if (!useSugiyamaLocalLayout || !sugiyamaPivotNodeId || detailLayoutMode !== 'sugiyama') {
      return { hints, fadedTrunks, emphasizedTrunks };
    }

    const pivotNode = nodeMap.get(sugiyamaPivotNodeId);
    if (!pivotNode) {
      return { hints, fadedTrunks, emphasizedTrunks };
    }

    const pivotRect = getNodeRect(pivotNode, nodeSizes);
    const pivotCenterY = pivotRect.y + pivotRect.height / 2;

    type Candidate = {
      item: EdgeRenderItem;
      outgoingFromPivot: boolean;
      pivotIsSource: boolean;
      neighbor: SimNode;
      verticalSide: 'top' | 'bottom';
      bundleKey: string;
    };

    const candidates: Candidate[] = [];
    for (const item of edgeRenderItems) {
      if (item.bundleColor !== 'purple') {
        continue;
      }

      let outgoingFromPivot: boolean;
      let pivotIsSource: boolean;
      let neighbor: SimNode;
      if (item.source.id === sugiyamaPivotNodeId && sugiyamaInOutNeighborIds.has(item.target.id)) {
        pivotIsSource = true;
        outgoingFromPivot = true;
        neighbor = item.target;
      } else if (item.target.id === sugiyamaPivotNodeId && sugiyamaInOutNeighborIds.has(item.source.id)) {
        pivotIsSource = false;
        // For bidirectional bundles, always draw trunk from pivot and tail to neighbor.
        outgoingFromPivot = item.isBidirectionalBundle ? true : false;
        neighbor = item.source;
      } else {
        continue;
      }

      const neighborRect = getNodeRect(neighbor, nodeSizes);
      const neighborCenterY = neighborRect.y + neighborRect.height / 2;
      const verticalSide: 'top' | 'bottom' = neighborCenterY < pivotCenterY ? 'top' : 'bottom';
      const bundleKey = `${verticalSide}|${(item.labelLines.join('|') || item.edgeKey).toLowerCase()}`;
      candidates.push({ item, outgoingFromPivot, pivotIsSource, neighbor, verticalSide, bundleKey });
    }

    const bundleGroups = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      const arr = bundleGroups.get(candidate.bundleKey) ?? [];
      arr.push(candidate);
      bundleGroups.set(candidate.bundleKey, arr);
    }

    const sideBundleKeys = new Map<'top' | 'bottom', string[]>();
    sideBundleKeys.set('top', []);
    sideBundleKeys.set('bottom', []);
    for (const key of bundleGroups.keys()) {
      const side = key.startsWith('top|') ? 'top' : 'bottom';
      sideBundleKeys.get(side)?.push(key);
    }
    for (const side of ['top', 'bottom'] as const) {
      sideBundleKeys.get(side)?.sort();
    }

    const bundleAnchorByKey = new Map<string, AnchorPoint>();
    const bundleJunctionByKey = new Map<string, { x: number; y: number }>();
    for (const side of ['top', 'bottom'] as const) {
      const keys = sideBundleKeys.get(side) ?? [];
      const total = Math.max(1, keys.length);
      for (let index = 0; index < keys.length; index += 1) {
        const factor = total === 1 ? 0.5 : (index + 1) / (total + 1);
        const guard = 8;
        const x = clamp(pivotRect.x + guard + (pivotRect.width - 2 * guard) * factor, pivotRect.x + guard, pivotRect.x + pivotRect.width - guard);
        const y = side === 'top' ? pivotRect.y : pivotRect.y + pivotRect.height;
        const anchor: AnchorPoint = { x, y, side, portPosition: 'middle' };
        bundleAnchorByKey.set(keys[index], anchor);

        const sideNormal = side === 'top' ? { x: 0, y: -1 } : { x: 0, y: 1 };
        const group = bundleGroups.get(keys[index]) ?? [];
        let minDistance = Number.POSITIVE_INFINITY;
        for (const candidate of group) {
          const neighborRect = getNodeRect(candidate.neighbor, nodeSizes);
          const neighborCenterX = neighborRect.x + neighborRect.width / 2;
          const neighborCenterY = neighborRect.y + neighborRect.height / 2;
          minDistance = Math.min(minDistance, Math.hypot(neighborCenterX - x, neighborCenterY - y));
        }
        const trunkLength = Number.isFinite(minDistance) ? clamp(minDistance * 0.33, 32, 110) : 58;
        bundleJunctionByKey.set(keys[index], { x: x + sideNormal.x * trunkLength, y: y + sideNormal.y * trunkLength });
      }
    }

    for (const [bundleKey, group] of bundleGroups.entries()) {
      const anchor = bundleAnchorByKey.get(bundleKey);
      const junction = bundleJunctionByKey.get(bundleKey);
      if (!anchor || !junction || group.length === 0) {
        continue;
      }

      const sample = group[0].item;
      const avgStroke = group.reduce((sum, candidate) => sum + candidate.item.strokeWidth, 0) / group.length;
      const trunkWidth = assignBundleThickness(sample.links, avgStroke, group.length);
      const trunk: PurpleHybridTrunkItem = {
        key: `purple-trunk:${bundleKey}`,
        pathD: `M ${anchor.x} ${anchor.y} L ${junction.x} ${junction.y}`,
        className: `edge ${sample.edgeTypeClass} ${sample.dirClass} ${sample.faded ? 'edge-dim' : ''}`,
        strokeWidth: trunkWidth,
        opacity: sample.faded ? dimmedEdgeOpacity : undefined,
        faded: sample.faded,
      };

      if (sample.faded) {
        fadedTrunks.push(trunk);
      } else {
        emphasizedTrunks.push(trunk);
      }

      for (const candidate of group) {
        hints.set(candidate.item.key, {
          pivotX: anchor.x,
          pivotY: anchor.y,
          junctionX: junction.x,
          junctionY: junction.y,
          outgoingFromPivot: candidate.outgoingFromPivot,
          pivotIsSource: candidate.pivotIsSource,
        });
      }
    }

    return { hints, fadedTrunks, emphasizedTrunks };
  }, [
    useSugiyamaLocalLayout,
    sugiyamaPivotNodeId,
    detailLayoutMode,
    nodeMap,
    nodeSizes,
    edgeRenderItems,
    sugiyamaInOutNeighborIds,
    dimmedEdgeOpacity,
  ]);

  const edgeLabelPositions = useMemo(() => {
    const lineHeight = 13;
    const placements: Array<{ key: string; x: number; y: number; w: number; h: number }> = [];
    const byKey = new Map<string, { x: number; y: number }>();
    const overlapCounts = new Map<string, number>();

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
      const forcedPortSides = resolveSugiyamaInOutNeighborPortSides(item);
      const { start, end } = getAnchoredEndpoints(
        item.source,
        item.target,
        nodeSizes,
        item.parallelIndex,
        item.parallelTotal,
        orthogonalPorts,
        item.sharedSourcePort,
        item.sharedTargetPort,
        'middle',
        'middle',
        forcedPortSides.source,
        forcedPortSides.target
      );
      const purpleHint = purpleHybridState.hints.get(item.key);
      let baseX = (start.x + end.x) / 2;
      let baseY = (start.y + end.y) / 2;
      if (purpleHint) {
        // Keep the label centered on the actual purple bundled trunk segment.
        baseX = (purpleHint.pivotX + purpleHint.junctionX) / 2;
        baseY = (purpleHint.pivotY + purpleHint.junctionY) / 2;
      }
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
      overlapCounts.set(item.key, attempts);
    }

    return { positions: byKey, overlapCounts };
  }, [emphasizedEdgeItems, nodeSizes, orthogonalPorts, highlightedNodeIds, nodeMap, purpleHybridState]);

  const groupedLabelState = useMemo(() => {
    const GROUP_DELIM = '\u0001';
    const suppressInlineLabels = new Set<string>();
    const aggregatedLabels: Array<{ key: string; x: number; y: number; text: string; edgeTypeClass: string; dirClass: string }> = [];
    const rawAggregatedLabels: Array<{
      key: string;
      x: number;
      y: number;
      text: string;
      edgeTypeClass: string;
      dirClass: string;
      nodeId: string;
      side: NodeSide;
    }> = [];

    if (edgeMode !== 'grouped') {
      return { suppressInlineLabels, aggregatedLabels };
    }

    const outgoingGroups = new Map<string, EdgeRenderItem[]>();
    const incomingGroups = new Map<string, EdgeRenderItem[]>();
    const bidirectionalGroups = new Map<string, {
      ownerNode: SimNode;
      ownerPort: AnchorPoint;
      label: string;
      edgeTypeClass: string;
      dirClass: string;
    }>();

    const placeLabelAwayFromNode = (node: SimNode, baseX: number, baseY: number, side: NodeSide, text: string) => {
      const rect = getNodeRect(node, nodeSizes);
      const labelWidth = Math.max(92, text.length * 6.4 + 26);
      const labelHeight = 20;

      const sideVector: Record<NodeSide, { x: number; y: number }> = {
        top: { x: 0, y: -1 },
        bottom: { x: 0, y: 1 },
        left: { x: -1, y: 0 },
        right: { x: 1, y: 0 }
      };

      const vector = sideVector[side];
      let x = baseX + vector.x * 28;
      let y = baseY + vector.y * 28;

      const intersectsNode = (cx: number, cy: number) => {
        const halfW = labelWidth / 2;
        const halfH = labelHeight / 2;
        return !(
          cx + halfW < rect.x ||
          cx - halfW > rect.x + rect.width ||
          cy + halfH < rect.y ||
          cy - halfH > rect.y + rect.height
        );
      };

      // Push outward until the label no longer overlaps its own node.
      let guard = 0;
      while (intersectsNode(x, y) && guard < 10) {
        x += vector.x * 10;
        y += vector.y * 10;
        guard += 1;
      }

      return { x, y };
    };

    // Group edges by available shared join point; each side can independently define a bundle.
    for (const item of emphasizedEdgeItems) {
      if (item.faded || item.labelLines.length !== 1) {
        continue;
      }
      const label = item.labelLines[0].trim();
      if (!label) {
        continue;
      }

      if (item.isBidirectionalBundle) {
        suppressInlineLabels.add(item.key);

        let ownerNode = item.source;
        let ownerPort = item.sharedSourcePort;

        // Prefer the selected-node end so purple labels are placed at the shared end in focus.
        if (pivotNodeId && item.target.id === pivotNodeId && item.sharedTargetPort) {
          ownerNode = item.target;
          ownerPort = item.sharedTargetPort;
        } else if (pivotNodeId && item.source.id === pivotNodeId && item.sharedSourcePort) {
          ownerNode = item.source;
          ownerPort = item.sharedSourcePort;
        } else if (!ownerPort && item.sharedTargetPort) {
          ownerNode = item.target;
          ownerPort = item.sharedTargetPort;
        }

        if (ownerPort) {
          const portX = Math.round(ownerPort.x);
          const portY = Math.round(ownerPort.y);
          const bidirKey = `${ownerNode.id}|${label}|${ownerPort.side}|${portX}|${portY}`;
          if (!bidirectionalGroups.has(bidirKey)) {
            bidirectionalGroups.set(bidirKey, {
              ownerNode,
              ownerPort,
              label,
              edgeTypeClass: item.edgeTypeClass,
              dirClass: item.dirClass
            });
          }
        }
        continue;
      }

      if (item.sharedSourcePort) {
        const outgoingKey = ['out', item.source.id, label, item.sharedSourcePort.side].join(GROUP_DELIM);
        const outArr = outgoingGroups.get(outgoingKey) ?? [];
        outArr.push(item);
        outgoingGroups.set(outgoingKey, outArr);
      }

      // Bidirectional bundles must aggregate on one side only (source/outgoing).
      if (item.sharedTargetPort && !item.isBidirectionalBundle) {
        const incomingKey = ['in', item.target.id, label, item.sharedTargetPort.side].join(GROUP_DELIM);
        const inArr = incomingGroups.get(incomingKey) ?? [];
        inArr.push(item);
        incomingGroups.set(incomingKey, inArr);
      }
    }

    for (const [groupKey, items] of outgoingGroups.entries()) {
      for (const item of items) {
        suppressInlineLabels.add(item.key);
      }

      const sharedPort = items[0].sharedSourcePort;
      if (!sharedPort) {
        continue;
      }
      const label = items[0].labelLines[0].trim();
      const positioned = placeLabelAwayFromNode(items[0].source, sharedPort.x, sharedPort.y, sharedPort.side, label);
      rawAggregatedLabels.push({
        key: `grouped-out-${groupKey}`,
        x: positioned.x,
        y: positioned.y,
        text: label,
        edgeTypeClass: items[0].edgeTypeClass,
        dirClass: items[0].dirClass,
        nodeId: items[0].source.id,
        side: sharedPort.side
      });
    }

    for (const [groupKey, items] of incomingGroups.entries()) {
      for (const item of items) {
        suppressInlineLabels.add(item.key);
      }
      const sharedPort = items[0].sharedTargetPort;
      // Skip incoming labels for bidirectional bundles; they get label from outgoing
      if (items[0].isBidirectionalBundle) {
        continue;
      }
      if (!sharedPort) {
        continue;
      }
      const label = items[0].labelLines[0].trim();
      const positioned = placeLabelAwayFromNode(items[0].target, sharedPort.x, sharedPort.y, sharedPort.side, label);
      rawAggregatedLabels.push({
        key: `grouped-in-${groupKey}`,
        x: positioned.x,
        y: positioned.y,
        text: label,
        edgeTypeClass: items[0].edgeTypeClass,
        dirClass: items[0].dirClass,
        nodeId: items[0].target.id,
        side: sharedPort.side
      });
    }

    for (const [groupKey, group] of bidirectionalGroups.entries()) {
      const positioned = placeLabelAwayFromNode(
        group.ownerNode,
        group.ownerPort.x,
        group.ownerPort.y,
        group.ownerPort.side,
        group.label
      );
      rawAggregatedLabels.push({
        key: `grouped-bidir-${groupKey}`,
        x: positioned.x,
        y: positioned.y,
        text: group.label,
        edgeTypeClass: group.edgeTypeClass,
        dirClass: group.dirClass,
        nodeId: group.ownerNode.id,
        side: group.ownerPort.side
      });
    }

    const labelsByNodeSide = new Map<string, typeof rawAggregatedLabels>();
    for (const label of rawAggregatedLabels) {
      const key = `${label.nodeId}|${label.side}`;
      const arr = labelsByNodeSide.get(key) ?? [];
      arr.push(label);
      labelsByNodeSide.set(key, arr);
    }

    const stackGap = 6;
    const stackStep = 10;
    const labelHeight = 20;
    const labelWidth = (text: string) => Math.max(92, text.length * 6.4 + 26);
    const sideVector: Record<NodeSide, { x: number; y: number }> = {
      top: { x: 0, y: -1 },
      bottom: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 }
    };

    const overlaps = (
      ax: number,
      ay: number,
      aw: number,
      ah: number,
      bx: number,
      by: number,
      bw: number,
      bh: number
    ) => Math.abs(ax - bx) < (aw + bw) / 2 + stackGap && Math.abs(ay - by) < (ah + bh) / 2 + stackGap;

    for (const group of labelsByNodeSide.values()) {
      const side = group[0].side;
      const tangentAxis: 'x' | 'y' = side === 'top' || side === 'bottom' ? 'x' : 'y';
      const vector = sideVector[side];
      const placed: Array<{ x: number; y: number; w: number; h: number }> = [];

      // Preserve side order, but resolve collisions by shifting along bundle direction.
      group.sort((a, b) => (tangentAxis === 'x' ? a.x - b.x : a.y - b.y));

      for (const label of group) {
        const w = labelWidth(label.text);
        const h = labelHeight;
        let nextX = label.x;
        let nextY = label.y;
        let guard = 0;

        while (placed.some((p) => overlaps(nextX, nextY, w, h, p.x, p.y, p.w, p.h)) && guard < 20) {
          nextX += vector.x * stackStep;
          nextY += vector.y * stackStep;
          guard += 1;
        }

        label.x = nextX;
        label.y = nextY;
        placed.push({ x: nextX, y: nextY, w, h });
      }
    }

    for (const label of rawAggregatedLabels) {
      aggregatedLabels.push({
        key: label.key,
        x: label.x,
        y: label.y,
        text: label.text,
        edgeTypeClass: label.edgeTypeClass,
        dirClass: label.dirClass
      });
    }

    return { suppressInlineLabels, aggregatedLabels };
  }, [emphasizedEdgeItems, edgeMode, nodeSizes, pivotNodeId]);

  const manhattanLineJumps = useMemo(() => {
    const jumps = new Map<string, LineJumpPoint[]>();
    if (routingMode !== 'manhattan') {
      return jumps;
    }

    const endpointExclusion = 20;

    const routes = emphasizedEdgeItems.map((item) => ({
      key: item.key,
      points: manhattanRoutePoints(
        item.source,
        item.target,
        nodeSizes,
        orthogonalPorts,
        item.parallelIndex,
        item.parallelTotal,
        item.sharedSourcePort,
        item.sharedTargetPort
      )
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
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      return;
    }

    if (syncingTransformFromScrollRef.current) {
      syncingTransformFromScrollRef.current = false;
      return;
    }

    const k = transform.k;
    const worldX = -transform.x / k;
    const worldY = -transform.y / k;
    const maxLeft = Math.max(0, scrollContentSize.width - canvasWidth);
    const maxTop = Math.max(0, scrollContentSize.height - canvasHeight);
    const targetLeft = clamp((worldX - scrollWorldBounds.minX) * k, 0, maxLeft);
    const targetTop = clamp((worldY - scrollWorldBounds.minY) * k, 0, maxTop);

    syncingScrollFromTransformRef.current = true;
    if (Math.abs(viewport.scrollLeft - targetLeft) > 0.5) {
      viewport.scrollLeft = targetLeft;
    }
    if (Math.abs(viewport.scrollTop - targetTop) > 0.5) {
      viewport.scrollTop = targetTop;
    }

    const rafId = window.requestAnimationFrame(() => {
      syncingScrollFromTransformRef.current = false;
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [transform, scrollWorldBounds, scrollContentSize, canvasWidth, canvasHeight]);

    useEffect(() => {
      if (typeof window === 'undefined') {
        return;
      }
      const prefs: GraphUiPrefs = {
        focusDimStrength,
        autoZoomEnabled,
        showDirectEdges,
        orthogonalPorts,
        routingMode,
        edgeMode,
        showHelpPanel,
        showLegendPanel,
        helpPanelPos,
        legendPanelPos,
        cameraTransform: { x: transform.x, y: transform.y, k: transform.k },
        selectedNodeId,
        toolbarPosition,
        detailLayoutMode
      };
      try {
        window.localStorage.setItem(GRAPH_UI_PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // Ignore storage quota/privacy mode errors and keep UI responsive.
      }
    }, [focusDimStrength, autoZoomEnabled, showDirectEdges, orthogonalPorts, routingMode, edgeMode, showHelpPanel, showLegendPanel, helpPanelPos, legendPanelPos, transform, selectedNodeId, toolbarPosition, detailLayoutMode]);

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
    const validNodeIds = new Set(activeGraph.nodes.map((n) => n.id));
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
  }, [activeGraph.nodes]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const state = dragStateRef.current;
      if (!state || !stageRef.current) {
        return;
      }
      const dragStart = dragStartClientRef.current;
      if (dragStart && !dragMovedRef.current) {
        const dx = event.clientX - dragStart.x;
        const dy = event.clientY - dragStart.y;
        if (Math.hypot(dx, dy) > 4) {
          dragMovedRef.current = true;
        }
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
        if (dragMovedRef.current) {
          suppressNextNodeClickRef.current = true;
          window.setTimeout(() => {
            suppressNextNodeClickRef.current = false;
          }, 0);
        }
        dragMovedRef.current = false;
        dragStartClientRef.current = null;
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
    const duration = pendingFocusDurationRef.current;
    const focusScale = pendingFocusScaleRef.current ?? transform.k;
    panToNode(node, focusScale, duration);
    setSelectedNodeId(node.id);
    pendingFocusScaleRef.current = null;
    setPendingFocusId(null);
  }, [pendingFocusId, nodeMap, transform.k]);

  useEffect(() => {
    if (!useSugiyamaLocalLayout || !sugiyamaPivotNodeId) {
      lastSugiyamaCenteredPivotRef.current = null;
      return;
    }
    if (lastSugiyamaCenteredPivotRef.current === sugiyamaPivotNodeId) {
      return;
    }
    const pivotNode = nodeMap.get(sugiyamaPivotNodeId);
    if (!pivotNode) {
      return;
    }
    lastSugiyamaCenteredPivotRef.current = sugiyamaPivotNodeId;
    panToNode(pivotNode, transform.k, 220);
  }, [useSugiyamaLocalLayout, sugiyamaPivotNodeId, nodeMap, transform.k]);

  useEffect(() => {
    if (!isLocalContext || !localRootNodeId || nodesWithManualPositions.length === 0) {
      lastLocalGraphCenteredKeyRef.current = null;
      return;
    }

    const centerKey = `${localRootNodeId}|${detailLayoutMode}|${nodesWithManualPositions.length}`;
    if (lastLocalGraphCenteredKeyRef.current === centerKey) {
      return;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const node of nodesWithManualPositions) {
      const measured = nodeSizes.get(node.id);
      const nodeWidth = measured?.width ?? 190;
      const nodeHeight = measured?.height ?? 48;
      const cx = node.x + nodeWidth / 2;
      const cy = node.y + nodeHeight / 2;
      minX = Math.min(minX, cx);
      minY = Math.min(minY, cy);
      maxX = Math.max(maxX, cx);
      maxY = Math.max(maxY, cy);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return;
    }

    lastLocalGraphCenteredKeyRef.current = centerKey;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    panToWorldPoint(centerX, centerY, transform.k, 220);
  }, [
    isLocalContext,
    localRootNodeId,
    detailLayoutMode,
    nodesWithManualPositions,
    nodeSizes,
    transform.k,
  ]);

  // Auto-fit viewport on first load or data change
  const hasInitialFitRef = useRef(!isIdentityTransform(transform));
  const lastNodeCountRef = useRef(0);
  
  useEffect(() => {
    // Reset fit flag if node count changed significantly (e.g., new file loaded)
    const currentNodeCount = nodesWithManualPositions.length;
    const nodeCountChanged = Math.abs(currentNodeCount - lastNodeCountRef.current) > Math.max(5, currentNodeCount * 0.1);
    if (nodeCountChanged) {
      hasInitialFitRef.current = false;
      lastNodeCountRef.current = currentNodeCount;
    }

    if (!autoZoomEnabled) {
      return;
    }

    if (!svgRef.current || !zoomBehaviorRef.current || hasInitialFitRef.current || currentNodeCount === 0) {
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
      .ease(easeCubicOut)
      .call(zoomBehaviorRef.current.transform as never, targetTransform);

    hasInitialFitRef.current = true;
  }, [nodesWithManualPositions.length, width, height, autoZoomEnabled]);

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

   function panToWorldPoint(worldX: number, worldY: number, zoomScale: number, duration = 280) {
     if (!svgRef.current || !zoomBehaviorRef.current) {
       return;
     }
     const tx = canvasWidth / 2 - (worldX * zoomScale);
     const ty = canvasHeight / 2 - (worldY * zoomScale);
     const targetTransform = zoomIdentity.translate(tx, ty).scale(zoomScale);

     select(svgRef.current)
       .transition()
       .duration(duration)
       .ease(easeCubicOut)
       .call(zoomBehaviorRef.current.transform as never, targetTransform);
   }

   function panToNode(node: SimNode, zoomScale: number, duration = 280) {
     const nodeX = node.x + 85;
     const nodeY = node.y + 24;
     panToWorldPoint(nodeX, nodeY, zoomScale, duration);
   }

   function jumpToNode(node: SimNode, zoomScale: number = 1) {
     if (!svgRef.current || !zoomBehaviorRef.current) {
       return;
     }
     const nodeX = node.x + 85;
     const nodeY = node.y + 24;
      const tx = canvasWidth / 2 - (nodeX * zoomScale);
      const ty = canvasHeight / 2 - (nodeY * zoomScale);
     const targetTransform = zoomIdentity.translate(tx, ty).scale(zoomScale);
     // Immediate jump without animation
     select(svgRef.current).call(zoomBehaviorRef.current.transform as never, targetTransform);
   }

   const enterLocalContext = useCallback((nodeId: string) => {
     if (!isLocalContext) {
       preLocalTransformRef.current = transform;
       // Capture current node positions as exit targets
       const positions = new Map<string, { x: number; y: number }>();
       for (const node of nodesWithManualPositions) {
         positions.set(node.id, { x: node.x, y: node.y });
       }
       preLocalNodePositionsRef.current = positions;
     }
     setIsLocalContext(true);
     setLocalRootNodeId(nodeId);
     setSelectedNodeId(nodeId);
     setHoveredNodeId(null);
     pendingFocusDurationRef.current = 280;
     setPendingFocusId(nodeId);
   }, [isLocalContext, transform, nodesWithManualPositions]);

   const exitLocalContext = useCallback(() => {
     if (!isLocalContext) {
       return;
     }
     const exitingRootNodeId = localRootNodeId;
     const restoreTransform = preLocalTransformRef.current;
     const savedPositions = preLocalNodePositionsRef.current;

     // Restore node positions: apply them as manual positions for animation back
     if (savedPositions && savedPositions.size > 0) {
       setManualPositions(new Map(savedPositions));
     }

     setIsLocalContext(false);
     setLocalRootNodeId(null);
     setSelectedNodeId(null);
     setHoveredNodeId(null);
     preLocalTransformRef.current = null;
     preLocalNodePositionsRef.current = null;

     if (exitingRootNodeId) {
       pendingFocusDurationRef.current = 340;
       pendingFocusScaleRef.current = restoreTransform?.k ?? transform.k;
       setPendingFocusId(exitingRootNodeId);
     }
   }, [isLocalContext, localRootNodeId, transform.k]);

  function resetZoomView() {
    if (!svgRef.current || !zoomBehaviorRef.current) {
      return;
    }
    const resetScale = 1;

    if (selectedNodeId) {
      const selectedNode = nodeMap.get(selectedNodeId);
      if (selectedNode) {
        panToNode(selectedNode, resetScale, 260);
        return;
      }
    }

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

    const targetTransform =
      Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)
        ? (() => {
            const centerX = (minX + maxX) / 2;
            const centerY = (minY + maxY) / 2;
            const tx = width / 2 - centerX * resetScale;
            const ty = height / 2 - centerY * resetScale;
            return zoomIdentity.translate(tx, ty).scale(resetScale);
          })()
        : zoomIdentity;

    select(svgRef.current)
      .transition()
      .duration(240)
      .ease(easeCubicInOut)
      .call(zoomBehaviorRef.current.transform as never, targetTransform);
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
          if (isLocalContext) {
            exitLocalContext();
          } else {
            // Immediately jump to selected node before clearing selection
            if (selectedNodeId) {
              const selectedNode = nodeMap.get(selectedNodeId);
              if (selectedNode) {
                jumpToNode(selectedNode, 1);
              }
            }
            setSelectedNodeId(null);
            setHoveredNodeId(null);
          }
          return;
        }
        if (event.key === 'r' || event.key === 'R') {
          event.preventDefault();
          resetZoomView();
        }
      }

      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [isLocalContext, exitLocalContext, selectedNodeId, nodeMap]);

  function renderNodeCard(node: SimNode) {
    const faded = dimSet ? !dimSet.has(node.id) : false;
    const isPivot = pivotNodeId === node.id;
    const isNeighbor = Boolean(dimSet?.has(node.id) && !isPivot);
    return (
      <button
        ref={getNodeRefCallback(node.id)}
        type="button"
        key={node.id}
        className={`node-card ${node.type} ${isLocalContext ? 'node-card-local' : ''} ${faded ? 'node-dim' : ''} ${selectedNodeId === node.id ? 'node-selected' : ''} ${isPivot ? 'node-pivot' : ''} ${isNeighbor ? 'node-neighbor' : ''} ${draggingNodeId === node.id ? 'node-dragging' : ''}`}
        style={{
          transform: `translate(${node.x}px, ${node.y}px)`,
          backgroundColor: getCategoryColor(node.dominant_category),
          opacity: faded ? dimmedNodeOpacity : undefined
        }}
        onPointerDown={(event) => {
          if (node.type !== 'table' || !stageRef.current || useSugiyamaLocalLayout) {
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
          dragStartClientRef.current = { x: event.clientX, y: event.clientY };
          dragMovedRef.current = false;
          setDraggingNodeId(node.id);
        }}
        onMouseEnter={() => setHoveredNodeId(node.id)}
        onMouseLeave={() => setHoveredNodeId((id) => (id === node.id ? null : id))}
        onClick={() => {
          if (suppressNextNodeClickRef.current) {
            suppressNextNodeClickRef.current = false;
            return;
          }
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
          setSelectedNodeId(node.id);
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (node.isCluster) {
            return;
          }
          enterLocalContext(node.id);
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
    const forcedPortSides = resolveSugiyamaInOutNeighborPortSides(item);
    const anchors = getAnchoredEndpoints(
      item.source,
      item.target,
      nodeSizes,
      item.parallelIndex,
      item.parallelTotal,
      orthogonalPorts,
      item.sharedSourcePort,
      item.sharedTargetPort,
      'middle',
      'middle',
      forcedPortSides.source,
      forcedPortSides.target
    );
    const { start, end } = anchors;
    const sx = start.x;
    const sy = start.y;
    const tx = end.x;
    const ty = end.y;
    const defaultLabelX = (sx + tx) / 2;
    const defaultLabelY = (sy + ty) / 2;
    const adjusted = edgeLabelPositions.positions.get(item.key);
    const labelX = adjusted?.x ?? defaultLabelX;
    const labelY = adjusted?.y ?? defaultLabelY;
    const longestLabel = item.labelLines.reduce((max, text) => Math.max(max, text.length), 0);
    const labelWidth = Math.max(longestLabel * 6.3 + 26, 52);
    const lineHeight = 13;
    const labelHeight = Math.max(18, item.labelLines.length * lineHeight + 8);
    const labelTop = labelY - labelHeight / 2;

    const defaultPathD =
      routingMode === 'manhattan'
        ? manhattanEdgePath(
            item.source,
            item.target,
            nodeSizes,
            orthogonalPorts,
            item.parallelIndex,
            item.parallelTotal,
            item.sharedSourcePort,
            item.sharedTargetPort,
            forcedPortSides.source,
            forcedPortSides.target
          )
        : routingMode === 'octolinear'
          ? octolinearEdgePath(
              item.source,
              item.target,
              nodesWithManualPositions,
              nodeSizes,
              orthogonalPorts,
              item.parallelIndex,
              item.parallelTotal,
              item.sharedSourcePort,
              item.sharedTargetPort,
              forcedPortSides.source,
              forcedPortSides.target
            )
        : edgePath(
            item.source,
            item.target,
            edgeMode,
            groupCenter,
            item.parallelIndex,
            item.parallelTotal,
            nodeSizes,
            orthogonalPorts,
            item.sharedSourcePort,
            item.sharedTargetPort,
            forcedPortSides.source,
            forcedPortSides.target
          );

    const purpleHint = purpleHybridState.hints.get(item.key);
    const pathD = (() => {
      if (!purpleHint) {
        return defaultPathD;
      }

      const manhattanPoints = (fromX: number, fromY: number, toX: number, toY: number) => {
        const dx = toX - fromX;
        const dy = toY - fromY;
        if (Math.abs(dx) >= Math.abs(dy)) {
          const mx = fromX + dx * 0.5;
          return [
            { x: fromX, y: fromY },
            { x: mx, y: fromY },
            { x: mx, y: toY },
            { x: toX, y: toY }
          ];
        }
        const my = fromY + dy * 0.5;
        return [
          { x: fromX, y: fromY },
          { x: fromX, y: my },
          { x: toX, y: my },
          { x: toX, y: toY }
        ];
      };

      const octolinearPoints = (fromX: number, fromY: number, toX: number, toY: number) => {
        const dx = toX - fromX;
        const dy = toY - fromY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDx < 1e-6 && absDy < 1e-6) {
          return [{ x: fromX, y: fromY }, { x: toX, y: toY }];
        }
        const sxSign = Math.sign(dx) || 1;
        const sySign = Math.sign(dy) || 1;
        const diag = Math.min(absDx, absDy);
        const points = [{ x: fromX, y: fromY }];
        if (diag > 1e-6) {
          points.push({ x: fromX + sxSign * diag, y: fromY + sySign * diag });
        }
        points.push({ x: toX, y: toY });
        return normalizeOctolinearRoute(points);
      };

      const routeTailPoints = (fromX: number, fromY: number, toX: number, toY: number) =>
        routingMode === 'octolinear'
          ? octolinearPoints(fromX, fromY, toX, toY)
          : manhattanPoints(fromX, fromY, toX, toY);

      const pivot = { x: purpleHint.pivotX, y: purpleHint.pivotY };
      const junction = { x: purpleHint.junctionX, y: purpleHint.junctionY };
      const neighbor = purpleHint.pivotIsSource
        ? {
            borderX: tx,
            borderY: ty,
            outsideX: anchors.endOutside.x,
            outsideY: anchors.endOutside.y,
            nx: anchors.endNormal.x,
            ny: anchors.endNormal.y
          }
        : {
            borderX: sx,
            borderY: sy,
            outsideX: anchors.startOutside.x,
            outsideY: anchors.startOutside.y,
            nx: anchors.startNormal.x,
            ny: anchors.startNormal.y
          };

      // Canonical trunk->tail geometry, reversed when the edge direction is neighbor->pivot.
      if (routingMode !== 'smooth') {
        const tail = routeTailPoints(junction.x, junction.y, neighbor.outsideX, neighbor.outsideY);
        const canonicalPoints = [
          pivot,
          junction,
          ...tail.slice(1),
          { x: neighbor.borderX, y: neighbor.borderY }
        ];
        return roundedOrthogonalPath(
          purpleHint.pivotIsSource ? canonicalPoints : [...canonicalPoints].reverse(),
          10
        );
      }

      const tailLength = 34;
      const trunkDx = junction.x - pivot.x;
      const trunkDy = junction.y - pivot.y;
      const trunkLen = Math.hypot(trunkDx, trunkDy) || 1;
      const trunkUx = trunkDx / trunkLen;
      const trunkUy = trunkDy / trunkLen;
      const tailDx = neighbor.outsideX - junction.x;
      const tailDy = neighbor.outsideY - junction.y;
      const tailLen = Math.hypot(tailDx, tailDy) || 1;
      const c1x = junction.x + trunkUx * Math.min(48, tailLen * 0.38);
      const c1y = junction.y + trunkUy * Math.min(48, tailLen * 0.38);
      const c2x = neighbor.borderX + neighbor.nx * Math.min(tailLength, tailLen * 0.35);
      const c2y = neighbor.borderY + neighbor.ny * Math.min(tailLength, tailLen * 0.35);

      if (purpleHint.pivotIsSource) {
        return `M ${pivot.x} ${pivot.y} L ${junction.x} ${junction.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${neighbor.borderX} ${neighbor.borderY}`;
      }
      return `M ${neighbor.borderX} ${neighbor.borderY} C ${c2x} ${c2y}, ${c1x} ${c1y}, ${junction.x} ${junction.y} L ${pivot.x} ${pivot.y}`;
    })();

    const jumpPoints = manhattanLineJumps.get(item.key) ?? [];
    const jumpArcPath = jumpPointsToPath(jumpPoints, 6, 7);
    const markerStart = item.isBidirectionalBundle ? 'url(#arrow-end)' : 'url(#arrow-start-dot)';

    return (
      <g key={item.key}>
        <path
          d={pathD}
          className={`edge ${item.edgeTypeClass} ${item.dirClass} ${item.faded ? 'edge-dim' : ''} ${item.showDirectStyling ? 'edge-direct' : ''}`}
          style={{ strokeWidth: item.strokeWidth, opacity: item.faded ? dimmedEdgeOpacity : undefined }}
          markerStart={markerStart}
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
              style={{ strokeWidth: item.strokeWidth, opacity: item.faded ? dimmedEdgeOpacity : undefined }}
              fill="none"
              strokeLinecap="round"
              pointerEvents="none"
            />
          </>
        )}
        {showLabel && edgeMode !== 'grouped' && item.labelLines.length > 0 && !item.faded && !groupedLabelState.suppressInlineLabels.has(item.key) && (
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

  function renderPurpleHybridTrunk(item: PurpleHybridTrunkItem) {
    return (
      <path
        key={item.key}
        d={item.pathD}
        className={item.className}
        style={{ strokeWidth: item.strokeWidth, opacity: item.opacity }}
        fill="none"
        strokeLinecap="round"
        pointerEvents="none"
      />
    );
  }

  function resolveSugiyamaInOutNeighborPortSides(item: EdgeRenderItem): { source: NodeSide | null; target: NodeSide | null } {
    if (!useSugiyamaLocalLayout || !sugiyamaPivotNodeId || sugiyamaInOutNeighborIds.size === 0) {
      return { source: null, target: null };
    }

    const pivotNode = nodeMap.get(sugiyamaPivotNodeId);
    if (!pivotNode) {
      return { source: null, target: null };
    }

    const pivotSize = nodeSizes.get(pivotNode.id);
    const pivotCenterX = pivotNode.x + (pivotSize?.width ?? 190) / 2;
    const neighborSideTowardSelected = (neighbor: SimNode): NodeSide => {
      const neighborSize = nodeSizes.get(neighbor.id);
      const neighborCenterX = neighbor.x + (neighborSize?.width ?? 190) / 2;
      // Keep neighbor port horizontal and facing the selected node.
      return neighborCenterX < pivotCenterX ? 'right' : 'left';
    };


    if (item.source.id === sugiyamaPivotNodeId && sugiyamaInOutNeighborIds.has(item.target.id)) {
      return {
        // Keep selected node on default routing side (top/bottom in this layout).
        source: null,
        target: neighborSideTowardSelected(item.target),
      };
    }
    if (item.target.id === sugiyamaPivotNodeId && sugiyamaInOutNeighborIds.has(item.source.id)) {
      return {
        source: neighborSideTowardSelected(item.source),
        // Keep selected node on default routing side (top/bottom in this layout).
        target: null,
      };
    }
    return { source: null, target: null };
  }

   const cycleToolbarPosition = () => {
     const positions: Array<'top' | 'bottom' | 'left' | 'right'> = ['top', 'bottom', 'left', 'right'];
     const currentIndex = positions.indexOf(toolbarPosition);
     const nextIndex = (currentIndex + 1) % positions.length;
     setToolbarPosition(positions[nextIndex]);
   };

   return (
      <div className={`graph-shell graph-shell-toolbar-${toolbarPosition}`}>
        <div className={`toolbar toolbar-${toolbarPosition}`}>
          <button onClick={cycleToolbarPosition} title="Cycle toolbar position (Top → Bottom → Left → Right)">⇄</button>
          <button onClick={() => setCollapsedGroups(new Set(groupOrder))}>Collapse all groups</button>
          <button onClick={() => setCollapsedGroups(new Set())}>Expand all groups</button>
         <label>
           Dim strength
           <input
             type="range"
             min={0}
             max={100}
             step={1}
             value={focusDimStrength}
             onChange={(e) => setFocusDimStrength(Number(e.target.value))}
           />
           <span>{focusDimStrength}%</span>
         </label>
         <label>
           <input type="checkbox" checked={showDirectEdges} onChange={(e) => setShowDirectEdges(e.target.checked)} />
           Show direct edges
         </label>
          <label>
            <input type="checkbox" checked={autoZoomEnabled} onChange={(e) => setAutoZoomEnabled(e.target.checked)} />
            Auto zoom
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
          <select value={routingMode} onChange={(e) => setRoutingMode(e.target.value as 'smooth' | 'manhattan' | 'octolinear')}>
            <option value="smooth">smooth</option>
            <option value="manhattan">manhattan</option>
            <option value="octolinear">octolinear</option>
          </select>
        </label>
        {isLocalContext && (
          <label>
            Detail layout:
            <select value={detailLayoutMode} onChange={(e) => setDetailLayoutMode(e.target.value as DetailLayoutMode)}>
              <option value="force">Force graph</option>
              <option value="sugiyama">Sugiyama graph</option>
            </select>
          </label>
        )}
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
        {isLocalContext && localRootNodeLabel ? (
          <span className="local-context-chip">Local: {localRootNodeLabel} (Esc/canvas to exit)</span>
        ) : null}
        {selectedNodeId ? <span className="selected-label">Selected: {selectedNodeId}</span> : null}
      </div>

       <div
         ref={scrollViewportRef}
         className="graph-stage-viewport"
         style={{ width: canvasWidth, height: canvasHeight }}
         onScroll={onViewportScroll}
       >
         <div
           className="graph-stage-scroll-content"
           style={{ width: scrollContentSize.width, height: scrollContentSize.height }}
         >
           <div
             ref={stageRef}
             className={`graph-stage ${isLocalContext ? 'local-mode' : ''}`}
             style={{ width: canvasWidth, height: canvasHeight }}
             onClick={(event) => {
               const target = event.target;
               if (target instanceof Element && target.closest('.node-card')) {
                 return;
               }
               if (isLocalContext) {
                 exitLocalContext();
                 return;
               }
               // Immediately jump to selected node before clearing selection
               if (selectedNodeId) {
                 const selectedNode = nodeMap.get(selectedNodeId);
                 if (selectedNode) {
                   jumpToNode(selectedNode, 1);
                 }
               }
               setSelectedNodeId(null);
               setHoveredNodeId(null);
             }}
           >
         {showHelpPanel && (
           <div className="overlay-panel overlay-help" style={{ left: helpPanelPos.x, top: helpPanelPos.y }}>
             <div className="overlay-panel-drag-handle" onPointerDown={(e) => beginPanelDrag('help', e)}><strong>Shortcuts</strong></div>
             <div><kbd>Esc</kbd> clear selection</div>
             <div><kbd>R</kbd> reset zoom</div>
             <div>Single-click a node to select it. Double-click a node to enter local mode centered on that node.</div>
             <div>Click canvas to clear current node selection. Use Dim strength slider to control node fading when a node is selected.</div>
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
         <svg ref={svgRef} width={canvasWidth} height={canvasHeight} className="edge-layer edge-layer-low">
          <defs>
            <marker id="arrow-start-dot" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="3.5" markerHeight="3.5" orient="auto">
              <circle cx="5" cy="5" r="4" fill="context-stroke" />
            </marker>
            <marker id="arrow-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="3.5" markerHeight="3.5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          <g transform={transform.toString()}>
            {purpleHybridState.fadedTrunks.map((item) => renderPurpleHybridTrunk(item))}
            {fadedEdgeItems.map((item) => renderEdge(item, false))}
          </g>
        </svg>

         <svg width={canvasWidth} height={canvasHeight} className="edge-layer edge-layer-highlight">
          <g transform={transform.toString()}>
            {purpleHybridState.emphasizedTrunks.map((item) => renderPurpleHybridTrunk(item))}
            {emphasizedEdgeItems.map((item) => renderEdge(item, true))}
            {groupedLabelState.aggregatedLabels.map((label) => (
              <g className="edge-label-group" key={label.key}>
                <rect
                  x={label.x - Math.max(46, label.text.length * 3.2 + 13)}
                  y={label.y - 10}
                  width={Math.max(92, label.text.length * 6.4 + 26)}
                  height={20}
                  rx="4"
                  ry="4"
                  className={`edge-label-bg ${label.edgeTypeClass} ${label.dirClass}`}
                />
                <text
                  x={label.x}
                  y={label.y + 3}
                  textAnchor="middle"
                  className="edge-label"
                >
                  {label.text}
                </text>
              </g>
            ))}
          </g>
         </svg>

         <div className="node-layer" style={{ transform: cssZoomTransform(transform) }}>
           {unselectedRenderNodes.map((node) => renderNodeCard(node))}
         </div>

         <div className="node-layer node-layer-highlight" style={{ transform: cssZoomTransform(transform) }}>
           {highlightedRenderNodes.map((node) => renderNodeCard(node))}
         </div>
           </div>
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
  parallelTotal = 1,
  nodeSizes: Map<string, { width: number; height: number }>,
  orthogonalPorts = false,
  sharedSourcePort: AnchorPoint | null = null,
  sharedTargetPort: AnchorPoint | null = null,
  forcedSourceSide: NodeSide | null = null,
  forcedTargetSide: NodeSide | null = null
): string {
  const anchors = getAnchoredEndpoints(
    source,
    target,
    nodeSizes,
    parallelIndex,
    parallelTotal,
    orthogonalPorts,
    sharedSourcePort,
    sharedTargetPort,
    'middle',
    'middle',
    forcedSourceSide,
    forcedTargetSide
  );
  const { start, end } = anchors;
  const sx = start.x;
  const sy = start.y;
  const tx = end.x;
  const ty = end.y;
  const sourceOutsideX = anchors.startOutside.x;
  const sourceOutsideY = anchors.startOutside.y;
  const targetOutsideX = anchors.endOutside.x;
  const targetOutsideY = anchors.endOutside.y;
  const sourceStubX = sourceOutsideX + anchors.startNormal.x * 18;
  const sourceStubY = sourceOutsideY + anchors.startNormal.y * 18;
  const targetStubX = targetOutsideX + anchors.endNormal.x * 18;
  const targetStubY = targetOutsideY + anchors.endNormal.y * 18;

  if (mode === 'none') {
    return `M ${sx} ${sy} L ${sourceOutsideX} ${sourceOutsideY} L ${targetOutsideX} ${targetOutsideY} L ${tx} ${ty}`;
  }

  // Both 'soft' and 'grouped' use the softbundle algorithm for smooth routing
  const dx = tx - sx;
  const dy = ty - sy;
  const distance = Math.hypot(dx, dy) || 1;
  const bend = Math.max(34, Math.min(180, distance * 0.45));
  const c1x = sourceStubX + (orthogonalPorts ? 0 : dx * 0.28) + anchors.startNormal.x * bend;
  const c1y = sourceStubY + (orthogonalPorts ? 0 : dy * 0.28) + anchors.startNormal.y * bend;
  const c2x = targetStubX - (orthogonalPorts ? 0 : dx * 0.28) + anchors.endNormal.x * bend;
  const c2y = targetStubY - (orthogonalPorts ? 0 : dy * 0.28) + anchors.endNormal.y * bend;
  if (orthogonalPorts) {
    return `M ${sx} ${sy} L ${sourceOutsideX} ${sourceOutsideY} L ${sourceStubX} ${sourceStubY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${targetStubX} ${targetStubY} L ${targetOutsideX} ${targetOutsideY} L ${tx} ${ty}`;
  }
  return `M ${sx} ${sy} L ${sourceOutsideX} ${sourceOutsideY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${targetOutsideX} ${targetOutsideY} L ${tx} ${ty}`;
}

type NodeSide = 'left' | 'right' | 'top' | 'bottom';

interface AnchorPoint {
  x: number;
  y: number;
  side: NodeSide;
  portPosition?: 'begin' | 'middle' | 'end';  // discrete port positions on side
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

function sectorToSide(angleDegrees: number, tiebreaker: number = 0): NodeSide {
  // Normalize angle to 0-360 range
  const angle = ((angleDegrees % 360) + 360) % 360;
  
  // Determine primary sector
  // 0° = right, 90° = down, 180° = left, 270° = up (screen coordinates)
  let side: NodeSide;
  let hasFlipPair = false;
  let flipPair: [NodeSide, NodeSide] = ['top', 'bottom'];
  
  if (angle >= 0 && angle < 45) side = 'right';      // Sector 1: 0° to 45° → right
  else if (angle >= 45 && angle < 90) {
    side = 'bottom';                                   // Sector 2: 45° to 90° (can flip to right)
    hasFlipPair = true;
    flipPair = ['bottom', 'right'];
  } else if (angle >= 90 && angle < 135) {
    side = 'bottom';                                   // Sector 3: 90° to 135° (can flip to left)
    hasFlipPair = true;
    flipPair = ['bottom', 'left'];
  } else if (angle >= 135 && angle < 180) side = 'left';    // Sector 4: 135° to 180° → left
  else if (angle >= 180 && angle < 225) side = 'left';      // Sector 5: 180° to 225° → left
  else if (angle >= 225 && angle < 270) {
    side = 'top';                                      // Sector 6: 225° to 270° (can flip to left)
    hasFlipPair = true;
    flipPair = ['top', 'left'];
  } else if (angle >= 270 && angle < 315) {
    side = 'top';                                      // Sector 7: 270° to 315° (can flip to right)
    hasFlipPair = true;
    flipPair = ['top', 'right'];
  } else side = 'right';                              // Sector 8: 315° to 360° → right

  // At boundary angles (45°, 135°, 225°, 315°), flip between paired sides deterministically
  if (hasFlipPair && Math.abs(Math.round(angle * 10) - angle * 10) < 0.1) {
    // Use tiebreaker hash (source node ID) to deterministically alternate
    return tiebreaker % 2 === 0 ? flipPair[0] : flipPair[1];
  }
  
  return side;
}

function anchorNearestPorts(
  sourceRect: { x: number; y: number; width: number; height: number },
  targetRect: { x: number; y: number; width: number; height: number },
  sourceNodeId: string = '',
  sourcePortPosition: 'begin' | 'middle' | 'end' = 'middle',
  targetPortPosition: 'begin' | 'middle' | 'end' = 'middle'
) {
  // Get center points of both rectangles
  const sourceCenter = getRectCenter(sourceRect);
  const targetCenter = getRectCenter(targetRect);

  // Calculate angle from source to target
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const radians = Math.atan2(dy, dx);
  const angleDegrees = (radians * 180) / Math.PI;
  
  // Hash source node ID for deterministic tie-breaking
  let tiebreaker = 0;
  for (let i = 0; i < sourceNodeId.length; i++) {
    tiebreaker = ((tiebreaker << 5) - tiebreaker) + sourceNodeId.charCodeAt(i);
    tiebreaker |= 0; // Convert to 32bit integer
  }
  tiebreaker = Math.abs(tiebreaker);
  
  // Get port sides based on angle (with tie-breaking at boundaries)
  const sourceSide = sectorToSide(angleDegrees, tiebreaker);
  const targetSide = sectorToSide(angleDegrees + 180, tiebreaker); // Opposite angle for target

  const sourceAnchor = createAnchorOnSide(sourceRect, sourceSide, sourcePortPosition);
  const targetAnchor = createAnchorOnSide(targetRect, targetSide, targetPortPosition);

  return { start: sourceAnchor, end: targetAnchor };
}

function createAnchorOnSide(
  rect: { x: number; y: number; width: number; height: number },
  side: NodeSide,
  portPosition: 'begin' | 'middle' | 'end' = 'middle'
): AnchorPoint {
  const center = getRectCenter(rect);
  const guard = 8;
  
  // Position offset based on port position
  const positionFactors: Record<'begin' | 'middle' | 'end', number> = {
    'begin': 0.25,
    'middle': 0.5,
    'end': 0.75
  };
  const factor = positionFactors[portPosition];
  
  if (side === 'left') {
    return {
      x: rect.x,
      y: clamp(
        rect.y + guard + (rect.height - 2 * guard) * factor,
        rect.y + guard,
        rect.y + rect.height - guard
      ),
      side: 'left',
      portPosition
    };
  }
  if (side === 'right') {
    return {
      x: rect.x + rect.width,
      y: clamp(
        rect.y + guard + (rect.height - 2 * guard) * factor,
        rect.y + guard,
        rect.y + rect.height - guard
      ),
      side: 'right',
      portPosition
    };
  }
  if (side === 'top') {
    return {
      x: clamp(
        rect.x + guard + (rect.width - 2 * guard) * factor,
        rect.x + guard,
        rect.x + rect.width - guard
      ),
      y: rect.y,
      side: 'top',
      portPosition
    };
  }
  return {
    x: clamp(
      rect.x + guard + (rect.width - 2 * guard) * factor,
      rect.x + guard,
      rect.x + rect.width - guard
    ),
    y: rect.y + rect.height,
    side: 'bottom',
    portPosition
  };
}

function getAnchoredEndpoints(
  source: SimNode,
  target: SimNode,
  nodeSizes: Map<string, { width: number; height: number }>,
  parallelIndex = 0,
  parallelTotal = 1,
  orthogonalPorts = false,
  sharedSourcePort: AnchorPoint | null = null,
  sharedTargetPort: AnchorPoint | null = null,
  sourcePortPosition: 'begin' | 'middle' | 'end' = 'middle',
  targetPortPosition: 'begin' | 'middle' | 'end' = 'middle',
  forcedSourceSide: NodeSide | null = null,
  forcedTargetSide: NodeSide | null = null
) {
  const sourceRect = getNodeRect(source, nodeSizes);
  const targetRect = getNodeRect(target, nodeSizes);
  const base = orthogonalPorts
    ? anchorOrthogonalPorts(sourceRect, targetRect, sourcePortPosition, targetPortPosition)
    : anchorNearestPorts(sourceRect, targetRect, source.id, sourcePortPosition, targetPortPosition);
  if (forcedSourceSide) {
    base.start = createAnchorOnSide(sourceRect, forcedSourceSide, sourcePortPosition);
  }
  if (forcedTargetSide) {
    base.end = createAnchorOnSide(targetRect, forcedTargetSide, targetPortPosition);
  }
  if (sharedSourcePort) {
    base.start = sharedSourcePort;
  }
  if (sharedTargetPort) {
    base.end = sharedTargetPort;
  }

  const offset = sharedSourcePort || sharedTargetPort ? 0 : parallelOffsetDistance(parallelIndex, parallelTotal);

  const { start, end } = orthogonalPorts
    ? offsetOrthogonalPorts(base.start, base.end, sourceRect, targetRect, offset)
    : offsetAlongLineNormal(base.start, base.end, offset);

  const startOutside = offsetAnchorAlongNormal(start, EDGE_OUTSIDE_HIT_GAP);
  const endOutside = offsetAnchorAlongNormal(end, EDGE_OUTSIDE_HIT_GAP);

  return {
    start,
    end,
    startOutside,
    endOutside,
    startNormal: sideNormal(start.side),
    endNormal: sideNormal(end.side)
  };
}

function offsetAnchorAlongNormal(point: AnchorPoint, distance: number): AnchorPoint {
  const normal = sideNormal(point.side);
  return {
    ...point,
    x: point.x + normal.x * distance,
    y: point.y + normal.y * distance
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
  targetRect: { x: number; y: number; width: number; height: number },
  sourcePortPosition: 'begin' | 'middle' | 'end' = 'middle',
  targetPortPosition: 'begin' | 'middle' | 'end' = 'middle'
) {
  const sourceCenter = getRectCenter(sourceRect);
  const targetCenter = getRectCenter(targetRect);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const sourceSide: NodeSide = dx >= 0 ? 'right' : 'left';
    const targetSide: NodeSide = dx >= 0 ? 'left' : 'right';
    return {
      start: createAnchorOnSide(sourceRect, sourceSide, sourcePortPosition),
      end: createAnchorOnSide(targetRect, targetSide, targetPortPosition)
    };
  }

  const sourceSide: NodeSide = dy >= 0 ? 'bottom' : 'top';
  const targetSide: NodeSide = dy >= 0 ? 'top' : 'bottom';
  return {
    start: createAnchorOnSide(sourceRect, sourceSide, sourcePortPosition),
    end: createAnchorOnSide(targetRect, targetSide, targetPortPosition)
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
  orthogonalPorts = false,
  parallelIndex = 0,
  parallelTotal = 1,
  sharedSourcePort: AnchorPoint | null = null,
  sharedTargetPort: AnchorPoint | null = null,
  forcedSourceSide: NodeSide | null = null,
  forcedTargetSide: NodeSide | null = null
): string {
  const points = manhattanRoutePoints(
    source,
    target,
    nodeSizes,
    orthogonalPorts,
    parallelIndex,
    parallelTotal,
    sharedSourcePort,
    sharedTargetPort,
    forcedSourceSide,
    forcedTargetSide
  );
  return roundedOrthogonalPath(points, 12);
}

function manhattanRoutePoints(
  source: SimNode,
  target: SimNode,
  nodeSizes: Map<string, { width: number; height: number }>,
  orthogonalPorts = false,
  parallelIndex = 0,
  parallelTotal = 1,
  sharedSourcePort: AnchorPoint | null = null,
  sharedTargetPort: AnchorPoint | null = null,
  forcedSourceSide: NodeSide | null = null,
  forcedTargetSide: NodeSide | null = null
): Array<{ x: number; y: number }> {
  const anchors = getAnchoredEndpoints(
    source,
    target,
    nodeSizes,
    parallelIndex,
    parallelTotal,
    orthogonalPorts,
    sharedSourcePort,
    sharedTargetPort,
    'middle',
    'middle',
    forcedSourceSide,
    forcedTargetSide
  );
  const sx = anchors.startOutside.x;
  const sy = anchors.startOutside.y;
  const tx = anchors.endOutside.x;
  const ty = anchors.endOutside.y;

  const dx = tx - sx;
  const dy = ty - sy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const mx = sx + dx * 0.5;
    return [
      { x: anchors.start.x, y: anchors.start.y },
      { x: sx, y: sy },
      { x: mx, y: sy },
      { x: mx, y: ty },
      { x: tx, y: ty },
      { x: anchors.end.x, y: anchors.end.y }
    ];
  }
  const my = sy + dy * 0.5;
  return [
    { x: anchors.start.x, y: anchors.start.y },
    { x: sx, y: sy },
    { x: sx, y: my },
    { x: tx, y: my },
    { x: tx, y: ty },
    { x: anchors.end.x, y: anchors.end.y }
  ];
}

function octolinearEdgePath(
  source: SimNode,
  target: SimNode,
  allNodes: SimNode[],
  nodeSizes: Map<string, { width: number; height: number }>,
  orthogonalPorts = false,
  parallelIndex = 0,
  parallelTotal = 1,
  sharedSourcePort: AnchorPoint | null = null,
  sharedTargetPort: AnchorPoint | null = null,
  forcedSourceSide: NodeSide | null = null,
  forcedTargetSide: NodeSide | null = null
): string {
  const points = octolinearRoutePoints(
    source,
    target,
    allNodes,
    nodeSizes,
    orthogonalPorts,
    parallelIndex,
    parallelTotal,
    sharedSourcePort,
    sharedTargetPort,
    forcedSourceSide,
    forcedTargetSide
  );
  return roundedOrthogonalPath(points, 12);
}

function octolinearRoutePoints(
  source: SimNode,
  target: SimNode,
  allNodes: SimNode[],
  nodeSizes: Map<string, { width: number; height: number }>,
  orthogonalPorts = false,
  parallelIndex = 0,
  parallelTotal = 1,
  sharedSourcePort: AnchorPoint | null = null,
  sharedTargetPort: AnchorPoint | null = null,
  forcedSourceSide: NodeSide | null = null,
  forcedTargetSide: NodeSide | null = null
): Array<{ x: number; y: number }> {
  const anchors = getAnchoredEndpoints(
    source,
    target,
    nodeSizes,
    parallelIndex,
    parallelTotal,
    orthogonalPorts,
    sharedSourcePort,
    sharedTargetPort,
    'middle',
    'middle',
    forcedSourceSide,
    forcedTargetSide
  );

  const start = { x: anchors.startOutside.x, y: anchors.startOutside.y };
  const end = { x: anchors.endOutside.x, y: anchors.endOutside.y };

  const stubLength = orthogonalPorts ? 24 : 14;
  const startStub = {
    x: start.x + anchors.startNormal.x * stubLength,
    y: start.y + anchors.startNormal.y * stubLength
  };
  const endStub = {
    x: end.x + anchors.endNormal.x * stubLength,
    y: end.y + anchors.endNormal.y * stubLength
  };

  const sourceRect = getNodeRect(source, nodeSizes);
  const targetRect = getNodeRect(target, nodeSizes);
  const obstacles = collectOctolinearObstacles(allNodes, nodeSizes, source, target, startStub, endStub);
  const cacheKey = octolinearCacheKey(start, end, startStub, endStub, anchors.start.side, anchors.end.side, obstacles);
  const cached = octolinearRouteCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const coreCandidates = buildOctolinearCoreCandidates(startStub, endStub, OCTOLINEAR_PRIMARY_OFFSETS);
  const fullCandidates = coreCandidates.map((core) => [
    { x: anchors.start.x, y: anchors.start.y },
    start,
    startStub,
    ...core,
    endStub,
    end,
    { x: anchors.end.x, y: anchors.end.y }
  ]);

  let best = fullCandidates[0] ?? [start, end];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of fullCandidates) {
    const intersections = countRouteObstacleIntersections(candidate, obstacles);
    const sourcePenalty = countRouteObstacleIntersections(candidate, [inflateRect(sourceRect, 6)]);
    const targetPenalty = countRouteObstacleIntersections(candidate, [inflateRect(targetRect, 6)]);
    const length = polylineLength(candidate);
    const bends = countPolylineBends(candidate);
    const backtrack = routeBacktrackPenalty(candidate, startStub, endStub);
    const zigzag = routeShortSegmentPenalty(candidate);
    const drift = routeBaselineDriftPenalty(candidate, startStub, endStub);
    const score =
      intersections * 1_000_000 +
      (sourcePenalty + targetPenalty) * 400_000 +
      bends * 165 +
      backtrack * 260 +
      zigzag * 110 +
      drift * 0.08 +
      length;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  // Escalate to wider metro offsets only if all close candidates still collide heavily.
  const bestCollisions = countRouteObstacleIntersections(best, obstacles);
  if (bestCollisions > 0 && OCTOLINEAR_SECONDARY_OFFSETS.length > 0) {
    const widenedOffsets = OCTOLINEAR_PRIMARY_OFFSETS.concat(OCTOLINEAR_SECONDARY_OFFSETS);
    const secondaryCandidates = buildOctolinearCoreCandidates(startStub, endStub, widenedOffsets).map((core) => [
      { x: anchors.start.x, y: anchors.start.y },
      start,
      startStub,
      ...core,
      endStub,
      end,
      { x: anchors.end.x, y: anchors.end.y }
    ]);
    for (const candidate of secondaryCandidates) {
      const intersections = countRouteObstacleIntersections(candidate, obstacles);
      const sourcePenalty = countRouteObstacleIntersections(candidate, [inflateRect(sourceRect, 6)]);
      const targetPenalty = countRouteObstacleIntersections(candidate, [inflateRect(targetRect, 6)]);
      const length = polylineLength(candidate);
      const bends = countPolylineBends(candidate);
      const backtrack = routeBacktrackPenalty(candidate, startStub, endStub);
      const zigzag = routeShortSegmentPenalty(candidate);
      const drift = routeBaselineDriftPenalty(candidate, startStub, endStub);
      const score =
        intersections * 1_000_000 +
        (sourcePenalty + targetPenalty) * 400_000 +
        bends * 165 +
        backtrack * 260 +
        zigzag * 110 +
        drift * 0.08 +
        length;
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }

   if (!Number.isFinite(bestScore)) {
     return manhattanRoutePoints(
       source,
       target,
       nodeSizes,
       orthogonalPorts,
       parallelIndex,
       parallelTotal,
       sharedSourcePort,
       sharedTargetPort,
       forcedSourceSide,
       forcedTargetSide
     );
   }

   // Ensure best candidate is properly aligned to octolinear directions
   const normalizedBest = normalizeOctolinearRoute(best);
   setOctolinearCache(cacheKey, normalizedBest);
   return normalizedBest;
}

function normalizeOctolinearRoute(
  points: Array<{ x: number; y: number }>
): Array<{ x: number; y: number }> {
  if (points.length < 2) return points;
  
  const result: Array<{ x: number; y: number }> = [points[0]];
  
  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
      // Skip zero-length segment
      continue;
    }
    
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    
    // Check if already aligned to octolinear (one of 8 directions)
    const isHorizontal = Math.abs(dy) < 1e-6;
    const isVertical = Math.abs(dx) < 1e-6;
    const isDiagonal45 = Math.abs(absDx - absDy) < 1e-6;
    
    if (isHorizontal || isVertical || isDiagonal45) {
      // Already aligned
      result.push(curr);
    } else {
      // Not aligned - decompose into octolinear segments
      // Try to match the target as closely as possible using 45° angles
      const sx = Math.sign(dx) || 1;
      const sy = Math.sign(dy) || 1;
      const diagDist = Math.min(absDx, absDy);
      
      // Add diagonal segment
      result.push({
        x: prev.x + sx * diagDist,
        y: prev.y + sy * diagDist
      });
      
      // Add remaining horizontal or vertical segment if needed
      const remX = curr.x - result[result.length - 1].x;
      const remY = curr.y - result[result.length - 1].y;
      
      if (Math.abs(remX) > 1e-6 || Math.abs(remY) > 1e-6) {
        result.push(curr);
      }
    }
  }
  
  return result;
}

function buildOctolinearCoreCandidates(
  start: { x: number; y: number },
  end: { x: number; y: number },
  offsets: readonly number[]
): Array<Array<{ x: number; y: number }>> {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDx < 1e-6 || absDy < 1e-6) {
    return [[start, end]];
  }

  const sx = Math.sign(dx) || 1;
  const sy = Math.sign(dy) || 1;
  const diag = Math.min(absDx, absDy);
  const halfH = (absDx - diag) * 0.5;
  const halfV = (absDy - diag) * 0.5;

  const candidates: Array<Array<{ x: number; y: number }>> = [];

  for (const off of offsets) {
    // Horizontal stub -> diagonal -> horizontal stub
    const hx = start.x + sx * halfH + off;
    const h1 = { x: hx, y: start.y };
    const h2 = { x: hx + sx * diag, y: start.y + sy * diag };
    const hCandidate = normalizeOctolinearRoute([start, h1, h2, end]);
    candidates.push(hCandidate);

    // Vertical stub -> diagonal -> vertical stub
    const vy = start.y + sy * halfV + off;
    const v1 = { x: start.x, y: vy };
    const v2 = { x: start.x + sx * diag, y: vy + sy * diag };
    const vCandidate = normalizeOctolinearRoute([start, v1, v2, end]);
    candidates.push(vCandidate);
  }

  return candidates;
}

function collectOctolinearObstacles(
  allNodes: SimNode[],
  nodeSizes: Map<string, { width: number; height: number }>,
  source: SimNode,
  target: SimNode,
  startStub: { x: number; y: number },
  endStub: { x: number; y: number }
): Array<{ x: number; y: number; width: number; height: number }> {
  const minX = Math.min(startStub.x, endStub.x) - OCTOLINEAR_OBSTACLE_RANGE;
  const maxX = Math.max(startStub.x, endStub.x) + OCTOLINEAR_OBSTACLE_RANGE;
  const minY = Math.min(startStub.y, endStub.y) - OCTOLINEAR_OBSTACLE_RANGE;
  const maxY = Math.max(startStub.y, endStub.y) + OCTOLINEAR_OBSTACLE_RANGE;

  return allNodes
    .filter((node) => node.id !== source.id && node.id !== target.id)
    .map((node) => inflateRect(getNodeRect(node, nodeSizes), OCTOLINEAR_CLEARANCE))
    .filter((rect) => rectIntersectsBounds(rect, minX, minY, maxX, maxY));
}

function rectIntersectsBounds(
  rect: { x: number; y: number; width: number; height: number },
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): boolean {
  return rect.x <= maxX && rect.x + rect.width >= minX && rect.y <= maxY && rect.y + rect.height >= minY;
}

function routeBacktrackPenalty(
  points: Array<{ x: number; y: number }>,
  start: { x: number; y: number },
  end: { x: number; y: number }
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    return 0;
  }
  const ux = dx / length;
  const uy = dy / length;
  let penalty = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const sx = points[i + 1].x - points[i].x;
    const sy = points[i + 1].y - points[i].y;
    const proj = sx * ux + sy * uy;
    if (proj < -1e-6) {
      penalty += Math.abs(proj);
    }
  }
  return penalty;
}

function routeShortSegmentPenalty(points: Array<{ x: number; y: number }>): number {
  let penalty = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const segLength = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    if (segLength < 18) {
      penalty += 18 - segLength;
    }
  }
  return penalty;
}

function routeBaselineDriftPenalty(
  points: Array<{ x: number; y: number }>,
  start: { x: number; y: number },
  end: { x: number; y: number }
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    return 0;
  }
  let drift = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const px = points[i].x - start.x;
    const py = points[i].y - start.y;
    drift += Math.abs(px * dy - py * dx) / length;
  }
  return drift;
}

function octolinearCacheKey(
  start: { x: number; y: number },
  end: { x: number; y: number },
  startStub: { x: number; y: number },
  endStub: { x: number; y: number },
  startSide: NodeSide,
  endSide: NodeSide,
  obstacles: Array<{ x: number; y: number; width: number; height: number }>
): string {
  const obstacleSignature = obstacles
    .map((rect) => `${quantizeCoord(rect.x)}:${quantizeCoord(rect.y)}:${quantizeCoord(rect.width)}:${quantizeCoord(rect.height)}`)
    .sort()
    .join('|');
  return [
    quantizeCoord(start.x),
    quantizeCoord(start.y),
    quantizeCoord(end.x),
    quantizeCoord(end.y),
    quantizeCoord(startStub.x),
    quantizeCoord(startStub.y),
    quantizeCoord(endStub.x),
    quantizeCoord(endStub.y),
    startSide,
    endSide,
    obstacleSignature
  ].join(';');
}

function quantizeCoord(value: number): number {
  return Math.round(value / 8);
}

function setOctolinearCache(key: string, route: Array<{ x: number; y: number }>) {
  if (octolinearRouteCache.has(key)) {
    octolinearRouteCache.delete(key);
  }
  octolinearRouteCache.set(key, route);
  if (octolinearRouteCache.size <= OCTOLINEAR_CACHE_LIMIT) {
    return;
  }
  const oldestKey = octolinearRouteCache.keys().next().value;
  if (oldestKey) {
    octolinearRouteCache.delete(oldestKey);
  }
}

function inflateRect(
  rect: { x: number; y: number; width: number; height: number },
  padding: number
): { x: number; y: number; width: number; height: number } {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2
  };
}

function countRouteObstacleIntersections(
  points: Array<{ x: number; y: number }>,
  obstacles: Array<{ x: number; y: number; width: number; height: number }>
): number {
  let count = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    for (const rect of obstacles) {
      if (segmentIntersectsRect(a, b, rect)) {
        count += 1;
      }
    }
  }
  return count;
}

function segmentIntersectsRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  if (pointInRect(a, rect) || pointInRect(b, rect)) {
    return true;
  }

  const p1 = { x: rect.x, y: rect.y };
  const p2 = { x: rect.x + rect.width, y: rect.y };
  const p3 = { x: rect.x + rect.width, y: rect.y + rect.height };
  const p4 = { x: rect.x, y: rect.y + rect.height };

  return (
    segmentsIntersect(a, b, p1, p2) ||
    segmentsIntersect(a, b, p2, p3) ||
    segmentsIntersect(a, b, p3, p4) ||
    segmentsIntersect(a, b, p4, p1)
  );
}

function pointInRect(
  point: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    point.x >= rect.x - 1e-6 &&
    point.x <= rect.x + rect.width + 1e-6 &&
    point.y >= rect.y - 1e-6 &&
    point.y <= rect.y + rect.height + 1e-6
  );
}

function segmentsIntersect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number }
): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);

  if (Math.abs(o1) < 1e-6 && onSegment(a, c, b)) return true;
  if (Math.abs(o2) < 1e-6 && onSegment(a, d, b)) return true;
  if (Math.abs(o3) < 1e-6 && onSegment(c, a, d)) return true;
  if (Math.abs(o4) < 1e-6 && onSegment(c, b, d)) return true;

  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function orient(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
): boolean {
  return (
    b.x >= Math.min(a.x, c.x) - 1e-6 &&
    b.x <= Math.max(a.x, c.x) + 1e-6 &&
    b.y >= Math.min(a.y, c.y) - 1e-6 &&
    b.y <= Math.max(a.y, c.y) + 1e-6
  );
}

function polylineLength(points: Array<{ x: number; y: number }>): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return total;
}

function countPolylineBends(points: Array<{ x: number; y: number }>): number {
  let bends = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const v1x = points[i].x - points[i - 1].x;
    const v1y = points[i].y - points[i - 1].y;
    const v2x = points[i + 1].x - points[i].x;
    const v2y = points[i + 1].y - points[i].y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-6 || l2 < 1e-6) {
      continue;
    }
    const cross = Math.abs(v1x * v2y - v1y * v2x);
    if (cross > 1e-6) {
      bends += 1;
    }
  }
  return bends;
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

function classifyEdgeDirectionality(
  sourceId: string,
  targetId: string,
  pivotNodeId: string | null
): 'incoming' | 'outgoing' | 'both' | 'none' {
  if (!pivotNodeId) {
    return 'none';
  }
  const isSourcePivot = sourceId === pivotNodeId;
  const isTargetPivot = targetId === pivotNodeId;

  if (isSourcePivot && isTargetPivot) {
    return 'both';  // self-loop
  }
  if (isSourcePivot) {
    return 'outgoing';  // edge leaves from pivot
  }
  if (isTargetPivot) {
    return 'incoming';  // edge enters to pivot
  }
  return 'none';
}

function getBundleColor(directionality: 'incoming' | 'outgoing' | 'both' | 'none'): 'orange' | 'blue' | 'purple' | 'default' {
  switch (directionality) {
    case 'incoming':
      return 'orange';
    case 'outgoing':
      return 'blue';
    case 'both':
      return 'purple';
    default:
      return 'default';
  }
}

function assignBundleThickness(edges: SimLink[], baseStrokeWidth: number, count: number): number {
  // If this edge is part of a shared bundle, thickness accumulates
  return Math.min(14, baseStrokeWidth * Math.min(2, 1 + count * 0.3));
}
