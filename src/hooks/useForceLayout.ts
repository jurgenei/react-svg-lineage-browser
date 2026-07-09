import { useEffect, useMemo, useState } from 'react';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3';
import type { LayoutEngine, SimLink, SimNode } from '../types/graph';
import { getCategoryYPosition } from '../utils/categoryConfig';

interface LayoutResult {
  nodes: SimNode[];
  links: SimLink[];
}

export function useForceLayout(
  nodes: SimNode[],
  links: SimLink[],
  width: number,
  height: number,
  groupOrder: string[],
  nodeSizes: Map<string, { width: number; height: number }>,
  layoutEngine: LayoutEngine = 'auto'
): LayoutResult {
  const [layout, setLayout] = useState<LayoutResult>({ nodes, links });

  const seededNodes = useMemo(() => {
    const clone = nodes.map((node) => ({ ...node }));
    const depth = computeDepth(clone, links);
    const leftX = 40;
    const rightX = Math.max(leftX + 120, width - 220);
    const topY = 48;
    const bottomY = Math.max(topY + 120, height - 48);

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

        const fallbackX = Number.isFinite(xByDepth) ? 0.6 * xByDepth + 0.4 * xByDirectionality : xByDirectionality;
        const xppr = parseXppr(node.xppr);

        if (xppr !== null) {
          const xpprX = xpprToX(xppr, leftX, rightX);
          node.x = xpprX;
          if (xppr === 1 || xppr === 0) {
            // Keep extreme ranked nodes pinned on left/right rails.
            node.fx = xpprX;
          } else {
            node.fx = null;
          }
        } else {
          node.x = fallbackX;
          node.fx = null;
        }

         const categoryYNorm = getCategoryYPosition(node.dominant_category);
         const categoryY = topY + categoryYNorm * (bottomY - topY);
         node.y = categoryY;
         // Allow nodes to spread vertically around their category lane via forceY
         node.fy = null;
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
    const chargeStrength = isLarge ? -32 : isMedium ? -48 : -60;
    const alphaDecay = isLarge ? 0.14 : isMedium ? 0.11 : 0.09;
    const shouldPreferWebGpu = layoutEngine === 'webgpu' || (layoutEngine === 'auto' && size >= 320);
    let frame = 0;
    let disposed = false;
    let runningSimulation: { stop: () => void } | null = null;
    const lastGoodPosition = new Map<string, { x: number; y: number }>();
    for (const node of seededNodes) {
      if (Number.isFinite(node.x) && Number.isFinite(node.y)) {
        lastGoodPosition.set(node.id, { x: node.x, y: node.y });
      }
    }

    const publishLayout = () => {
      let repaired = 0;
      const nextNodes = seededNodes.map((node) => {
        const x = sanitizeCoordinate(node.x);
        const y = sanitizeCoordinate(node.y);
        const prior = lastGoodPosition.get(node.id);
        if (x === null || y === null) {
          repaired += 1;
        }
        const safeX = x ?? prior?.x ?? width * 0.5;
        const safeY = y ?? prior?.y ?? height * 0.5;
        lastGoodPosition.set(node.id, { x: safeX, y: safeY });
        return { ...node, x: safeX, y: safeY };
      });
      if (repaired > 0) {
        console.warn(`[useForceLayout] repaired ${repaired} invalid node coordinates (engine=${layoutEngine})`);
      }

      setLayout({
        nodes: nextNodes,
        links
      });
    };

    const wireSimulation = (simulation: {
      on: (event: string, cb: () => void) => unknown;
      stop: () => void;
      restart?: () => unknown;
      gpuReady?: () => Promise<void>;
    }) => {
      runningSimulation = simulation;
      simulation.on('tick', () => {
        frame += 1;
        if (frame % tickStride !== 0) {
          return;
        }
        publishLayout();
      });
      simulation.on('end', publishLayout);
    };

    const buildCpuSimulation = () => {
      const linkForce = forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance((d) => {
          const base = d.type === 'CALLS' ? 64 : 54;
          const weight = d.weight ?? 1;
          return base + Math.min(22, weight * (isLarge ? 1.5 : 2));
        })
        .strength(0.15);

      return forceSimulation(seededNodes)
        .force('charge', forceManyBody().strength(chargeStrength))
        .force('link', linkForce)
        .force(
          'collide',
          forceCollide<SimNode>()
            .radius((node) => getNodeCollisionRadius(node, nodeSizes))
            .iterations(isLarge ? 2 : isMedium ? 3 : 4)
        )
        .force(
          'x',
          forceX<SimNode>((node) => {
            const xppr = parseXppr(node.xppr);
            if (xppr !== null) {
              return xpprToX(xppr, 40, Math.max(160, width - 220));
            }
            const depthWeight = node.depth !== undefined && node.depth >= 0 ? node.depth / Math.max(1, maxDepthFromNodes(seededNodes)) : 0.5;
            const depthX = 70 + depthWeight * Math.max(120, width - 140);
            const directionalX =
              node.directionality === 'source'
                ? width * 0.14
                : node.directionality === 'sink'
                  ? width * 0.86
                  : width * 0.5;
            return 0.65 * depthX + 0.35 * directionalX;
          }).strength((node) => (parseXppr(node.xppr) !== null ? 0.94 : 0.32))
        )
        .force(
          'y',
          forceY<SimNode>((node) => {
            const categoryYNorm = getCategoryYPosition(node.dominant_category);
            const topBound = 48;
            const bottomBound = Math.max(168, height - 48);
            return topBound + categoryYNorm * (bottomBound - topBound);
          }).strength(() => 0.22)
        )
        .alpha(0.6)
        .alphaDecay(alphaDecay)
        .velocityDecay(0.4);
    };

    const startCpu = () => {
      if (disposed) {
        return;
      }
      const simulation = buildCpuSimulation();
      wireSimulation(simulation);
    };

    const startWebGpu = async () => {
      try {
        const webGpuForces = await import('d3-force-webgpu');
        if (disposed) {
          return;
        }

        const gpuSupported =
          typeof webGpuForces.checkWebGPUSupport === 'function'
            ? await webGpuForces.checkWebGPUSupport()
            : typeof navigator !== 'undefined' && 'gpu' in navigator;

        if (!gpuSupported) {
          if (layoutEngine === 'webgpu') {
            console.warn('WebGPU requested but unavailable. Falling back to CPU simulation.');
          }
          startCpu();
          return;
        }


        const linkForce = webGpuForces
          .forceLink(links)
          .id((d: SimNode) => d.id)
          .distance((d: SimLink) => {
            const base = d.type === 'CALLS' ? 64 : 54;
            const weight = d.weight ?? 1;
            return base + Math.min(22, weight * (isLarge ? 1.5 : 2));
          })
          .strength(0.15);

        const simulation = webGpuForces
          .forceSimulationGPU(seededNodes)
          .force('charge', webGpuForces.forceManyBody().strength(chargeStrength))
          .force('link', linkForce)
          .force(
            'collide',
            webGpuForces
              .forceCollide()
              .radius((node: SimNode) => getNodeCollisionRadius(node, nodeSizes))
              .iterations(isLarge ? 2 : isMedium ? 3 : 4)
          )
          .force(
            'x',
            webGpuForces.forceX((node: SimNode) => {
              const xppr = parseXppr(node.xppr);
              if (xppr !== null) {
                return xpprToX(xppr, 40, Math.max(160, width - 220));
              }
              const depthWeight = node.depth !== undefined && node.depth >= 0 ? node.depth / Math.max(1, maxDepthFromNodes(seededNodes)) : 0.5;
              const depthX = 70 + depthWeight * Math.max(120, width - 140);
              const directionalX =
                node.directionality === 'source'
                  ? width * 0.14
                  : node.directionality === 'sink'
                    ? width * 0.86
                    : width * 0.5;
              return 0.65 * depthX + 0.35 * directionalX;
            }).strength((node: SimNode) => (parseXppr(node.xppr) !== null ? 0.94 : 0.32))
          )
          .force(
            'y',
            webGpuForces
              .forceY((node: SimNode) => {
                const categoryYNorm = getCategoryYPosition(node.dominant_category);
                const topBound = 48;
                const bottomBound = Math.max(168, height - 48);
                return topBound + categoryYNorm * (bottomBound - topBound);
              })
              .strength(() => 0.22)
          )
          .alphaDecay(alphaDecay)
          .velocityDecay(0.4);

        // Wait for GPU to initialize before wiring event listeners
        if (typeof simulation.gpuReady === 'function') {
          await simulation.gpuReady();
        }
        if (disposed) {
          simulation.stop();
          return;
        }
        // Wire simulation AFTER GPU is ready, so ticks are properly emitted
        wireSimulation(simulation);
        // NOW start the simulation with alpha - after listeners are wired
        simulation.alpha(0.6);
      } catch (error) {
        console.warn('Unable to initialize d3-force-webgpu, using CPU simulation instead.', error);
        startCpu();
      }
    };

    if (shouldPreferWebGpu) {
      void startWebGpu();
    } else {
      startCpu();
    }

    return () => {
      disposed = true;
      runningSimulation?.stop();
    };
  }, [seededNodes, links, width, height, groupOrder, nodeSizes, layoutEngine]);


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

function parseXppr(value: number | string | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.max(0, Math.min(1, numeric));
}

function parseYcluster(value: number | string | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.max(0, Math.min(1, numeric));
}

function xpprToX(xppr: number, leftX: number, rightX: number): number {
  // xppr=1 maps to left, xppr=0 maps to right.
  return leftX + (1 - xppr) * Math.max(0, rightX - leftX);
}

function yclusterToY(ycluster: number, topY: number, bottomY: number): number {
  // ycluster=1 maps to top, ycluster=0 maps to bottom.
  return topY + (1 - ycluster) * Math.max(0, bottomY - topY);
}

function sanitizeCoordinate(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }
  // Reject extreme coordinates that can push the whole graph off-canvas.
  if (Math.abs(value) > 1_000_000) {
    return null;
  }
  return value;
}

function getNodeCollisionRadius(node: SimNode, nodeSizes: Map<string, { width: number; height: number }>) {
  const measured = nodeSizes.get(node.id);
  const fallbackWidth = node.isCluster ? 220 : 190;
  const fallbackHeight = node.isCluster ? 64 : 48;
  const width = measured?.width ?? fallbackWidth;
  const height = measured?.height ?? fallbackHeight;
  const padding = node.isCluster ? 18 : 12;
  return Math.hypot(width, height) / 2 + padding;
}
