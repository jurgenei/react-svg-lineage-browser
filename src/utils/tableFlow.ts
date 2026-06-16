import type { GraphData, GraphLink, GraphNode } from '../types/graph';

export function buildTableFlowGraph(data: GraphData, appId: string | null): GraphData {
  const tables = new Map<string, GraphNode>();
  let readsByProc = new Map<string, string[]>();
  let writesByProc = new Map<string, string[]>();
  const procSet = new Set<string>();

  const addToMap = (map: Map<string, string[]>, key: string, tableId: string) => {
    const current = map.get(key) ?? [];
    current.push(tableId);
    map.set(key, current);
  };

  for (const node of data.nodes) {
    if (node.type === 'table') {
      tables.set(node.id, node);
    }
  }

  if (appId) {
    const callAdj = new Map<string, string[]>();
    for (const link of data.links) {
      if (link.type === 'CALLS' && link.source.startsWith('proc:') && link.target.startsWith('proc:')) {
        const arr = callAdj.get(link.source) ?? [];
        arr.push(link.target);
        callAdj.set(link.source, arr);
      }
    }

    const roots: string[] = [];
    for (const link of data.links) {
      if (link.type === 'USES' && link.source === appId && link.target.startsWith('proc:')) {
        roots.push(link.target);
      }
    }

    const queue = [...roots];
    while (queue.length > 0) {
      const proc = queue.shift() as string;
      if (procSet.has(proc)) {
        continue;
      }
      procSet.add(proc);
      for (const child of callAdj.get(proc) ?? []) {
        if (!procSet.has(child)) {
          queue.push(child);
        }
      }
    }
  }

  const collectReadWrites = (filter: Set<string> | null) => {
    const reads = new Map<string, string[]>();
    const writes = new Map<string, string[]>();
    for (const link of data.links) {
      if (link.type === 'READS' && link.source.startsWith('tbl:') && link.target.startsWith('proc:')) {
        if (!filter || filter.has(link.target)) {
          addToMap(reads, link.target, link.source);
        }
      }
      if (link.type === 'WRITES' && link.source.startsWith('proc:') && link.target.startsWith('tbl:')) {
        if (!filter || filter.has(link.source)) {
          addToMap(writes, link.source, link.target);
        }
      }
    }
    return { reads, writes };
  };

  const filtered = collectReadWrites(appId ? procSet : null);
  readsByProc = filtered.reads;
  writesByProc = filtered.writes;

  if (appId && readsByProc.size === 0 && writesByProc.size === 0) {
    const fallback = collectReadWrites(null);
    readsByProc = fallback.reads;
    writesByProc = fallback.writes;
  }

  const flowByProcAndPair = new Map<string, { source: string; target: string; procedure: string; count: number }>();

  for (const proc of new Set([...readsByProc.keys(), ...writesByProc.keys()])) {
    const reads = readsByProc.get(proc) ?? [];
    const writes = writesByProc.get(proc) ?? [];
    for (const src of reads) {
      for (const dst of writes) {
        if (src === dst) {
          continue;
        }
        const key = `${src}|${dst}|${proc}`;
        const current = flowByProcAndPair.get(key);
        if (current) {
          current.count += 1;
        } else {
          flowByProcAndPair.set(key, { source: src, target: dst, procedure: proc, count: 1 });
        }
      }
    }
  }

  const links: GraphLink[] = [];
  const directPairProcedures = new Map<string, Set<string>>();
  for (const flow of flowByProcAndPair.values()) {
    const procLabel = flow.procedure.replace(/^proc:/, '');
    const pairKey = `${flow.source}|${flow.target}`;
    if (!directPairProcedures.has(pairKey)) {
      directPairProcedures.set(pairKey, new Set());
    }
    directPairProcedures.get(pairKey)?.add(procLabel);
    links.push({
      source: flow.source,
      target: flow.target,
      type: 'FLOW',
      edgeKey: `${flow.source}|${flow.target}|${flow.procedure}`,
      label: procLabel,
      procedures: [procLabel],
      weight: flow.count
    });
  }

  // Build transitive table-to-table relationships from direct table flows.
  // This keeps procedure provenance by collecting procedures observed along discovered paths.
  const adjacency = new Map<string, Array<{ next: string; procedures: Set<string> }>>();
  for (const [pairKey, procedures] of directPairProcedures.entries()) {
    const [source, target] = pairKey.split('|');
    const current = adjacency.get(source) ?? [];
    current.push({ next: target, procedures });
    adjacency.set(source, current);
  }

  const transitiveByPair = new Map<string, { procedures: Set<string>; pathCount: number }>();
  const MAX_DEPTH = 6;
  for (const source of adjacency.keys()) {
    const queue: Array<{ node: string; depth: number; procedures: Set<string> }> = [];
    for (const edge of adjacency.get(source) ?? []) {
      queue.push({ node: edge.next, depth: 1, procedures: new Set(edge.procedures) });
    }

    const seen = new Set<string>();
    while (queue.length > 0) {
      const state = queue.shift() as { node: string; depth: number; procedures: Set<string> };
      if (state.depth > MAX_DEPTH) {
        continue;
      }

      if (state.depth >= 2 && source !== state.node && !directPairProcedures.has(`${source}|${state.node}`)) {
        const key = `${source}|${state.node}`;
        const current = transitiveByPair.get(key);
        if (!current) {
          transitiveByPair.set(key, { procedures: new Set(state.procedures), pathCount: 1 });
        } else {
          for (const proc of state.procedures) {
            current.procedures.add(proc);
          }
          current.pathCount += 1;
        }
      }

      for (const edge of adjacency.get(state.node) ?? []) {
        const nextProcedures = new Set(state.procedures);
        for (const proc of edge.procedures) {
          nextProcedures.add(proc);
        }
        const signature = `${source}|${edge.next}|${[...nextProcedures].sort().join(',')}`;
        if (seen.has(signature)) {
          continue;
        }
        seen.add(signature);
        queue.push({ node: edge.next, depth: state.depth + 1, procedures: nextProcedures });
      }
    }
  }

  for (const [pair, info] of transitiveByPair.entries()) {
    const [source, target] = pair.split('|');
    const procedures = [...info.procedures].sort();
    links.push({
      source,
      target,
      type: 'FLOW_TRANSITIVE',
      edgeKey: `${source}|${target}|TRANSITIVE`,
      label: `transitive (${procedures.length})`,
      procedures,
      weight: info.pathCount
    });
  }

  const usedTableIds = new Set<string>();
  for (const link of links) {
    usedTableIds.add(link.source);
    usedTableIds.add(link.target);
  }

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const id of usedTableIds) {
    inDegree.set(id, 0);
    outDegree.set(id, 0);
  }
  for (const link of links) {
    outDegree.set(link.source, (outDegree.get(link.source) ?? 0) + 1);
    inDegree.set(link.target, (inDegree.get(link.target) ?? 0) + 1);
  }

  const nodes: GraphNode[] = [];
  for (const tableId of usedTableIds) {
    const table = tables.get(tableId);
    if (!table) {
      continue;
    }
    const inD = inDegree.get(tableId) ?? 0;
    const outD = outDegree.get(tableId) ?? 0;
    const directionality = outD > 0 && inD === 0 ? 'source' : inD > 0 && outD === 0 ? 'sink' : 'intermediate';
    nodes.push({
      ...table,
      directionality,
      group: directionality === 'source' ? 'source-tables' : directionality === 'sink' ? 'sink-tables' : 'intermediate-tables'
    });
  }

  return {
    nodes,
    links
  };
}

