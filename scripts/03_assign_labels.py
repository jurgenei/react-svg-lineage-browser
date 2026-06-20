#!/usr/bin/env python3

"""
03_assign_labels.py

Assign business labels to nodes (Unix filter pattern).

Input:
    stdin or -i file

Output:
    stdout or -o file

Adds:
    domain
    stage
    business_label
"""

import argparse
import json
import re
import sys
from pathlib import Path
from collections import defaultdict, Counter


# ------------------------------------------
# Domain Keywords
# ------------------------------------------

DOMAIN_KEYWORDS = {

    "Counterparty": [
        "customer",
        "client",
        "counterparty",
        "party",
        "borrower",
        "obligor"
    ],

    "Collateral": [
        "collateral",
        "cover",
        "guarantee",
        "pledge"
    ],

    "Exposure": [
        "exposure",
        "facility",
        "contract",
        "loan",
        "limit"
    ],

    "Rating": [
        "rating",
        "grade",
        "scorecard"
    ],

    "PD": [
        "pd",
        "probability"
    ],

    "LGD": [
        "lgd",
        "loss"
    ],

    "EAD": [
        "ead"
    ],

    "RWA": [
        "rwa",
        "capital",
        "basel"
    ],

    "IFRS9": [
        "ifrs9",
        "ecl",
        "impairment",
        "provision"
    ],

    "Reporting": [
        "report",
        "dashboard",
        "mart",
        "summary"
    ]
}

# ------------------------------------------
# Helpers
# ------------------------------------------

def tokenize(text):

    text = re.sub(
        r'([a-z])([A-Z])',
        r'\1_\2',
        text
    )

    text = re.sub(
        r'[^A-Za-z0-9]',
        '_',
        text
    )

    return {
        t.lower()
        for t in text.split("_")
        if t
    }


# ------------------------------------------
# Stage Assignment
# ------------------------------------------

def determine_stage(node):

    xppr = node.get(
        "xppr",
        0.5
    )

    if xppr < 0.20:
        return "Source"

    if xppr < 0.40:
        return "Preprocessing"

    if xppr < 0.70:
        return "Calculation"

    if xppr < 0.90:
        return "Aggregation"

    return "Reporting"


# ------------------------------------------
# Cluster Domain Naming
# ------------------------------------------

def determine_cluster_domains(nodes):

    cluster_tokens = defaultdict(Counter)

    for node in nodes:

        cluster = node.get(
            "cluster",
            -1
        )

        label = node.get(
            "label",
            ""
        )

        tokens = tokenize(label)

        for token in tokens:
            cluster_tokens[cluster][token] += 1

    cluster_domains = {}

    for cluster, token_counts in cluster_tokens.items():

        best_domain = "Unknown"
        best_score = 0

        cluster_words = set(
            token_counts.keys()
        )

        for domain, keywords in DOMAIN_KEYWORDS.items():

            score = len(
                cluster_words &
                set(keywords)
            )

            if score > best_score:

                best_domain = domain
                best_score = score

        cluster_domains[cluster] = best_domain

    return cluster_domains


# ------------------------------------------
# Business Label
# ------------------------------------------

def create_business_label(
        category,
        domain,
        stage):

    parts = []

    if category:
        parts.append(category)

    if domain and domain != "Unknown":
        parts.append(domain)

    if stage:
        parts.append(stage)

    return " ".join(parts)


# ------------------------------------------
# Main Processing
# ------------------------------------------

def process_file(filename):

    print(f"\nProcessing {filename}")

    with open(
            filename,
            "r",
            encoding="utf-8"
    ) as f:

        graph = json.load(f)

    nodes = graph["nodes"]

    cluster_domains = determine_cluster_domains(
        nodes
    )

    for node in nodes:

        cluster = node.get(
            "cluster",
            -1
        )

        domain = cluster_domains.get(
            cluster,
            "Unknown"
        )

        stage = determine_stage(node)

        category = node.get(
            "dominant_category",
            node.get(
                "seed_category",
                "Unknown"
            )
        )

        business_label = create_business_label(
            category,
            domain,
            stage
        )

        node["domain"] = domain

        node["stage"] = stage

        node["business_label"] = (
            business_label
        )

    output_file = (
            Path(filename).stem
            + "_labelled.json"
    )

    with open(
            output_file,
            "w",
            encoding="utf-8"
    ) as f:

        json.dump(
            graph,
            f,
            indent=2
        )

    print(
        f"Written: {output_file}"
    )


# ------------------------------------------
# Main
# ------------------------------------------


def parse_args():
    parser = argparse.ArgumentParser(description="Assign business labels to nodes (Unix filter)")
    parser.add_argument("-i", "--input", help="Input JSON file. If omitted, reads from stdin.")
    parser.add_argument("-o", "--output", help="Output JSON file. If omitted, writes to stdout.")
    parser.add_argument("--glob", help="Glob pattern for batch mode.")
    return parser.parse_args()


def process_graph_stream(graph):
    """Assign labels to nodes in place."""
    nodes = graph.get("nodes", [])

    if not nodes:
        raise ValueError("Graph must have 'nodes'.")

    cluster_domains = determine_cluster_domains(nodes)

    for node in nodes:
        cluster = node.get("cluster", -1)
        domain = cluster_domains.get(cluster, "Unknown")
        stage = determine_stage(node)
        category = node.get("dominant_category", node.get("seed_category", "Unknown"))
        business_label = create_business_label(category, domain, stage)

        node["domain"] = domain
        node["stage"] = stage
        node["business_label"] = business_label

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

                output_file = input_file.with_stem(f"{input_file.stem}_labelled")
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
