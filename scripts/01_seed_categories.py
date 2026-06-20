#!/usr/bin/env python3

"""
01_seed_categories.py

Seed categorization for lineage graphs (Unix filter pattern).

Supports:
  stdin/stdout: cat input.json | ./01_seed_categories.py > output.json
  file args:   ./01_seed_categories.py -i input.json -o output.json
  batch mode:  ./01_seed_categories.py --glob "*.json"

Inputs:
    stdin or -i file

Outputs:
    stdout or -o file
"""

import argparse
import json
import re
import sys
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


KEYWORDS = build_keyword_index(CONFIG, CONFIG_PATH)
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


def determine_category(table_name):

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
    # Unknown (no rule or keyword match)
    # ----------------------------------

    return {
        "category": "Unknown",
        "subcategory": "Unknown",
        "confidence": 0.0,
        "classification_source": "unknown",
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


def annotate_nodes(graph):

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

        result = determine_category(table_name)

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



# -------------------------------------------------------
# Main
# -------------------------------------------------------


def parse_args():
    parser = argparse.ArgumentParser(
        description="Seed categorization for lineage graphs (Unix filter)"
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
        help="Glob pattern to match multiple input files (batch mode)."
    )

    return parser.parse_args()


def annotate_graph_stream(graph):
    """Annotate a graph object in place with seed categories."""
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    
    if not nodes or not edges:
        raise ValueError("Graph must have 'nodes' and 'edges' arrays.")
    
    sources, sinks = detect_sources_and_sinks(nodes, edges)

    for node in nodes:
        table_name = node.get("label", node["id"])
        result = determine_category(table_name)

        node["is_source"] = node["id"] in sources
        node["is_sink"] = node["id"] in sinks
        node["seed_category"] = result["category"]
        node["seed_subcategory"] = result["subcategory"]
        node["seed_confidence"] = result["confidence"]
        node["classification_source"] = result["classification_source"]
        node["keyword_matches"] = result["keyword_matches"]

    return graph


def main():
    args = parse_args()

    # Batch mode
    if args.glob:
        input_files = sorted(Path.cwd().glob(args.glob))
        if not input_files:
            print(f"No files matching pattern: {args.glob}", file=sys.stderr)
            return 1
        
        for input_file in input_files:
            try:
                with open(input_file, "r", encoding="utf-8") as f:
                    graph = json.load(f)
                
                graph = annotate_graph_stream(graph)

                output_file = input_file.with_stem(f"{input_file.stem}_seeded")
                with open(output_file, "w", encoding="utf-8") as f:
                    json.dump(graph, f, indent=2)
                
                print(f"Processed: {input_file} -> {output_file}", file=sys.stderr)
            except Exception as e:
                print(f"FAILED {input_file}: {e}", file=sys.stderr)
                return 1
        
        print("Completed successfully.", file=sys.stderr)
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
            graph = json.load(input_handle)
            graph = annotate_graph_stream(graph)
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
