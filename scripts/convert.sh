FLAGS="-p xppr --autoseed --autosink"
DIR=/Users/cs79en/Developer/Projects/lineage/projects/parsing/build/json/
python3 bippr_tool.py $FLAGS -i $DIR/buss.json -o ../build/buss.ppr.json
python3 bippr_tool.py $FLAGS -i $DIR/cons.json -o ../build/cons.ppr.json
python3 bippr_tool.py $FLAGS -i $DIR/dsa.json  --o ../build/dsa.ppr.json
python3 bippr_tool.py $FLAGS -i $DIR/sdp.json  --o ../build/sdp.ppr.json

CMDDIR=$(cd $(dirname $0); pwd)
FLAGS="-p xppr --autoseed --autosink"
cd $CMDDIR
DIR=../../parsing/build/json
FILES=$(cd $DIR; ls -1 *.json)
for X in $FILES; do
    echo "## Processing $X"
    python3 ppr_leiden.py $FLAGS -i $DIR/$X -o ../build/$X
done