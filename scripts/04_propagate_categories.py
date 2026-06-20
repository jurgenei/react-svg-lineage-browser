#!/usr/bin/env python3

"""
04_propagate_categories.py

Propagate categories through graph edges (Unix filter pattern).

Reads:
    stdin or -i file

Produces:
    stdout or -o file

Adds:
    category_scores
    dominant_category
    category_blend
"""

import argparse
import json
import sys
from pathlib import Path
from collections import defaultdict, deque


MAX_ITERATIONS = 10
DECAY = 0.85


# --------------------------------------------------
# Graph Utilities
# --------------------------------------------------

def build_indexes(nodes, edges):

    node_map = {
        n["id"]: n
        for n in nodes
    }

    parents = defaultdict(set)
    children = defaultdict(set)

    for edge in edges:

        src = edge["source"]
        tgt = edge["target"]

        parents[tgt].add(src)
        children[src].add(tgt)

    return node_map, parents, children


# --------------------------------------------------
# Category Initialization
# --------------------------------------------------

def initialize_scores(nodes):

    categories = set()

    for node in nodes:
        categories.add(
            node["seed_category"]
        )

    category_list = sorted(categories)

    for node in nodes:

        scores = {
            c: 0.0
            for c in category_list
        }

        scores[
            node["seed_category"]
        ] = node.get(
            "seed_confidence",
            1.0
        )

        node["category_scores"] = scores

    return category_list


# --------------------------------------------------
# Propagation
# --------------------------------------------------

def propagate(nodes, edges):

    node_map, parents, children = build_indexes(
        nodes,
        edges
    )

    category_list = initialize_scores(nodes)

    for _ in range(MAX_ITERATIONS):

        new_scores = {}

        for node in nodes:

            node_id = node["id"]

            current = node[
                "category_scores"
            ].copy()

            if node_id not in parents:
                new_scores[node_id] = current
                continue

            upstream = parents[node_id]

            accumulated = {
                c: 0.0
                for c in category_list
            }

            for parent_id in upstream:

                parent = node_map[parent_id]

                for cat, score in parent[
                    "category_scores"
                ].items():

                    accumulated[cat] += (
                            score * DECAY
                    )

            count = max(
                len(upstream),
                1
            )

            for cat in accumulated:
                accumulated[cat] /= count

            own_cat = node[
                "seed_category"
            ]

            accumulated[
                own_cat
            ] += node.get(
                "seed_confidence",
                0.5
            )

            new_scores[node_id] = accumulated

        for node in nodes:
            node["category_scores"] = (
                new_scores[node["id"]]
            )

    return nodes


# --------------------------------------------------
# Dominant Category
# --------------------------------------------------

def determine_primary_category(node):

    scores = node[
        "category_scores"
    ]

    total = sum(
        scores.values()
    )

    if total == 0:
        return

    normalized = {}

    for cat, value in scores.items():

        pct = value / total

        normalized[cat] = round(
            pct,
            4
        )

    dominant = max(
        normalized.items(),
        key=lambda x: x[1]
    )

    node[
        "category_scores"
    ] = normalized

    node[
        "dominant_category"
    ] = dominant[0]

    node[
        "dominant_score"
    ] = round(
        dominant[1],
        4
    )

    node[
        "category_blend"
    ] = [
        {
            "category": k,
            "score": v
        }
        for k, v in sorted(
            normalized.items(),
            key=lambda x: x[1],
            reverse=True
        )
        if v > 0.05
    ]


# --------------------------------------------------
# Processing
# --------------------------------------------------

def process_file(filename):

    print(f"\nProcessing {filename}")

    with open(
            filename,
            "r",
            encoding="utf-8"
    ) as f:

        graph = json.load(f)

    nodes = graph["nodes"]
    edges = graph["edges"]

    propagate(
        nodes,
        edges
    )

    for node in nodes:
        determine_primary_category(
            node
        )

    output = (
            Path(filename).stem
            + "_propagated.json"
    )

    with open(
            output,
            "w",
            encoding="utf-8"
    ) as f:

        json.dump(
            graph,
            f,
            indent=2
        )

    print(
        f"Written {output}"
    )


# --------------------------------------------------
# Main
# --------------------------------------------------


def parse_args():
    parser = argparse.ArgumentParser(description="Propagate categories through graph (Unix filter)")
    parser.add_argument("-i", "--input", help="Input JSON file. If omitted, reads from stdin.")
    parser.add_argument("-o", "--output", help="Output JSON file. If omitted, writes to stdout.")
    parser.add_argument("--glob", help="Glob pattern for batch mode.")
    return parser.parse_args()


def process_graph_stream(graph):
    """Process graph in place: propagate categories and determine dominants."""
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])

    if not nodes or not edges:
        raise ValueError("Graph must have 'nodes' and 'edges'.")

    propagate(nodes, edges)
    for node in nodes:
        determine_primary_category(node)

    return graph


def main():
    args = parse_args()

    # Batch mode
    if args.glob:
        input_files = sorted(Path.cwd().glob(args.glob))
        if not input_files:
            print(f"No files matching: {args.glob}", file=sys.stderr)
            return 1

        for input_file in input_files:
            try:
                with open(input_file, "r", encoding="utf-8") as f:
                    graph = json.load(f)

                graph = process_graph_stream(graph)

                output_file = input_file.with_stem(f"{input_file.stem}_propagated")
                with open(output_file, "w", encoding="utf-8") as f:
                    json.dump(graph, f, indent=2)

                print(f"Processed: {input_file} -> {output_file}", file=sys.stderr)
            except Exception as e:
                print(f"FAILED {input_file}: {e}", file=sys.stderr)
                return 1

        print("Completed successfully.", file=sys.stderr)
        return 0

    # Filter mode
    try:
        input_handle = open(args.input, "r", encoding="utf-8") if args.input else sys.stdin
        output_handle = open(args.output, "w", encoding="utf-8") if args.output else sys.stdout

        try:
            graph = json.load(input_handle)
            graph = process_graph_stream(graph)
            json.dump(graph, output_handle, indent=2)

            if args.input or args.output:
                print(f"Processed: {len(graph.get('nodes', []))} nodes", file=sys.stderr)
        finally:
            if args.input:
                input_handle.close()
            if args.output:
                output_handle.close()

        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
