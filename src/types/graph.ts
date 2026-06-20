export type NodeType = 'application' | 'dataset' | 'table' | 'transformation' | 'cluster';
export type Directionality = 'source' | 'intermediate' | 'sink';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  group: string;
  dominant_category?: string;
  directionality: Directionality;
  xppr?: number | string;
  ycluster?: number | string;
  connected_component_id?: number;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

export interface GraphLink {
  source: string;
  target: string;
  type: string;
  edgeKey?: string;
  label?: string;
  procedures?: string[];
  weight?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number | null;
  fy?: number | null;
  isCluster?: boolean;
  childCount?: number;
  depth?: number;
}

export interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
  type: string;
  edgeKey?: string;
  label?: string;
  procedures?: string[];
  weight?: number;
}
