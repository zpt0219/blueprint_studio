#!/usr/bin/env python3
"""Atomically manage the local game's active map, retaining every replaced patch."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile


def atomic_write(path, data):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".pending-")
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    folder, action = Path(sys.argv[1]), sys.argv[2]
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        active, previous = folder / "active.json", folder / "previous.json"
        if action == "status":
            print("Active map: " + str(active) if active.exists() else "Original AK map is active.")
            print("Rollback available." if previous.exists() else "No rollback patch.")
            return
        if action == "install":
            data = Path(sys.argv[3]).read_bytes()
            patch = json.loads(data)
            if patch.get("format") != "blueprint-world-patch":
                raise ValueError("Not an AK map patch")
        elif action == "restore":
            if not previous.exists():
                raise ValueError("No rollback patch")
            data = previous.read_bytes()
        elif action == "disable":
            data = None
        else:
            raise ValueError("Unknown operation")
        if active.exists():
            old = active.read_bytes()
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            atomic_write(folder / (stamp + ".json"), old)
            atomic_write(previous, old)
        if data is None:
            active.unlink(missing_ok=True)
        else:
            atomic_write(active, data)
        print("Map disabled. Restart the game to use the original." if data is None else
              "Map installed. Restart the desktop game / F5 to load it. Campaign progress is preserved.")


if __name__ == "__main__":
    main()
