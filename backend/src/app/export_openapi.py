"""Write the deterministic OpenAPI contract without a server or database."""

import json

from fastapi.openapi.utils import get_openapi

from app.config import REPO_ROOT
from app.main import app
from app.startup import router as startup_router


def main() -> None:
    schema = get_openapi(
        title=app.title,
        version=app.version,
        openapi_version=app.openapi_version,
        routes=[*app.routes, *startup_router.routes],
    )
    contract = json.dumps(schema, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    (REPO_ROOT / "backend" / "openapi.json").write_text(contract, encoding="utf-8")


if __name__ == "__main__":
    main()
