#!/usr/bin/env python3

"""
04_remove_labels.py

Reads:
    *_labelled.json

Produces:
    *_cleaned.json

Removes selected keys from nodes based on a plain text file containing
one key per line.
"""

import argparse
import json
from pathlib import Path

DEFAULT_INPUT_FILES = [
    "sdp_seeded_propagated_labelled.json",
    "dsa_seeded_propagated_labelled.json",
    "buss_seeded_propagated_labelled.json",
    "cons_seeded_propagated_labelled.json",
]


def load_labels_to_remove(path: Path) -> set[str]:
    """Load node keys to remove from text file.

    Blank lines and lines starting with '#' are ignored.
    """
    labels: set[str] = set()

    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            labels.add(line)

    return labels


def remove_node_labels(graph: dict, labels_to_remove: set[str]) -> tuple[int, int]:
    """Remove requested labels from graph nodes in place.

    Returns:
        Tuple of (nodes_touched, total_keys_removed).
    """
    nodes = graph.get("nodes", [])
    nodes_touched = 0
    keys_removed = 0

    for node in nodes:
        removed_here = 0
        for key in labels_to_remove:
            if key in node:
                node.pop(key, None)
                removed_here += 1

        if removed_here > 0:
            nodes_touched += 1
            keys_removed += removed_here

    return nodes_touched, keys_removed


def process_file(input_file: Path, labels_to_remove: set[str], output_suffix: str) -> None:
    """Apply label removal to one graph file and write output."""
    print(f"\nProcessing {input_file}")

    with open(input_file, "r", encoding="utf-8") as f:
        graph = json.load(f)

    touched, removed = remove_node_labels(graph, labels_to_remove)

    output_file = input_file.with_name(f"{input_file.stem}{output_suffix}.json")

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(graph, f, indent=2)

    print(f"Nodes: {len(graph.get('nodes', []))}")
    print(f"Edges: {len(graph.get('edges', []))}")
    print(f"Node records changed: {touched}")
    print(f"Total keys removed: {removed}")
    print(f"Written: {output_file}")


def main() -> None:
    """Parse arguments and run label-removal pass over graph files."""
    parser = argparse.ArgumentParser(
        description="Remove selected node labels from graph JSON files"
    )

    parser.add_argument(
        "--labels-file",
        default="remove_node_labels.txt",
        help="Text file with one node key to remove per line",
    )

    parser.add_argument(
        "--input-files",
        nargs="*",
        default=DEFAULT_INPUT_FILES,
        help="Input graph JSON files to process",
    )

    parser.add_argument(
        "--output-suffix",
        default="_cleaned",
        help="Suffix appended to output file stem",
    )

    args = parser.parse_args()

    labels_path = Path(args.labels_file)
    if not labels_path.exists():
        raise FileNotFoundError(f"Cannot find labels file: {labels_path}")

    labels_to_remove = load_labels_to_remove(labels_path)
    if not labels_to_remove:
        print("No labels configured for removal; nothing to do.")
        return

    print()
    print("=" * 60)
    print("REMOVE NODE LABELS")
    print("=" * 60)
    print(f"Labels file: {labels_path}")
    print(f"Labels to remove: {sorted(labels_to_remove)}")

    for name in args.input_files:
        input_file = Path(name)

        if not input_file.exists():
            print(f"WARNING: Missing {input_file}")
            continue

        process_file(input_file, labels_to_remove, args.output_suffix)

    print("\nFinished.")


if __name__ == "__main__":
    main()

