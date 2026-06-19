#!/usr/bin/env python3

"""
03_assign_labels.py

Input:
    *_propagated.json

Output:
    *_labelled.json

Adds:

    domain
    stage
    business_label
"""

import json
import re
from pathlib import Path
from collections import defaultdict, Counter

INPUT_FILES = [
    "sdp_seeded_propagated.json",
    "dsa_seeded_propagated.json",
    "buss_seeded_propagated.json",
    "cons_seeded_propagated.json"
]

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

    print("\nFinished")


if __name__ == "__main__":
    main()