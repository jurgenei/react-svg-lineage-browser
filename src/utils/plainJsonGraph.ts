import type { Directionality, GraphData, GraphLink, GraphNode, NodeType } from '../types/graph';

interface PlainGraphNode {
  id: string;
  label?: string;
  type?: string;
  group?: string;
  dominant_category?: string;
}

interface PlainGraphEdge {
  source: string;
  target: string;
  id?: string;
  label?: string;
  procedure?: string;
  type?: string;
  size?: number;
}

interface PlainJsonGraph {
  nodes: PlainGraphNode[];
  edges: PlainGraphEdge[];
}

const KNOWN_NODE_TYPES = new Set<NodeType>(['application', 'dataset', 'table', 'transformation', 'cluster']);

function normalizeNodeType(value: string | undefined): NodeType {
  if (value && KNOWN_NODE_TYPES.has(value as NodeType)) {
    return value as NodeType;
  }
  return 'table';
}

function inferDirectionality(nodeId: string, inDegree: Map<string, number>, outDegree: Map<string, number>): Directionality {
  const inD = inDegree.get(nodeId) ?? 0;
  const outD = outDegree.get(nodeId) ?? 0;
  if (outD > 0 && inD === 0) {
    return 'source';
  }
  if (inD > 0 && outD === 0) {
    return 'sink';
  }
  return 'intermediate';
}

export function parsePlainJsonGraph(content: string): GraphData {
  const parsed = JSON.parse(content) as Partial<PlainJsonGraph>;
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error('Invalid JSON graph format. Expected { nodes: [], edges: [] }.');
  }

  const links: GraphLink[] = parsed.edges.map((edge) => {
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      throw new Error('Invalid edge entry. Each edge must include string source and target.');
    }
    return {
      source: edge.source,
      target: edge.target,
      type: edge.type ?? 'FLOW',
      edgeKey: edge.id ?? `${edge.source}|${edge.target}|${edge.procedure ?? edge.label ?? 'FLOW'}`,
      label: edge.label ?? edge.procedure,
      weight: typeof edge.size === 'number' ? edge.size : 1
    };
  });

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const link of links) {
    outDegree.set(link.source, (outDegree.get(link.source) ?? 0) + 1);
    inDegree.set(link.target, (inDegree.get(link.target) ?? 0) + 1);
  }

  const nodes: GraphNode[] = parsed.nodes.map((node) => {
    if (!node || typeof node.id !== 'string') {
      throw new Error('Invalid node entry. Each node must include a string id.');
    }
    const type = normalizeNodeType(node.type);
    return {
      id: node.id,
      label: node.label ?? node.id,
      type,
      group: node.group ?? `${type}-nodes`,
      dominant_category: node.dominant_category,
      directionality: inferDirectionality(node.id, inDegree, outDegree)
    };
  });

  return { nodes, links };
}

