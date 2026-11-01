"""Pre-B1 golden output captured with the locked local Sudachi dictionary."""

import json
import zlib
from pathlib import Path

from app.nlp.assets import decode
from app.nlp.contracts import TextResource
from app.nlp.tokenization import generate

FIXTURE = Path(__file__).parent / "fixtures/tokenization-v1.json"


def test_generation_keeps_pre_b1_configuration_payload_digest_and_count() -> None:
    expected = json.loads(FIXTURE.read_text(encoding="utf-8"))
    inputs = [TextResource(**resource) for resource in expected["input_resources"]]
    asset = generate(inputs)
    assert asset.configuration == expected["configuration"]
    assert zlib.decompress(asset.payload).decode() == expected["payload"]
    assert asset.asset_sha256 == expected["asset_sha256"]
    assert asset.token_count == expected["token_count"]
    assert decode(asset.payload, inputs).model_dump() == json.loads(expected["payload"])
    resources = json.loads(expected["payload"])["resources"]
    assert [resource["resource_id"] for resource in resources] == ["main", "empty", "main"]
    assert resources[1]["tokens"] == []
    assert resources[0] == resources[2]
    assert any(token["start"] == token["end"] for token in resources[0]["tokens"])
