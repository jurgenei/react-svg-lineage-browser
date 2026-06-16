import { useEffect, useMemo, useState } from 'react';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3';
import type { SimLink, SimNode } from '../types/graph';

interface LayoutResult {
  nodes: SimNode[];
  links: SimLink[];
}

export function useForceLayout(
  nodes: SimNode[],
  links: SimLink[],
  width: number,
  height: number,
  groupOrder: string[]
): LayoutResult {
  const [layout, setLayout] = useState<LayoutResult>({ nodes, links });

  const seededNodes = useMemo(() => {
    const clone = nodes.map((node) => ({ ...node }));
    const depth = computeDepth(clone, links);

    for (const node of clone) {
      const nodeDepth = depth.get(node.id) ?? -1;
      node.depth = nodeDepth;
      const normalizedDepth = nodeDepth >= 0 ? nodeDepth / Math.max(1, maxDepth(depth)) : 0.5;

      const xByDepth = 80 + normalizedDepth * Math.max(120, width - 160);
      const xByDirectionality =
        node.directionality === 'source'
          ? width * 0.18
          : node.directionality === 'sink'
            ? width * 0.82
            : width * 0.5;

      node.x = Number.isFinite(xByDepth) ? 0.6 * xByDepth + 0.4 * xByDirectionality : xByDirectionality;
      const groupIndex = Math.max(0, groupOrder.indexOf(node.group));
      const bandHeight = Math.max(40, height / Math.max(2, groupOrder.length + 1));
      node.y = bandHeight * (groupIndex + 1);
    }

    return clone;
  }, [nodes, links, width, height, groupOrder]);

  useEffect(() => {
    if (!seededNodes.length) {
      setLayout({ nodes: seededNodes, links });
      return;
    }

    const size = seededNodes.length;
    const isLarge = size > 700;
    const isMedium = size > 260;
    const tickStride = isLarge ? 5 : isMedium ? 3 : 2;
    const chargeStrength = isLarge ? -320 : isMedium ? -430 : -560;
    const alphaDecay = isLarge ? 0.08 : isMedium ? 0.06 : 0.04;

    const linkForce = forceLink<SimNode, SimLink>(links)
      .id((d) => d.id)
      .distance((d) => {
        const base = d.type === 'CALLS' ? 130 : 110;
        const weight = d.weight ?? 1;
        return base + Math.min(120, weight * (isLarge ? 5 : 8));
      })
      .strength(0.18);

    const simulation = forceSimulation(seededNodes)
      .force('charge', forceManyBody().strength(chargeStrength))
      .force('link', linkForce)
      .force('collide', forceCollide<SimNode>().radius((d) => (d.isCluster ? 64 : 54)).iterations(6))
      .force(
        'x',
        forceX<SimNode>((node) => {
          const depthWeight = node.depth !== undefined && node.depth >= 0 ? node.depth / Math.max(1, maxDepthFromNodes(seededNodes)) : 0.5;
          const depthX = 70 + depthWeight * Math.max(120, width - 140);
          const directionalX =
            node.directionality === 'source'
              ? width * 0.14
              : node.directionality === 'sink'
                ? width * 0.86
                : width * 0.5;
          return 0.65 * depthX + 0.35 * directionalX;
        }).strength(0.22)
      )
      .force(
        'y',
        forceY<SimNode>((node) => {
          const groupIndex = Math.max(0, groupOrder.indexOf(node.group));
          const bandHeight = Math.max(48, height / Math.max(2, groupOrder.length + 1));
          return bandHeight * (groupIndex + 1);
        }).strength(0.18)
      )
      .alpha(1)
      .alphaDecay(alphaDecay)
      .velocityDecay(0.35);

    let frame = 0;
    simulation.on('tick', () => {
      frame += 1;
      if (frame % tickStride !== 0) {
        return;
      }
      setLayout({
        nodes: seededNodes.map((n) => ({ ...n })),
        links
      });
    });

    simulation.on('end', () => {
      setLayout({
        nodes: seededNodes.map((n) => ({ ...n })),
        links
      });
    });

    return () => {
      simulation.stop();
    };
  }, [seededNodes, links, width, height, groupOrder]);

  return layout;
}


function computeDepth(nodes: SimNode[], links: SimLink[]) {
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const link of links) {
    const src = typeof link.source === 'string' ? link.source : link.source.id;
    const dst = typeof link.target === 'string' ? link.target : link.target.id;
    outgoing.get(src)?.push(dst);
    inDegree.set(dst, (inDegree.get(dst) ?? 0) + 1);
  }

  const queue: string[] = [];
  const depth = new Map<string, number>();

  for (const [id, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(id);
      depth.set(id, 0);
    }
  }

  while (queue.length) {
    const id = queue.shift() as string;
    const currentDepth = depth.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      const nextDepth = Math.max(depth.get(next) ?? 0, currentDepth + 1);
      depth.set(next, nextDepth);
      inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
      if ((inDegree.get(next) ?? 0) === 0) {
        queue.push(next);
      }
    }
  }

  return depth;
}

function maxDepth(depth: Map<string, number>) {
  let max = 0;
  for (const value of depth.values()) {
    max = Math.max(max, value);
  }
  return max;
}

function maxDepthFromNodes(nodes: SimNode[]) {
  let max = 0;
  for (const node of nodes) {
    max = Math.max(max, node.depth ?? 0);
  }
  return max;
}
