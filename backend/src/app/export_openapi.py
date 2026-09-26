"""Write the deterministic OpenAPI contract without a server or database."""

import json

from app.config import REPO_ROOT
from app.main import app


def main() -> None:
    contract = json.dumps(app.openapi(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    (REPO_ROOT / "backend" / "openapi.json").write_text(contract, encoding="utf-8")


if __name__ == "__main__":
    main()
