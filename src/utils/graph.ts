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

