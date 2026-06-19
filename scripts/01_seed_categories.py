#!/usr/bin/env python3

"""
01_seed_categories.py

Seed categorization for lineage graphs.

Classification precedence:

    1. Rules
        - regex
        - starts_with
        - ends_with
        - contains

    2. Keyword categories

    3. Schema default

Inputs:
    sdp.json
    dsa.json
    buss.json
    cons.json

    category_config.yaml

Outputs:
    sdp_seeded.json
    dsa_seeded.json
    buss_seeded.json
    cons_seeded.json
"""

import json
import re
from pathlib import Path

import yaml

# -------------------------------------------------------
# Configuration
# -------------------------------------------------------

# GRAPH_FILES = {
#     "SDP": "../build/sdp.json",
#     "DSA": "../build/dsa.json",
#     "BUSS": "../build/buss.json",
#     "CONS": "../build/cons.json"
# }

CONFIG_FILE = "category_config.yaml"

# -------------------------------------------------------
# Load Configuration
# -------------------------------------------------------


def load_config():

    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def _iter_file_lines(path: Path):

    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            yield line


def _normalize_from_files(value):

    if value is None:
        return []

    if isinstance(value, str):
        return [value]

    if isinstance(value, list):
        return [str(item) for item in value]

    raise TypeError(
        "category 'from' must be a string or list of strings"
    )


def build_keyword_index(config, config_path: Path):

    categories = config.get("categories", {})

    keyword_index = {}

    for category, cfg in categories.items():

        cfg = cfg or {}
        terms = {
            str(k).lower()
            for k in cfg.get("keywords", [])
            if str(k).strip()
        }

        for rel_path in _normalize_from_files(cfg.get("from")):

            source_path = (config_path.parent / rel_path).resolve()

            if not source_path.exists():
                raise FileNotFoundError(
                    f"Missing match list file for '{category}': {source_path}"
                )

            for term in _iter_file_lines(source_path):
                terms.add(term.lower())

        keyword_index[category] = terms

    return keyword_index


CONFIG = load_config()
CONFIG_PATH = Path(CONFIG_FILE).resolve()


GRAPH_FILES = {
    name: schema["file"]
    for name, schema in CONFIG["schemas"].items()
}

SCHEMA_DEFAULTS = {
    schema: cfg["default_category"]
    for schema, cfg in CONFIG["schemas"].items()
}

KEYWORDS = build_keyword_index(CONFIG, CONFIG_PATH)

SUBCATEGORIES = CONFIG.get(
    "subcategories",
    {}
)

RULES = sorted(
    CONFIG.get("rules", []),
    key=lambda r: r.get("priority", 0),
    reverse=True
)

# -------------------------------------------------------
# Name Processing
# -------------------------------------------------------


def tokenize_name(name):

    if not name:
        return set()

    # CustomerMaster -> Customer_Master
    name = re.sub(
        r'([a-z])([A-Z])',
        r'\1_\2',
        name
    )

    # normalize delimiters
    name = re.sub(
        r'[^A-Za-z0-9]',
        '_',
        name
    )

    return {
        token.lower()
        for token in name.split("_")
        if token
    }


def normalize_name(name):

    if not name:
        return ""

    name = re.sub(
        r'([a-z])([A-Z])',
        r'\1_\2',
        name
    )

    name = re.sub(
        r'[^A-Za-z0-9]',
        '_',
        name
    )

    name = re.sub(
        r'_+',
        '_',
        name
    ).strip('_')

    return name.lower()


# -------------------------------------------------------
# Rule Processing
# -------------------------------------------------------


def apply_rules(table_name):

    table_name = table_name.lower()

    for rule in RULES:

        rule_name = rule.get(
            "name",
            "unnamed_rule"
        )

        category = rule.get(
            "category"
        )

        match = rule.get(
            "match",
            {}
        )

        # ----------------------------------
        # Regex
        # ----------------------------------

        for pattern in match.get(
                "regex",
                []
        ):

            if re.match(
                    pattern,
                    table_name,
                    re.IGNORECASE
            ):
                return category, rule_name

        # ----------------------------------
        # Starts With
        # ----------------------------------

        for prefix in match.get(
                "starts_with",
                []
        ):

            if table_name.startswith(
                    prefix.lower()
            ):
                return category, rule_name

        # ----------------------------------
        # Ends With
        # ----------------------------------

        for suffix in match.get(
                "ends_with",
                []
        ):

            if table_name.endswith(
                    suffix.lower()
            ):
                return category, rule_name

        # ----------------------------------
        # Contains
        # ----------------------------------

        for text in match.get(
                "contains",
                []
        ):

            if text.lower() in table_name:
                return category, rule_name

    return None, None


# -------------------------------------------------------
# Keyword Classification
# -------------------------------------------------------


def classify_by_keywords(table_name):

    normalized_table = normalize_name(table_name)

    tokens = tokenize_name(table_name)

    best_category = None
    best_score = -1

    for category, keywords in KEYWORDS.items():

        score = 0

        for raw_keyword in keywords:
            keyword = normalize_name(raw_keyword)

            if not keyword:
                continue

            # Highest confidence: full normalized name match.
            if keyword == normalized_table:
                score += 100
                continue

            keyword_tokens = {
                t for t in keyword.split("_")
                if t
            }

            if not keyword_tokens:
                continue

            # Multi-token keywords are more specific than single-token terms.
            if len(keyword_tokens) > 1:
                if keyword_tokens.issubset(tokens):
                    score += 10 + len(keyword_tokens)
                continue

            # Single-token keyword match.
            if next(iter(keyword_tokens)) in tokens:
                score += 1

        if score > best_score:

            best_score = score
            best_category = category

    return best_category, best_score


# -------------------------------------------------------
# Categorization Logic
# -------------------------------------------------------


def determine_category(
        schema,
        table_name):

    # ----------------------------------
    # Rule Classification
    # ----------------------------------

    category, rule_name = apply_rules(
        table_name
    )

    if category:

        return {
            "category": category,
            "subcategory":
                SUBCATEGORIES.get(
                    category,
                    category
                ),
            "confidence": 1.0,
            "classification_source":
                rule_name,
            "keyword_matches": 0
        }

    # ----------------------------------
    # Keyword Classification
    # ----------------------------------

    category, score = classify_by_keywords(
        table_name
    )

    if category:

        return {
            "category": category,
            "subcategory":
                SUBCATEGORIES.get(
                    category,
                    category
                ),
            "confidence":
                min(
                    1.0,
                    0.50 + score * 0.15
                ),
            "classification_source":
                "keyword_match",
            "keyword_matches":
                score
        }

    # ----------------------------------
    # Schema Default
    # ----------------------------------

    category = SCHEMA_DEFAULTS.get(
        schema,
        "Unknown"
    )

    return {
        "category": category,
        "subcategory":
            SUBCATEGORIES.get(
                category,
                category
            ),
        "confidence": 0.50,
        "classification_source":
            "schema_default",
        "keyword_matches": 0
    }


# -------------------------------------------------------
# Source / Sink Detection
# -------------------------------------------------------


def detect_sources_and_sinks(
        nodes,
        edges):

    incoming = {
        node["id"]: 0
        for node in nodes
    }

    outgoing = {
        node["id"]: 0
        for node in nodes
    }

    for edge in edges:

        source = edge["source"]
        target = edge["target"]

        if source in outgoing:
            outgoing[source] += 1

        if target in incoming:
            incoming[target] += 1

    sources = {
        node_id
        for node_id, count
        in incoming.items()
        if count == 0
    }

    sinks = {
        node_id
        for node_id, count
        in outgoing.items()
        if count == 0
    }

    return sources, sinks


# -------------------------------------------------------
# Node Annotation
# -------------------------------------------------------


def annotate_nodes(
        schema,
        graph):

    nodes = graph["nodes"]
    edges = graph["edges"]

    sources, sinks = detect_sources_and_sinks(
        nodes,
        edges
    )

    for node in nodes:

        table_name = node.get(
            "label",
            node["id"]
        )

        result = determine_category(
            schema,
            table_name
        )

        node["schema"] = schema

        node["is_source"] = (
                node["id"] in sources
        )

        node["is_sink"] = (
                node["id"] in sinks
        )

        node["seed_category"] = (
            result["category"]
        )

        node["seed_subcategory"] = (
            result["subcategory"]
        )

        node["seed_confidence"] = (
            result["confidence"]
        )

        node["classification_source"] = (
            result["classification_source"]
        )

        node["keyword_matches"] = (
            result["keyword_matches"]
        )

    return graph


# -------------------------------------------------------
# Processing
# -------------------------------------------------------


def process_graph(
        schema,
        filename):

    print(
        f"\nProcessing {schema}"
    )
    print("-" * 50)

    with open(
            filename,
            "r",
            encoding="utf-8") as f:

        graph = json.load(f)

    annotate_nodes(
        schema,
        graph
    )

    output_file = (
        f"{Path(filename).stem}_seeded.json"
    )

    with open(
            output_file,
            "w",
            encoding="utf-8") as f:

        json.dump(
            graph,
            f,
            indent=2
        )

    print(
        f"Nodes : {len(graph['nodes'])}"
    )

    print(
        f"Edges : {len(graph['edges'])}"
    )

    print(
        f"Written: {output_file}"
    )


# -------------------------------------------------------
# Main
# -------------------------------------------------------


def main():

    print()
    print("=" * 60)
    print("SEED CATEGORY GENERATION")
    print("=" * 60)

    if not Path(
            CONFIG_FILE).exists():

        raise FileNotFoundError(
            f"Cannot find {CONFIG_FILE}"
        )

    for schema, filename in GRAPH_FILES.items():

        if not Path(
                filename).exists():

            print(
                f"WARNING: Missing {filename}"
            )

            continue

        process_graph(
            schema,
            filename
        )

    print()
    print("Finished.")


if __name__ == "__main__":
    main()