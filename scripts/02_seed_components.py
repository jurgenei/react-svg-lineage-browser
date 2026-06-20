#!/usr/bin/env python3

"""
02_seed_components.py

Annotate graph nodes with connected_component_id.

Default behavior:
- Reads *_seeded.json files from current working directory.
- Writes <name>_components.json next to each input file.

Supports graph payloads with either:
- {"nodes": [...], "edges": [...]} or
- {"nodes": [...], "links": [...]}.
"""

from __future__ import annotations

import argparse
import json
from collections import deque
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Seed connected_component_id into graph nodes (Unix filter pattern)"
    )
    parser.add_argument(
        "-i", "--input",
        help="Input graph JSON file. If omitted, reads from stdin."
    )
    parser.add_argument(
        "-o", "--output",
        help="Output JSON file. If omitted, writes to stdout."
    )
    parser.add_argument(
        "--glob",
        help="Glob pattern to match multiple input files (batch mode, incompatible with -i)."
    )
    parser.add_argument(
        "--suffix",
        default="_components",
        help="Suffix for batch output files (default: _components)."
    )
    return parser.parse_args()


def resolve_inputs(args: argparse.Namespace) -> list[Path]:
    if args.glob:
        return sorted(path.resolve() for path in Path.cwd().glob(args.glob))
    return []


def get_edges_array(graph: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
    if isinstance(graph.get("edges"), list):
        return graph["edges"], "edges"
    if isinstance(graph.get("links"), list):
        return graph["links"], "links"
    raise ValueError("Graph JSON must contain an array under 'edges' or 'links'.")


def build_undirected_adjacency(node_ids: set[str], edges: list[dict[str, Any]]) -> dict[str, set[str]]:
    adjacency: dict[str, set[str]] = {node_id: set() for node_id in node_ids}

    for edge in edges:
        source = edge.get("source")
        target = edge.get("target")
        if not isinstance(source, str) or not isinstance(target, str):
            continue
        if source not in adjacency or target not in adjacency:
            continue
        adjacency[source].add(target)
        adjacency[target].add(source)

    return adjacency


def detect_connected_components(node_ids: set[str], adjacency: dict[str, set[str]]) -> dict[str, int]:
    visited: set[str] = set()
    component_index = 0
    node_to_component: dict[str, int] = {}

    for root in sorted(node_ids):
        if root in visited:
            continue

        queue: deque[str] = deque([root])
        while queue:
            node_id = queue.popleft()
            if node_id in visited:
                continue

            visited.add(node_id)
            node_to_component[node_id] = component_index

            for neighbor in sorted(adjacency[node_id]):
                if neighbor not in visited:
                    queue.append(neighbor)

        component_index += 1

    return node_to_component


def annotate_graph(graph: dict[str, Any]) -> tuple[dict[str, Any], dict[str, int]]:
    raw_nodes = graph.get("nodes")
    if not isinstance(raw_nodes, list):
        raise ValueError("Graph JSON must contain a 'nodes' array.")

    edges, edge_key = get_edges_array(graph)
    _ = edge_key

    node_ids: set[str] = set()
    for node in raw_nodes:
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        if isinstance(node_id, str):
            node_ids.add(node_id)

    if not node_ids:
        raise ValueError("No valid node ids found in 'nodes'.")

    adjacency = build_undirected_adjacency(node_ids, edges)
    node_to_component = detect_connected_components(node_ids, adjacency)

    component_sizes: dict[int, int] = {}
    for node in raw_nodes:
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        if not isinstance(node_id, str):
            continue
        component_id = node_to_component.get(node_id, -1)
        node["connected_component_id"] = component_id
        component_sizes[component_id] = component_sizes.get(component_id, 0) + 1

    metadata = graph.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
        graph["metadata"] = metadata

    metadata["connected_component_count"] = len(component_sizes)
    metadata["largest_connected_component_size"] = max(component_sizes.values()) if component_sizes else 0

    stats = {
        "node_count": len(node_ids),
        "edge_count": len(edges),
        "component_count": len(component_sizes),
        "largest_component_size": max(component_sizes.values()) if component_sizes else 0,
        "isolated_component_count": sum(1 for size in component_sizes.values() if size == 1),
    }

    return graph, stats


def output_path_for(input_path: Path, suffix: str, in_place: bool) -> Path:
    if in_place:
        return input_path
    return input_path.with_name(f"{input_path.stem}{suffix}{input_path.suffix}")


def process_file(input_path: Path, suffix: str, in_place: bool) -> None:
    with input_path.open("r", encoding="utf-8") as handle:
        graph = json.load(handle)

    if not isinstance(graph, dict):
        raise ValueError("Top-level JSON must be an object.")

    graph, stats = annotate_graph(graph)
    out_path = output_path_for(input_path, suffix, in_place)

    with out_path.open("w", encoding="utf-8") as handle:
        json.dump(graph, handle, indent=2)

    print(f"Processed: {input_path}")
    print(
        f"  nodes={stats['node_count']} edges={stats['edge_count']} "
        f"components={stats['component_count']} largest={stats['largest_component_size']} "
        f"isolated_components={stats['isolated_component_count']}"
    )
    print(f"  wrote: {out_path}")


def process_stream(input_handle, output_handle) -> dict[str, int]:
    """Process graph from input handle and write to output handle. Returns stats."""
    graph = json.load(input_handle)

    if not isinstance(graph, dict):
        raise ValueError("Top-level JSON must be an object.")

    graph, stats = annotate_graph(graph)
    json.dump(graph, output_handle, indent=2)

    return stats


def main() -> int:
    import sys

    args = parse_args()

    # Batch mode: process multiple files with --glob
    if args.glob:
        inputs = resolve_inputs(args)
        if not inputs:
            print("No input files found. Use -i for single file or --glob for batch mode.")
            return 1
        failures = 0
        for input_path in inputs:
            try:
                process_file(input_path, args.suffix, False)
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAILED: {input_path}: {exc}", file=sys.stderr)
        if failures:
            print(f"Completed with {failures} failure(s).", file=sys.stderr)
            return 2
        print("Completed successfully.")
        return 0

    # Filter mode: single file or stdin/stdout
    try:
        if args.input:
            input_handle = open(args.input, "r", encoding="utf-8")
        else:
            input_handle = sys.stdin

        if args.output:
            output_handle = open(args.output, "w", encoding="utf-8")
        else:
            output_handle = sys.stdout

        try:
            stats = process_stream(input_handle, output_handle)
            if args.input or args.output:
                print(
                    f"Processed: nodes={stats['node_count']} edges={stats['edge_count']} "
                    f"components={stats['component_count']} largest={stats['largest_component_size']}",
                    file=sys.stderr
                )
        finally:
            if args.input:
                input_handle.close()
            if args.output:
                output_handle.close()

        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

