

CMDDIR=$(cd $(dirname $0); pwd)
FLAGS="-p xppr --autoseed --autosink  --resolution 0.03"
cd $CMDDIR
DIR=../../parsing/build/json
FILES=$(cd $DIR; ls -1 *.json)
for X in $FILES; do
    echo "## Processing $X"
    python3 ppr_leiden.py $FLAGS -i $DIR/$X -o ../build/$X
done