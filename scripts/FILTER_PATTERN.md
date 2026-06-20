## Graph Processing Scripts - Unix Filter Pattern

All graph processing scripts now support the **Unix filter pattern**, enabling flexible piping and composition.

## Architecture

### Data Pipeline
```
Raw Graph → Categories → Components → Propagation → Labels → Cleaned
   (01)         (01)        (02)          (02)        (03)      (04)
```

### UI Layout Strategy
The **component-aware layout** uses `connected_component_id` from the seeding phase:
- **Largest component** (most nodes): rendered in center/right with force layout
- **Smaller components**: stacked left/top in ascending size order
- **Single-node subgraphs**: treated as component_id=N with size=1

Each subgraph gets its own spatial zone, growing downward within columns, new columns added rightward.



### 1. **stdin/stdout (pipe-friendly)**

Chain scripts directly:

```bash
cat input.json | script1.py | script2.py | script3.py > output.json
```

Example with component detection:
```bash
cat graph.json | python3 02_seed_components.py | python3 04_propagate_categories.py > processed.json
```

### 2. **File arguments (-i input, -o output)**

Process files with explicit paths:

```bash
python3 01_seed_categories.py -i input.json -o output1.json --schema BUSS
python3 02_seed_components.py -i output1.json -o output2.json
python3 04_propagate_categories.py -i output2.json -o output3.json
```

### 3. **Batch mode (--glob pattern)**

Process multiple files matching a pattern:

```bash
python3 02_seed_components.py --glob "*.json" --suffix "_components"
python3 04_propagate_categories.py --glob "*_seeded.json"
python3 03_assign_labels.py --glob "*_propagated.json"
```

## Scripts

### 01_seed_categories.py
**Classify nodes by category rules, keywords, and schema defaults**

```bash
# Filter mode
cat graph.json | ./01_seed_categories.py --schema BUSS > output.json

# File mode
./01_seed_categories.py -i graph.json -o output.json --schema BUSS

# Batch mode
./01_seed_categories.py --glob "*.json" --schema DSA

# In pipeline
cat input.json | ./01_seed_categories.py --schema BUSS | ./02_seed_components.py > final.json
```

Options:
- `-i, --input`: Input file (default: stdin)
- `-o, --output`: Output file (default: stdout)
- `--schema`: Schema name (BUSS, DSA, SDP, CONS)
- `--glob`: Batch glob pattern

### 02_seed_components.py
**Detect connected components and assign component IDs**

```bash
# Filter mode
cat graph.json | ./02_seed_components.py > output.json

# File mode
./02_seed_components.py -i graph.json -o output.json

# Batch mode
./02_seed_components.py --glob "*_seeded.json"

# In pipeline
cat input.json | ./02_seed_components.py | ./04_propagate_categories.py > output.json
```

Options:
- `-i, --input`: Input file (default: stdin)
- `-o, --output`: Output file (default: stdout)
- `--glob`: Batch glob pattern
- `--suffix`: Output suffix for batch mode (default: _components)

Outputs:
- `connected_component_id` on each node
- `metadata.connected_component_count` 
- `metadata.largest_connected_component_size`

### 02_propagate_categories.py
**Propagate category scores through graph edges**

```bash
# Filter mode
cat graph.json | ./04_propagate_categories.py > output.json

# File mode
./04_propagate_categories.py -i graph.json -o output.json

# In pipeline
cat input.json | ./01_seed_categories.py --schema BUSS | ./04_propagate_categories.py > output.json
```

Options:
- `-i, --input`: Input file (default: stdin)
- `-o, --output`: Output file (default: stdout)
- `--glob`: Batch glob pattern

Outputs:
- `category_scores` (dict of all categories with normalized scores)
- `dominant_category` (highest scoring category)
- `dominant_score` (normalized 0-1)
- `category_blend` (list of categories with score > 0.05)

### 03_assign_labels.py
**Assign business-friendly labels to nodes**

```bash
# Filter mode
cat graph.json | ./03_assign_labels.py > output.json

# File mode
./03_assign_labels.py -i graph.json -o output.json

# In pipeline
cat input.json | ./04_propagate_categories.py | ./03_assign_labels.py > output.json
```

Options:
- `-i, --input`: Input file (default: stdin)
- `-o, --output`: Output file (default: stdout)
- `--glob`: Batch glob pattern

Outputs:
- `domain` (e.g., "Customer Reference", "Operational")
- `stage` (Source, Preprocessing, Calculation, Aggregation, Reporting)
- `business_label` (combined human-readable label)

### 04_remove_labels.py
**Remove specified fields from nodes**

```bash
# Filter mode (removes fields in remove_node_labels.txt)
cat graph.json | ./05_remove_labels.py > output.json

# File mode
./05_remove_labels.py -i graph.json -o output.json

# Custom labels file
./05_remove_labels.py -i graph.json -o output.json --labels-file custom_fields.txt

# Batch mode
./05_remove_labels.py --glob "*_labelled.json" --labels-file remove_node_labels.txt
```

Options:
- `-i, --input`: Input file (default: stdin)
- `-o, --output`: Output file (default: stdout)
- `--labels-file`: Text file with fields to remove (one per line)
- `--glob`: Batch glob pattern
- `--output-suffix`: Output suffix for batch mode (default: _cleaned)

## Complete Pipeline Examples

### Full categorization + component detection:
```bash
cat graph.json \
  | python3 01_seed_categories.py --schema BUSS \
  | python3 02_seed_components.py \
  | python3 04_propagate_categories.py \
  | python3 03_assign_labels.py \
  | python3 05_remove_labels.py \
  > final_processed.json
```

### File-based pipeline with intermediate outputs:
```bash
python3 01_seed_categories.py -i raw.json -o step1_seeded.json --schema BUSS
python3 02_seed_components.py -i step1_seeded.json -o step2_components.json
python3 04_propagate_categories.py -i step2_components.json -o step3_propagated.json
python3 03_assign_labels.py -i step3_propagated.json -o step4_labelled.json
python3 05_remove_labels.py -i step4_labelled.json -o final.json
```

### Batch processing all files in a directory:
```bash
# Process all JSON files through full pipeline
for f in *.json; do
  cat "$f" \
    | python3 01_seed_categories.py --schema BUSS \
    | python3 02_seed_components.py \
    | python3 04_propagate_categories.py \
    | python3 03_assign_labels.py \
    > "processed_${f}"
done
```

## Notes

- **Errors to stderr**: All diagnostic messages go to stderr, so stdout remains clean for piping
- **Batch mode incompatible with filters**: When using `--glob`, file args (`-i`/`-o`) are ignored
- **Config files**: Scripts look for `category_config.yaml` and label files in the current directory
- **Large graphs**: For graphs > 1000 nodes, file-based mode is faster than piping long JSON strings


