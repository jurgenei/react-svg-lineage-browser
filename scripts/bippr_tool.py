#!/usr/bin/env python3

import json
import argparse
import networkx as nx


def load_graph(json_data):
    G = nx.DiGraph()

    for node in json_data["nodes"]:
        G.add_node(node["id"])

    for edge in json_data["edges"]:
        weight = edge.get("size", 1.0)
        G.add_edge(
            edge["source"],
            edge["target"],
            weight=weight
        )

    return G


def find_autoseeds(G):
    return [
        n for n in G.nodes()
        if G.in_degree(n) == 0 and G.out_degree(n) > 0
    ]


def find_autosinks(G):
    return [
        n for n in G.nodes()
        if G.out_degree(n) == 0 and G.in_degree(n) > 0
    ]


def build_personalization(G, nodes):
    personalization = {
        n: 0.0
        for n in G.nodes()
    }

    if not nodes:
        return {
            n: 1.0 / len(G)
            for n in G.nodes()
        }

    for n in nodes:
        if n in personalization:
            personalization[n] = 1.0

    total = sum(personalization.values())

    if total == 0:
        raise ValueError(
            "None of the supplied nodes exist in graph"
        )

    return {
        k: v / total
        for k, v in personalization.items()
    }


def compute_ppr(G, nodes, alpha):
    personalization = build_personalization(
        G,
        nodes
    )

    return nx.pagerank(
        G,
        alpha=alpha,
        personalization=personalization,
        weight="weight"
    )


def compute_reverse_ppr(
        G,
        sink_nodes,
        alpha
):
    reverse_graph = G.reverse(copy=True)

    personalization = build_personalization(
        reverse_graph,
        sink_nodes
    )

    return nx.pagerank(
        reverse_graph,
        alpha=alpha,
        personalization=personalization,
        weight="weight"
    )


def compute_flow_rank(
        G,
        seed_nodes,
        sink_nodes,
        alpha
):
    source_scores = compute_ppr(
        G,
        seed_nodes,
        alpha
    )

    sink_scores = compute_reverse_ppr(
        G,
        sink_nodes,
        alpha
    )

    flow_scores = {}

    for node in G.nodes():

        source_score = source_scores.get(
            node,
            0.0
        )

        sink_score = sink_scores.get(
            node,
            0.0
        )

        total = source_score + sink_score

        if total > 0:
            flow_scores[node] = (
                    source_score / total
            )
        else:
            flow_scores[node] = 0.5

    # enforce exact endpoints

    for node in seed_nodes:
        flow_scores[node] = 1.0

    for node in sink_nodes:
        flow_scores[node] = 0.0

    return (
        flow_scores,
        source_scores,
        sink_scores
    )


def annotate_nodes(
        data,
        flow_scores,
        source_scores,
        sink_scores,
        rank_attr,
        xppr_attr,
        scale
):
    for node in data["nodes"]:

        node_id = node["id"]

        flow = flow_scores.get(
            node_id,
            0.0
        )

        node["source_ppr"] = (
            source_scores.get(node_id, 0.0)
        )

        node["sink_ppr"] = (
            sink_scores.get(node_id, 0.0)
        )

        node[rank_attr] = flow
        if flow > .95:
            flow = 1.0
        elif flow < .05:
            flow = 0.0
        if scale is not None:
            node[xppr_attr] = flow * scale
        else:
            node[xppr_attr] = flow


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Compute source-to-sink flow rank "
            "using bidirectional PPR"
        )
    )

    parser.add_argument(
        "-i",
        "--input",
        required=True
    )

    parser.add_argument(
        "-o",
        "--output",
        required=True
    )

    parser.add_argument(
        "--seeds",
        nargs="+",
        default=[]
    )

    parser.add_argument(
        "--sinks",
        nargs="+",
        default=[]
    )

    parser.add_argument(
        "--autoseed",
        action="store_true"
    )

    parser.add_argument(
        "--autosink",
        action="store_true"
    )

    parser.add_argument(
        "--alpha",
        type=float,
        default=0.85
    )

    parser.add_argument(
        "-p",
        "--ppr",
        default="flow_rank"
    )

    parser.add_argument(
        "--xppr",
        default="xppr"
    )

    parser.add_argument(
        "--scale",
        type=float,
        default=None,
        help="Scale xppr into layout width"
    )

    args = parser.parse_args()

    with open(args.input, "r") as f:
        data = json.load(f)

    G = load_graph(data)

    # source selection

    if args.autoseed:
        seeds = find_autoseeds(G)

        print(
            f"Autoseeds selected ({len(seeds)}): "
            f"{seeds[:10]}"
        )
    else:
        seeds = args.seeds

    # sink selection

    if args.autosink:
        sinks = find_autosinks(G)

        print(
            f"Autosinks selected ({len(sinks)}): "
            f"{sinks[:10]}"
        )
    else:
        sinks = args.sinks

    # compute ranking

    (
        flow_scores,
        source_scores,
        sink_scores
    ) = compute_flow_rank(
        G,
        seeds,
        sinks,
        args.alpha
    )

    annotate_nodes(
        data,
        flow_scores,
        source_scores,
        sink_scores,
        args.ppr,
        args.xppr,
        args.scale
    )

    with open(args.output, "w") as f:
        json.dump(
            data,
            f,
            indent=2
        )

    print("")
    print(
        f"Processed {len(G.nodes())} nodes "
        f"and {len(G.edges())} edges"
    )
    print(
        f"Source nodes: {len(seeds)}"
    )
    print(
        f"Sink nodes: {len(sinks)}"
    )


if __name__ == "__main__":
    main()