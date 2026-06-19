#!/usr/bin/env python3

"""Annotate lineage graph JSON with flow rank and clustering metadata.

This script enriches a directed graph represented as JSON with:
- personalized PageRank-based source/sink scores,
- a normalized flow rank value between source and sink influence,
- strongly connected component (SCC) ids,
- Leiden cluster ids and y-axis cluster placement,
- shortest-path distances from selected sources and sinks.

Input format:
    {
      "nodes": [{"id": "..."}, ...],
      "edges": [{"source": "...", "target": "...", "size": 1.0}, ...]
    }

Output format:
    The same JSON, with node-level enrichment fields added in-place.
"""

import argparse
import json
from typing import Any, Optional

import networkx as nx
import igraph as ig
import leidenalg


def load_graph(json_data: dict[str, Any]) -> nx.DiGraph:
    """Load directed graph structure from lineage JSON payload.

    Args:
        json_data: Parsed JSON document containing ``nodes`` and ``edges`` arrays.

    Returns:
        A directed NetworkX graph with weighted edges.
    """
    G = nx.DiGraph()

    for node in json_data["nodes"]:
        G.add_node(node["id"])

    for edge in json_data["edges"]:
        G.add_edge(
            edge["source"],
            edge["target"],
            weight=edge.get("size", 1.0)
        )

    return G


def find_autoseeds(G: nx.DiGraph) -> list[str]:
    """Infer seed nodes as nodes with outflow and no inflow."""
    return [
        n for n in G.nodes()
        if G.in_degree(n) == 0 and G.out_degree(n) > 0
    ]


def find_autosinks(G: nx.DiGraph) -> list[str]:
    """Infer sink nodes as nodes with inflow and no outflow."""
    return [
        n for n in G.nodes()
        if G.out_degree(n) == 0 and G.in_degree(n) > 0
    ]


def build_personalization(G: nx.DiGraph, nodes: list[str]) -> dict[str, float]:
    """Create a valid personalization vector for PageRank.

    Args:
        G: Graph whose nodes are being ranked.
        nodes: Selected seed/sink nodes that receive unit mass before normalization.

    Returns:
        A node->probability mapping summing to 1.

    Raises:
        ValueError: If explicit ``nodes`` are provided but none exist in ``G``.
    """

    personalization = {
        node: 0.0
        for node in G.nodes()
    }

    if not nodes:
        return {
            node: 1.0 / len(G)
            for node in G.nodes()
        }

    for node in nodes:
        if node in personalization:
            personalization[node] = 1.0

    total = sum(personalization.values())

    if total == 0:
        raise ValueError(
            "None of supplied seed/sink nodes exist in graph"
        )

    return {
        k: v / total
        for k, v in personalization.items()
    }


def compute_ppr(
        G: nx.DiGraph,
        nodes: list[str],
        alpha: float
) -> dict[str, float]:
    """Compute personalized PageRank from source perspective."""

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
        G: nx.DiGraph,
        sink_nodes: list[str],
        alpha: float
) -> dict[str, float]:
    """Compute personalized PageRank on reversed graph from sink perspective."""

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
        G: nx.DiGraph,
        seed_nodes: list[str],
        sink_nodes: list[str],
        alpha: float
):
    """Blend source and sink PPR into a directional flow score per node.

    Returns:
        Tuple of ``(flow_scores, source_scores, sink_scores)``.
    """

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

    for node in seed_nodes:
        flow_scores[node] = 1.0

    for node in sink_nodes:
        flow_scores[node] = 0.0

    return (
        flow_scores,
        source_scores,
        sink_scores
    )


def compute_sccs(G: nx.DiGraph) -> tuple[dict[str, int], list[set[str]]]:
    """Compute strongly connected components and node->component mapping."""

    components = list(
        nx.strongly_connected_components(G)
    )

    node_to_scc = {}

    for idx, component in enumerate(components):
        for node in component:
            node_to_scc[node] = idx

    return (
        node_to_scc,
        components
    )


def compute_source_distance(
        G: nx.DiGraph,
        source_nodes: list[str]
) -> dict[str, Optional[int]]:
    """Compute shortest directed distance from any source to each node.

    Unreachable nodes receive ``None``.
    """

    result = {}

    for node in G.nodes():

        best = None

        for source in source_nodes:

            try:

                distance = nx.shortest_path_length(
                    G,
                    source,
                    node
                )

                if (
                        best is None
                        or distance < best
                ):
                    best = distance

            except nx.NetworkXNoPath:
                pass

        result[node] = best

    return result


def compute_sink_distance(
        G: nx.DiGraph,
        sink_nodes: list[str]
) -> dict[str, Optional[int]]:
    """Compute shortest directed distance from each node to nearest sink.

    Distances are computed on the reversed graph. Unreachable nodes receive
    ``None``.
    """

    reverse_graph = G.reverse(copy=True)

    result = {}

    for node in G.nodes():

        best = None

        for sink in sink_nodes:

            try:

                distance = nx.shortest_path_length(
                    reverse_graph,
                    sink,
                    node
                )

                if (
                        best is None
                        or distance < best
                ):
                    best = distance

            except nx.NetworkXNoPath:
                pass

        result[node] = best

    return result


def compute_leiden_clusters(
        G: nx.DiGraph,
        resolution: float = 0.1
) -> dict[str, int]:
    """Compute Leiden community clusters on an undirected projection.

    Args:
        G: Directed graph; direction is ignored for clustering.
        resolution: CPM resolution parameter; higher values yield more clusters.

    Returns:
        Mapping from node id to integer cluster id.
    """

    node_list = list(G.nodes())

    node_index = {
        node: idx
        for idx, node in enumerate(node_list)
    }

    edges = [
        (
            node_index[u],
            node_index[v]
        )
        for u, v in G.edges()
    ]

    if not edges:
        return {
            node: 0
            for node in node_list
        }

    ig_graph = ig.Graph(
        edges=edges,
        directed=False
    )

    partition = leidenalg.find_partition(
        ig_graph,
        leidenalg.CPMVertexPartition,
        resolution_parameter=resolution
    )

    cluster_map = {}

    for cluster_id, cluster in enumerate(partition):

        for vertex in cluster:
            cluster_map[
                node_list[vertex]
            ] = cluster_id

    return cluster_map


def build_cluster_positions(
        cluster_map: dict[str, int],
        scale: Optional[float] = None
) -> dict[int, dict[str, float]]:
    """Assign deterministic y-axis positions to cluster ids.

    Clusters are sorted by id and mapped linearly to [0, 1] (or [0, scale]).
    """

    clusters = sorted(
        set(cluster_map.values())
    )

    result = {}

    if not clusters:
        return result

    if len(clusters) == 1:

        value = scale / 2 if scale else 0.5

        result[clusters[0]] = {
            "rank": 0.5,
            "y": value
        }

        return result

    count = len(clusters)

    for idx, cluster in enumerate(clusters):

        rank = idx / (count - 1)

        if scale is not None:
            y_value = rank * scale
        else:
            y_value = rank

        result[cluster] = {
            "rank": rank,
            "y": y_value
        }

    return result


def annotate_nodes(
        data: dict[str, Any],
        flow_scores: dict[str, float],
        source_scores: dict[str, float],
        sink_scores: dict[str, float],
        scc_map: dict[str, int],
        source_distance: dict[str, Optional[int]],
        sink_distance: dict[str, Optional[int]],
        cluster_map: dict[str, int],
        cluster_y: dict[int, dict[str, float]],
        rank_attr: str,
        xppr_attr: str,
        xscale: Optional[float]
) -> None:
    """Write computed metrics into each node record in-place.

    The function updates source/sink PPR values, SCC id, cluster attributes,
    shortest-path distances, directional rank, and snapped/scaled xppr value.
    """

    for node in data["nodes"]:

        node_id = node["id"]

        flow = flow_scores.get(
            node_id,
            0.0
        )

        cluster = cluster_map.get(
            node_id,
            0
        )

        cluster_info = cluster_y.get(
            cluster,
            {
                "rank": 0.0,
                "y": 0.0
            }
        )

        node["source_ppr"] = (
            source_scores.get(node_id, 0.0)
        )

        node["sink_ppr"] = (
            sink_scores.get(node_id, 0.0)
        )

        node["scc"] = (
            scc_map.get(node_id, 0)
        )

        node["cluster"] = cluster

        node["cluster_rank"] = (
            cluster_info["rank"]
        )

        node["ycluster"] = (
            cluster_info["y"]
        )

        node["source_distance"] = (
            source_distance.get(node_id)
        )

        node["sink_distance"] = (
            sink_distance.get(node_id)
        )

        node[rank_attr] = flow

        snapped_flow = flow

        if snapped_flow > 0.95:
            snapped_flow = 1.0
        elif snapped_flow < 0.05:
            snapped_flow = 0.0

        if xscale is not None:
            node[xppr_attr] = (
                    snapped_flow * xscale
            )
        else:
            node[xppr_attr] = snapped_flow


def main() -> None:
    """Parse CLI arguments, run enrichment pipeline, and write output JSON."""

    parser = argparse.ArgumentParser(
        description=(
            "Flow Rank + SCC + Leiden clustering"
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
        "--resolution",
        type=float,
        default=0.1,
        help="Leiden resolution"
    )

    parser.add_argument(
        "--scale",
        type=float,
        default=1.0,
        help="Scale for xppr"
    )

    parser.add_argument(
        "--yscale",
        type=float,
        default=1.0,
        help="Scale for ycluster"
    )

    parser.add_argument(
        "--xppr",
        default="xppr"
    )

    parser.add_argument(
        "-p",
        "--ppr",
        default="flow_rank"
    )

    args = parser.parse_args()

    with open(args.input, "r") as f:
        data = json.load(f)

    G = load_graph(data)

    if args.autoseed:
        seeds = find_autoseeds(G)
    else:
        seeds = args.seeds

    if args.autosink:
        sinks = find_autosinks(G)
    else:
        sinks = args.sinks

    print(f"Sources: {len(seeds)}")
    print(f"Sinks: {len(sinks)}")

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

    (
        scc_map,
        sccs
    ) = compute_sccs(G)

    clusters = compute_leiden_clusters(
        G,
        args.resolution
    )

    cluster_y = build_cluster_positions(
        clusters,
        args.yscale
    )

    source_distance = (
        compute_source_distance(
            G,
            seeds
        )
    )

    sink_distance = (
        compute_sink_distance(
            G,
            sinks
        )
    )

    annotate_nodes(
        data,
        flow_scores,
        source_scores,
        sink_scores,
        scc_map,
        source_distance,
        sink_distance,
        clusters,
        cluster_y,
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
        f"Nodes: {len(G.nodes())}"
    )

    print(
        f"Edges: {len(G.edges())}"
    )

    print(
        f"SCC Count: {len(sccs)}"
    )

    print(
        f"Leiden Clusters: "
        f"{len(set(clusters.values()))}"
    )


if __name__ == "__main__":
    main()