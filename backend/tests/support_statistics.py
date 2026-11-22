import hashlib
from typing import Any

from httpx import AsyncClient

from app.nlp.contracts import (
    DecodedReadings,
    MaterialReadingToken,
    MaterialResourceReadings,
    TextResource,
)


def source(resource_id: str, text: str) -> TextResource:
    return TextResource(resource_id, text, hashlib.sha256(text.encode()).hexdigest())


def token(
    start: int,
    surface: str,
    *,
    form: str | None = None,
    pos: str = "名詞",
    reading: str = "",
    is_oov: bool = False,
) -> MaterialReadingToken:
    return MaterialReadingToken(
        start=start,
        end=start + len(surface),
        surface=surface,
        reading=reading,
        dictionary_form=surface if form is None else form,
        normalized_form=surface,
        pos=[pos, "*", "*", "*", "*", "*"],
        is_oov=is_oov,
    )


def characters(inputs: list[TextResource]) -> DecodedReadings:
    return DecodedReadings(
        configuration="{}",
        resources=[
            MaterialResourceReadings(
                resource_id=resource.resource_id,
                text_sha256=resource.text_sha256,
                tokens=[
                    token(
                        offset,
                        character,
                        pos="空白"
                        if character.isspace()
                        else "補助記号"
                        if character in "。！？"
                        else "名詞",
                    )
                    for offset, character in enumerate(resource.text)
                ],
            )
            for resource in inputs
        ],
    )


def vocabulary_sample() -> tuple[list[TextResource], DecodedReadings]:
    specifications = [
        ("生", "生", "セイ", "名詞", False),
        ("生", "生", "ナマ", "形状詞", True),
        ("生きた", "生きる", "イキタ", "動詞", False),
        ("生きる", "生きる", "イキル", "動詞", False),
        ("猫", "*", "ネコ", "名詞", False),
        ("猫", "", "ネコ", "名詞", False),
        ("犬", "犬", "イヌ", "名詞", False),
        ("。", "。", "。", "補助記号", False),
    ]
    inputs = [source("plain-text", " ".join(item[0] for item in specifications))]
    decoded = characters(inputs)
    records: list[MaterialReadingToken] = []
    offset = 0
    for surface, form, reading, pos, is_oov in specifications:
        records.append(token(offset, surface, form=form, reading=reading, pos=pos, is_oov=is_oov))
        offset += len(surface) + 1
    records.append(token(len(inputs[0].text), "", form="幽霊", reading="ユウレイ"))
    decoded.resources[0].tokens = records
    return inputs, decoded


async def seed(client: AsyncClient, raw: bytes = b"book") -> tuple[str, dict[str, Any]]:
    source = (await client.post("/api/sources", json={"title": "本棚"})).json()["id"]
    result = await client.post(
        f"/api/sources/{source}/materials",
        content=raw,
        headers={"content-type": "application/epub+zip"},
    )
    assert result.status_code == 200, result.text
    return source, result.json()["material"]
