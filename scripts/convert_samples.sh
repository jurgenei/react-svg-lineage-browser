
CMDDIR=$(cd $(dirname $0); pwd)
FLAGS="-p xppr --autoseed --autosink"
cd $CMDDIR
DIR=../src/data
PPR=$DIR/ppr
mkdir -p $PPR
FILES=$(cd $DIR; ls -1 *.json)
for X in $FILES; do
    echo "Processing $X"
    python3 ppr_leiden.py $FLAGS -i $DIR/$X -o $PPR/${X%.json}.ppr.json
done


