#!/bin/bash
# start script for kitten-tts server

cd "$(dirname "$0")"
source venv/bin/activate

# set up bundled espeak-ng for phonemizer
ESPEAK_LIB=$(python3 -c "import espeakng_loader; print(espeakng_loader.get_library_path())")
ESPEAK_DATA=$(python3 -c "import espeakng_loader; print(espeakng_loader.get_data_path())")
export PHONEMIZER_ESPEAK_LIBRARY="$ESPEAK_LIB"
export ESPEAK_DATA_PATH="$ESPEAK_DATA"

exec python server.py "$@"
