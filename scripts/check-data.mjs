import fs from 'node:fs';
import path from 'node:path';

const files = [
  '/Users/cs79en/Developer/Projects/lineage/projects/exploring/src/data/sample-lineage.json',
  '/Users/cs79en/Developer/Projects/lineage/projects/exploring/src/data/buss-preprocessor.graph.json'
];

for (const filePath of files.map((f) => path.resolve(f))) {
  if (!fs.existsSync(filePath)) {
    console.warn(`Skipping missing graph file: ${filePath}`);
    continue;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const graph = JSON.parse(raw);

  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  let badLinks = 0;
  for (const link of graph.links) {
    if (!nodeIds.has(link.source) || !nodeIds.has(link.target)) {
      badLinks += 1;
    }
  }

  if (badLinks > 0) {
    console.error(`Graph validation failed for ${path.basename(filePath)}: ${badLinks} links reference missing nodes.`);
    process.exit(1);
  }

  console.log(`Graph validation passed for ${path.basename(filePath)}: ${graph.nodes.length} nodes, ${graph.links.length} links.`);
}

