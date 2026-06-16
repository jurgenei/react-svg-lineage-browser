import sampleData from '../data/sample-lineage.json';
import bussData from '../data/buss-preprocessor.graph.json';
import type { GraphData } from '../types/graph';
import { buildTableFlowGraph } from './tableFlow';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function run() {
  const sampleFlow = buildTableFlowGraph(sampleData as unknown as GraphData, 'app:buss.preprocessor');
  assert(sampleFlow.nodes.length > 0, 'Sample flow graph has no nodes');
  assert(sampleFlow.links.length > 0, 'Sample flow graph has no links');

  const realFlow = buildTableFlowGraph(bussData as unknown as GraphData, 'app:buss.preprocessor');
  assert(realFlow.nodes.length > 0, 'Real flow graph has no nodes');
  assert(realFlow.links.length > 0, 'Real flow graph has no links');

  console.log(
    `tableFlow test passed: sample(${sampleFlow.nodes.length}/${sampleFlow.links.length}) real(${realFlow.nodes.length}/${realFlow.links.length})`
  );
}

run();

