#!/usr/bin/env python3

import json
import argparse
import networkx as nx


def load_graph(json_data):
    G = nx.DiGraph()

    # Add nodes
    for node in json_data["nodes"]:
        G.add_node(node["id"])

    # Add edges
    for edge in json_data["edges"]:
        weight = edge.get("size", 1.0)
        G.add_edge(edge["source"], edge["target"], weight=weight)

    return G


def build_personalization(G, seed_nodes):
    personalization = {n: 0.0 for n in G.nodes()}

    if not seed_nodes:
        # fallback: uniform
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


def annotate_nodes(json_data, ppr_scores, prefix="ppr"):
    for node in json_data["nodes"]:
        nid = node["id"]
        node[prefix] = ppr_scores.get(nid, 0.0)


def main():
    parser = argparse.ArgumentParser(
        description="Compute Personalized PageRank on SDP JSON graph"
    )

    parser.add_argument("-i", "--input", required=True, help="Input JSON file")
    parser.add_argument("-o", "--output", required=True, help="Output JSON file")

    parser.add_argument(
        "--seeds",
        nargs="+",
        default=[],
        help="Seed node IDs for PPR"
    )

    parser.add_argument(
        "--alpha",
        type=float,
        default=0.85,
        help="Damping factor (default 0.85)"
    )

    parser.add_argument("-p", "--ppr", default="ppr", help="ppr attribute name in json")

    args = parser.parse_args()

    # Load JSON
    with open(args.input, "r") as f:
        data = json.load(f)

    # Build graph
    G = load_graph(data)

    # Compute PPR
    ppr_scores = compute_ppr(G, args.seeds, args.alpha)

    # Annotate
    annotate_nodes(data, ppr_scores, prefix=args.ppr)

    # Save
    with open(args.output, "w") as f:
        json.dump(data, f, indent=2)

    print(f"PPR computed for {len(G.nodes())} nodes")


if __name__ == "__main__":
    main()