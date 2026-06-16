#!/usr/bin/env python3
"""Generate GraphData JSON from buss.preprocessor.xml."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

XML_PATH = Path('/Users/cs79en/Developer/Projects/lineage/target/architecture/risk/app/buss.preprocessor.xml')
OUT_PATH = Path('/Users/cs79en/Developer/Projects/lineage/projects/exploring/src/data/buss-preprocessor.graph.json')


if __name__ == '__main__':
    root = ET.parse(XML_PATH).getroot()
    app_id = 'app:buss.preprocessor'

    procedures: set[str] = set()
    tables: set[str] = set()
    links: list[dict[str, str]] = []

    calls = root.find('./database/calls')
    if calls is not None:
        for call in calls.findall('./call'):
            root_proc = call.attrib.get('procedure')
            if not root_proc:
                continue
            procedures.add(root_proc)
            links.append({'source': app_id, 'target': f'proc:{root_proc}', 'type': 'USES'})

            stack: list[tuple[ET.Element, str]] = [(call, root_proc)]
            while stack:
                node, parent = stack.pop()
                for child in node.findall('./call'):
                    child_proc = child.attrib.get('procedure')
                    if not child_proc:
                        continue
                    procedures.add(child_proc)
                    links.append({'source': f'proc:{parent}', 'target': f'proc:{child_proc}', 'type': 'CALLS'})
                    stack.append((child, child_proc))

    for tables_node in root.findall('./database/tables'):
        mode = tables_node.attrib.get('mode')
        if mode not in ('reader', 'writer'):
            continue

        edge_type = 'READS' if mode == 'reader' else 'WRITES'
        for table in tables_node.findall('./table'):
            table_name = table.attrib.get('name')
            if not table_name:
                continue
            table_id = f'tbl:{table_name}'
            tables.add(table_name)

            proc_refs = [p.attrib.get('name') for p in table.findall('./procedure') if p.attrib.get('name')]
            if proc_refs:
                for proc in proc_refs:
                    procedures.add(proc)
                    if edge_type == 'READS':
                        links.append({'source': table_id, 'target': f'proc:{proc}', 'type': edge_type})
                    else:
                        links.append({'source': f'proc:{proc}', 'target': table_id, 'type': edge_type})
            else:
                if edge_type == 'READS':
                    links.append({'source': table_id, 'target': app_id, 'type': edge_type})
                else:
                    links.append({'source': app_id, 'target': table_id, 'type': edge_type})

    seen: set[tuple[str, str, str]] = set()
    dedup_links: list[dict[str, str]] = []
    for link in links:
        key = (link['source'], link['target'], link['type'])
        if key in seen:
            continue
        seen.add(key)
        dedup_links.append(link)

    in_degree: dict[str, int] = defaultdict(int)
    out_degree: dict[str, int] = defaultdict(int)
    for link in dedup_links:
        out_degree[link['source']] += 1
        in_degree[link['target']] += 1

    def directionality(node_id: str) -> str:
        i = in_degree[node_id]
        o = out_degree[node_id]
        if o > 0 and i == 0:
            return 'source'
        if i > 0 and o == 0:
            return 'sink'
        return 'intermediate'

    nodes: list[dict[str, object]] = [
        {
            'id': app_id,
            'type': 'application',
            'label': 'buss.preprocessor',
            'group': 'app',
            'directionality': directionality(app_id),
            'metadata': {'source': 'buss.preprocessor.xml'},
        }
    ]

    for proc in sorted(procedures):
        nodes.append(
            {
                'id': f'proc:{proc}',
                'type': 'transformation',
                'label': proc,
                'group': 'procedures',
                'directionality': directionality(f'proc:{proc}'),
                'metadata': {'kind': 'procedure'},
            }
        )

    for table_name in sorted(tables):
        nodes.append(
            {
                'id': f'tbl:{table_name}',
                'type': 'table',
                'label': table_name,
                'group': 'tables',
                'directionality': directionality(f'tbl:{table_name}'),
                'metadata': {'kind': 'table'},
            }
        )

    OUT_PATH.write_text(json.dumps({'nodes': nodes, 'links': dedup_links}), encoding='utf-8')
    print(f'Wrote {OUT_PATH} with {len(nodes)} nodes and {len(dedup_links)} links')

