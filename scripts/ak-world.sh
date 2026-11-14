#!/usr/bin/env bash
set -euo pipefail

studio="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
project="${AK_PROJECT_DIR:-$studio/../asterfell-scene}"
godot="${GODOT_BIN:-/home/pt/apps/godot-4.6.2-csharp/Godot_v4.6.2-stable_mono_linux_x86_64/Godot_v4.6.2-stable_mono_linux.x86_64}"

case "${1:-}" in
  export|export-local)
    [[ $# -le 2 ]] || exit 2
    default_output="$studio/public/sample/ak-world.bptilemap"
    if [[ "$1" == export-local ]]; then default_output="$studio/ak-world.bptilemap.local"; fi
    output="$(realpath -m -- "${2:-$default_output}")"
    exec "$godot" --headless --path "$project" --script "$studio/scripts/ak-world.gd" -- "--$1" "$output"
    ;;
  test)
    [[ $# -eq 1 ]] || exit 2
    exec "$godot" --headless --path "$project" --script "$studio/scripts/verify-ak-terrain.gd"
    ;;
  install|disable|restore|status)
    [[ "$1" == install && $# -eq 2 || "$1" != install && $# -eq 1 ]] || exit 2
    if [[ "$1" == install ]]; then
      source_patch="$(realpath -e -- "$2")"
      patch="$(mktemp -t ak-map-install-XXXXXX.json)"
      trap 'rm -f -- "$patch"' EXIT
      cp -- "$source_patch" "$patch"
      "$godot" --headless --path "$project" --script "$studio/scripts/ak-world.gd" -- --check-patch "$patch"
    fi
    python3 "$studio/scripts/ak-patch-store.py" "$project/.studio" "$1" "${patch:-}"
    ;;
  play)
    [[ $# -eq 2 ]] || { echo "Provide the downloaded patch JSON file." >&2; exit 2; }
    patch="$(realpath -e -- "$2")"
    session_dir="$(mktemp -d -t ak-studio-XXXXXX)"
    trap 'rm -rf -- "$session_dir"' EXIT
    XDG_DATA_HOME="$session_dir" "$godot" --path "$project" --scene res://scenes/world/ak_world.tscn -- \
      --studio-world-patch "$patch" --studio-test-dir "$session_dir"
    ;;
  check|preview)
    [[ $# -eq 2 ]] || { echo "Provide the downloaded patch JSON file." >&2; exit 2; }
    patch="$(realpath -e -- "$2")"
    args=()
    if [[ "$1" == check ]]; then args+=(--headless); fi
    exec "$godot" "${args[@]}" --path "$project" --script "$studio/scripts/ak-world.gd" -- "--$1-patch" "$patch"
    ;;
  *)
    echo "Usage: $0 export [project.bptilemap] | export-local [project.bptilemap] | check patch.json | preview patch.json | play patch.json | install patch.json | disable | restore | status | test" >&2
    exit 2
    ;;
esac
