#!/usr/bin/env python3

import json
import argparse
import math
import networkx as nx


def load_graph(json_data):
    G = nx.DiGraph()

    for node in json_data["nodes"]:
        G.add_node(node["id"])

    for edge in json_data["edges"]:
        weight = edge.get("size", 1.0)
        G.add_edge(edge["source"], edge["target"], weight=weight)

    return G


# ✅ NEW: auto-seed logic
def find_autoseeds(G):
    seeds = [
        n for n in G.nodes()
        if G.in_degree(n) == 0 and G.out_degree(n) > 0
    ]
    return seeds


def build_personalization(G, seed_nodes):
    personalization = {n: 0.0 for n in G.nodes()}

    if not seed_nodes:
        return {n: 1.0 / len(G) for n in G.nodes()}

    for s in seed_nodes:
        if s in personalization:
            personalization[s] = 1.0

    total = sum(personalization.values())
    if total == 0:
        raise ValueError("None of the seed nodes exist in graph")

    return {k: v / total for k, v in personalization.items()}


def compute_ppr(G, seeds, alpha):
    personalization = build_personalization(G, seeds)

    return nx.pagerank(
        G,
        alpha=alpha,
        personalization=personalization,
        weight="weight"
    )


def normalize_minmax(scores):
    min_v = min(scores.values())
    max_v = max(scores.values())

    if max_v == min_v:
        return {k: 0.0 for k in scores}

    return {
        k: (v - min_v) / (max_v - min_v)
        for k, v in scores.items()
    }


def normalize_log_minmax(scores):
    log_scores = {
        k: math.log(v + 1e-12)
        for k, v in scores.items()
    }
    return normalize_minmax(log_scores)


def rank_normalize(scores):
    items = sorted(scores.items(), key=lambda x: x[1])
    n = len(items)

    result = {}
    for i, (node, _) in enumerate(items):
        result[node] = i / (n - 1) if n > 1 else 0.0

    return result


def annotate_nodes(data, ppr_scores, norm_scores, ppr_attr, xppr_attr, scale):
    for node in data["nodes"]:
        nid = node["id"]

        raw = ppr_scores.get(nid, 0.0)
        norm = norm_scores.get(nid, 0.0)

        node[ppr_attr] = raw
        node[xppr_attr] = norm * scale if scale else norm


def main():
    parser = argparse.ArgumentParser(
        description="Compute Personalized PageRank on SDP JSON graph"
    )

    parser.add_argument("-i", "--input", required=True)
    parser.add_argument("-o", "--output", required=True)

    parser.add_argument("--seeds", nargs="+", default=[])
    parser.add_argument("--autoseed", action="store_true")

    parser.add_argument("--alpha", type=float, default=0.85)

    parser.add_argument("-p", "--ppr", default="ppr")
    parser.add_argument("--xppr", default="xppr")

    parser.add_argument(
        "--normalize",
        choices=["none", "minmax", "log", "rank"],
        default="log"
    )

    parser.add_argument("--scale", type=float, default=None)

    args = parser.parse_args()

    # Load graph
    with open(args.input, "r") as f:
        data = json.load(f)

    G = load_graph(data)

    # ✅ seed selection logic
    if args.autoseed:
        seeds = find_autoseeds(G)
        if not seeds:
            print("WARNING: No autoseeds found, falling back to uniform distribution")
        else:
            print(f"Autoseeds selected ({len(seeds)}): {seeds[:10]}{'...' if len(seeds) > 10 else ''}")
    else:
        seeds = args.seeds

    # Compute PPR
    ppr_scores = compute_ppr(G, seeds, args.alpha)

    # Normalize
    if args.normalize == "none":
        norm_scores = ppr_scores
    elif args.normalize == "minmax":
        norm_scores = normalize_minmax(ppr_scores)
    elif args.normalize == "log":
        norm_scores = normalize_log_minmax(ppr_scores)
    elif args.normalize == "rank":
        norm_scores = rank_normalize(ppr_scores)

    # Annotate
    annotate_nodes(
        data,
        ppr_scores,
        norm_scores,
        args.ppr,
        args.xppr,
        args.scale
    )

    # Save
    with open(args.output, "w") as f:
        json.dump(data, f, indent=2)

    print(f"PPR computed for {len(G.nodes())} nodes")


if __name__ == "__main__":
    main()