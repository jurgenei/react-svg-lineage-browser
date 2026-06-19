#!/usr/bin/env python3

"""
02_propagate_categories.py

Reads:
    *_seeded.json

Produces:
    *_propagated.json

Adds:

    category_scores
    dominant_category
    category_blend
"""

import json
from pathlib import Path
from collections import defaultdict, deque

INPUT_FILES = [
    "sdp_seeded.json",
    "dsa_seeded.json",
    "buss_seeded.json",
    "cons_seeded.json",
]

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

def main():

    for filename in INPUT_FILES:

        if not Path(filename).exists():

            print(
                f"Missing: {filename}"
            )

            continue

        process_file(
            filename
        )

    print("\nDone")


if __name__ == "__main__":
    main()