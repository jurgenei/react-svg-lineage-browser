

CMDDIR=$(cd $(dirname $0); pwd)
cd $CMDDIR
BUILD=../build
FILES=$(cd $BUILD; ls -1 *.json | grep -v staging)
ANNOTATED=$BUILD/annotated
mkdir -p $ANNOTATED
FILTERS="$(echo $(ls -1 [0-9]*.py | sed 's/\(.*\)/python3 \1 |/' ) | sed 's/|$//')"
echo "## Filters: $FILTERS"
for X in $FILES; do
    echo "## Processing $X"
    CMD="cat $BUILD/$X | $FILTERS > $ANNOTATED/$X"
    echo $CMD
    eval $CMD
done