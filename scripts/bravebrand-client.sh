#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG=''
export BUZZ_BUILDERLAB_URL=''
export VITE_BRAVEBRAND_SELF_HOSTED=true
exec bin/just desktop-bundle --config src-tauri/tauri.bravebrand-client.conf.json "$@"
