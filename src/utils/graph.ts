import type { GraphData, GraphLink, GraphNode, SimLink, SimNode } from '../types/graph';

export interface VisibleGraph {
  nodes: SimNode[];
  links: SimLink[];
}

export function buildVisibleGraph(data: GraphData, collapsedGroups: Set<string>): VisibleGraph {
  const groupMembers = new Map<string, GraphNode[]>();
  for (const node of data.nodes) {
    if (!groupMembers.has(node.group)) {
      groupMembers.set(node.group, []);
    }
    groupMembers.get(node.group)?.push(node);
  }

  const visibleNodes: SimNode[] = [];
  const nodeToVisible = new Map<string, string>();

  for (const node of data.nodes) {
    if (collapsedGroups.has(node.group)) {
      const clusterId = `cluster:${node.group}`;
      nodeToVisible.set(node.id, clusterId);
      continue;
    }

    visibleNodes.push({
      ...node,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      isCluster: false
    });
    nodeToVisible.set(node.id, node.id);
  }

  for (const [group, members] of groupMembers.entries()) {
    if (!collapsedGroups.has(group)) {
      continue;
    }
    const clusterId = `cluster:${group}`;
    const directionality = inferDirectionality(members.map((m) => m.directionality));
    visibleNodes.push({
      id: clusterId,
      type: 'cluster',
      label: `${group} (${members.length})`,
      group,
      directionality,
      metadata: { collapsed: true },
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      isCluster: true,
      childCount: members.length
    });
  }

  const aggregated = new Map<string, SimLink>();
  for (const link of data.links) {
    const sourceId = nodeToVisible.get(link.source);
    const targetId = nodeToVisible.get(link.target);
    if (!sourceId || !targetId || sourceId === targetId) {
      continue;
    }
    const key = link.edgeKey ?? `${sourceId}|${targetId}|${link.type}`;
    const current = aggregated.get(key);
    if (current) {
      current.weight = (current.weight ?? 1) + (link.weight ?? 1);
      continue;
    }
    aggregated.set(key, {
      source: sourceId,
      target: targetId,
      type: link.type,
      edgeKey: key,
      label: link.label,
      procedures: link.procedures,
      weight: link.weight ?? 1
    });
  }

  return {
    nodes: visibleNodes,
    links: [...aggregated.values()]
  };
}

function inferDirectionality(values: Array<'source' | 'intermediate' | 'sink'>) {
  if (values.every((v) => v === 'source')) {
    return 'source';
  }
  if (values.every((v) => v === 'sink')) {
    return 'sink';
  }
  return 'intermediate';
}

export function buildAdjacency(links: GraphLink[] | SimLink[]) {
  const adjacency = new Map<string, Set<string>>();
  for (const link of links) {
    const src = typeof link.source === 'string' ? link.source : link.source.id;
    const dst = typeof link.target === 'string' ? link.target : link.target.id;
    if (!adjacency.has(src)) {
      adjacency.set(src, new Set());
    }
    adjacency.get(src)?.add(dst);
  }
  return adjacency;
}

export function collectNeighborhood(data: VisibleGraph, centerId: string): Set<string> {
  const related = new Set<string>([centerId]);
  for (const link of data.links) {
    const src = typeof link.source === 'string' ? link.source : link.source.id;
    const dst = typeof link.target === 'string' ? link.target : link.target.id;
    if (src === centerId || dst === centerId) {
      related.add(src);
      related.add(dst);
    }
  }
  return related;
}

type LocalNodeRole = 'selected' | 'input' | 'output' | 'inout';

interface SugiyamaLayoutOptions {
  maxRowsPerColumn?: number;
  laneOffsetX?: number;
  laneOffsetY?: number;
  rowGap?: number;
  sideColumnGap?: number;
  sideNodeShiftX?: number;
  columnGap?: number;
}

const DEFAULT_MAX_ROWS_PER_COLUMN = 8;

export function buildLocalSugiyamaLayout(
  nodes: SimNode[],
  links: SimLink[],
  selectedNodeId: string,
  width: number,
  height: number,
  options: SugiyamaLayoutOptions = {}
): Map<string, { x: number; y: number }> {
  const roleMap = classifyLocalNodeRoles(nodes, links, selectedNodeId);
  const inputIds = nodes
    .filter((node) => roleMap.get(node.id) === 'input')
    .map((node) => node.id)
    .sort();
  const outputIds = nodes
    .filter((node) => roleMap.get(node.id) === 'output')
    .map((node) => node.id)
    .sort();
  const inOutIds = nodes
    .filter((node) => roleMap.get(node.id) === 'inout')
    .map((node) => node.id)
    .sort();

  const maxRows = Math.max(1, options.maxRowsPerColumn ?? DEFAULT_MAX_ROWS_PER_COLUMN);
  const laneOffsetX = options.laneOffsetX ?? 340;
  const laneOffsetY = options.laneOffsetY ?? 220;
  const rowGap = options.rowGap ?? 84;
  // Keep side lanes clear of the pivot card and spread multi-column side stacks more.
  const sideColumnGap = options.sideColumnGap ?? 260;
  const sideNodeShiftX = options.sideNodeShiftX ?? 240;
  const columnGap = options.columnGap ?? 210;
  const centerX = width * 0.5;
  const centerY = height * 0.5;

  const positions = new Map<string, { x: number; y: number }>();
  positions.set(selectedNodeId, { x: centerX, y: centerY });

  placeVerticalColumns(
    positions,
    inputIds,
    centerX - laneOffsetX - sideNodeShiftX,
    centerY,
    -sideColumnGap,
    rowGap,
    maxRows
  );
  placeVerticalColumns(
    positions,
    outputIds,
    centerX + laneOffsetX + sideNodeShiftX,
    centerY,
    sideColumnGap,
    rowGap,
    maxRows
  );

  const topCount = Math.ceil(inOutIds.length / 2);
  const topIds = inOutIds.slice(0, topCount);
  const bottomIds = inOutIds.slice(topCount);
  placeTopBottomColumns(positions, topIds, centerX, centerY - laneOffsetY, columnGap, rowGap, maxRows, true);
  placeTopBottomColumns(positions, bottomIds, centerX, centerY + laneOffsetY, columnGap, rowGap, maxRows, false);

  return positions;
}

function classifyLocalNodeRoles(nodes: SimNode[], links: SimLink[], selectedNodeId: string): Map<string, LocalNodeRole> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgesToSelected = new Set<string>();
  const edgesFromSelected = new Set<string>();

  for (const link of links) {
    const src = typeof link.source === 'string' ? link.source : link.source.id;
    const dst = typeof link.target === 'string' ? link.target : link.target.id;
    if (!nodeIds.has(src) || !nodeIds.has(dst)) {
      continue;
    }
    if (dst === selectedNodeId && src !== selectedNodeId) {
      edgesToSelected.add(src);
    }
    if (src === selectedNodeId && dst !== selectedNodeId) {
      edgesFromSelected.add(dst);
    }
  }

  const roles = new Map<string, LocalNodeRole>();
  for (const node of nodes) {
    if (node.id === selectedNodeId) {
      roles.set(node.id, 'selected');
      continue;
    }
    const hasEdgeTo = edgesToSelected.has(node.id);
    const hasEdgeFrom = edgesFromSelected.has(node.id);
    if (hasEdgeTo && hasEdgeFrom) {
      roles.set(node.id, 'inout');
    } else if (hasEdgeTo) {
      roles.set(node.id, 'input');
    } else if (hasEdgeFrom) {
      roles.set(node.id, 'output');
    } else {
      roles.set(node.id, 'inout');
    }
  }

  return roles;
}

function placeVerticalColumns(
  positions: Map<string, { x: number; y: number }>,
  nodeIds: string[],
  baseX: number,
  centerY: number,
  columnStepX: number,
  rowGap: number,
  maxRows: number
) {
  for (let index = 0; index < nodeIds.length; index += 1) {
    const column = Math.floor(index / maxRows);
    const row = index % maxRows;
    const rowsInColumn = Math.min(maxRows, nodeIds.length - column * maxRows);
    const y = centerY - ((rowsInColumn - 1) * rowGap) / 2 + row * rowGap;
    const x = baseX + column * columnStepX;
    positions.set(nodeIds[index], { x, y });
  }
}

function placeTopBottomColumns(
  positions: Map<string, { x: number; y: number }>,
  nodeIds: string[],
  centerX: number,
  baseY: number,
  columnGap: number,
  rowGap: number,
  maxRows: number,
  isTop: boolean
) {
  for (let index = 0; index < nodeIds.length; index += 1) {
    const column = Math.floor(index / maxRows);
    const row = index % maxRows;
    const band = Math.floor(column / 2) + 1;
    const direction = column % 2 === 0 ? -1 : 1;
    const x = centerX + direction * band * columnGap;
    const y = isTop ? baseY - row * rowGap : baseY + row * rowGap;
    positions.set(nodeIds[index], { x, y });
  }
}

