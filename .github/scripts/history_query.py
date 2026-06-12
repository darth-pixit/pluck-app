"""Query the Pluks history DB from the windows-smoke workflow.

Single source of truth for the schema in history.rs (table `history`,
columns id/content/copied_at) — this used to be four inline `python -c`
one-liners in windows-smoke.yml that each hard-coded the schema.

Usage (PLUKS_DB must point at pluck.db):
  history_query.py count <ENV_VAR>   print how many rows contain $ENV_VAR
  history_query.py dump              print every row (id, 80-char prefix, ts)
"""

import os
import sqlite3
import sys


def main() -> None:
    con = sqlite3.connect(os.environ["PLUKS_DB"])
    if len(sys.argv) > 2 and sys.argv[1] == "count":
        needle = os.environ[sys.argv[2]]
        rows = con.execute("SELECT content FROM history")
        print(sum(1 for (content,) in rows if needle in content))
    else:
        for row in con.execute(
            "SELECT id, substr(content, 1, 80), copied_at FROM history"
        ):
            print(row)


if __name__ == "__main__":
    main()
