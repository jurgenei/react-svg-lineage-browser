#!/usr/bin/env python3

"""
05_remove_labels.py

Remove selected node labels from graph (Unix filter pattern).

Reads from:
    stdin or -i file

Writes to:
    stdout or -o file

Removes node keys listed in a text file (one per line).
"""

import argparse
import json
import sys
from pathlib import Path



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


def main() -> int:
    """Parse arguments and run label-removal pass over graph files."""
    parser = argparse.ArgumentParser(
        description="Remove selected node labels from graph (Unix filter)"
    )

    parser.add_argument(
        "--labels-file",
        default="remove_node_labels.txt",
        help="Text file with one node key to remove per line",
    )

    parser.add_argument(
        "-i", "--input",
        help="Input JSON file. If omitted, reads from stdin."
    )

    parser.add_argument(
        "-o", "--output",
        help="Output JSON file. If omitted, writes to stdout."
    )

    parser.add_argument(
        "--glob",
        help="Glob pattern for batch mode."
    )

    parser.add_argument(
        "--output-suffix",
        default="_cleaned",
        help="Suffix for batch output files (default: _cleaned)."
    )

    args = parser.parse_args()

    labels_path = Path(args.labels_file)
    if not labels_path.exists():
        print(f"Cannot find labels file: {labels_path}", file=sys.stderr)
        return 1

    labels_to_remove = load_labels_to_remove(labels_path)
    if not labels_to_remove:
        print("No labels configured for removal.", file=sys.stderr)
        return 0

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

                touched, removed = remove_node_labels(graph, labels_to_remove)

                output_file = input_file.with_stem(f"{input_file.stem}{args.output_suffix}")
                with open(output_file, "w", encoding="utf-8") as f:
                    json.dump(graph, f, indent=2)

                print(f"Processed: {input_file} -> {output_file} (removed {removed} keys)", file=sys.stderr)
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
            touched, removed = remove_node_labels(graph, labels_to_remove)
            json.dump(graph, output_handle, indent=2)

            if args.input or args.output:
                print(f"Removed {removed} keys from {touched} nodes", file=sys.stderr)
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

