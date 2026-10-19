"""Full local asset validation uses only text resources, never EPUB chapters."""

import hashlib
import zlib

import pytest

from app.nlp import assets
from app.nlp.contracts import (
    DecodedReadings,
    MaterialReadingToken,
    MaterialResourceReadings,
    TextResource,
)
from app.nlp.tokenization import generate


def source(text: str = "日本語") -> TextResource:
    return TextResource("r1", text, hashlib.sha256(text.encode()).hexdigest())


def readings() -> DecodedReadings:
    return DecodedReadings(
        configuration="{}",
        resources=[
            MaterialResourceReadings(
                resource_id="r1",
                text_sha256=source().text_sha256,
                tokens=[
                    MaterialReadingToken(
                        start=0,
                        end=3,
                        surface="日本語",
                        reading="ニホンゴ",
                        dictionary_form="日本語",
                        normalized_form="日本語",
                        pos=["名詞", "普通名詞", "一般", "*", "*", "*"],
                        is_oov=False,
                    )
                ],
            )
        ],
    )


def encode(value: DecodedReadings) -> bytes:
    return zlib.compress(value.model_dump_json().encode())


def test_full_asset_is_available_without_a_chapter_and_does_not_change_input() -> None:
    inputs = (source("𠮷㍿。\n"), source(""), source("𠮷㍿。\n"))
    generated = generate(inputs)
    decoded = assets.decode(generated.payload, inputs)
    assert decoded.configuration == generated.configuration
    assert len(decoded.resources) == 3
    assert decoded.resources[0] == decoded.resources[2]
    assert decoded.resources[1].tokens == []
    assert sum(len(r.tokens) for r in decoded.resources) == generated.token_count
    assert any(t.start == t.end for t in decoded.resources[0].tokens)
    assert inputs[0].text == "𠮷㍿。\n"


@pytest.mark.parametrize("payload", [b"invalid zlib", b"", zlib.compress(b"{}")[:-1]])
def test_malformed_or_truncated_compressed_asset_is_rejected(payload: bytes) -> None:
    with pytest.raises(ValueError, match="压缩数据"):
        assets.decode(payload, [source()])


def test_trailing_compressed_data_is_rejected() -> None:
    with pytest.raises(ValueError, match="多余内容"):
        assets.decode(encode(readings()) + b"trailing", [source()])


def test_decoder_budget_accepts_exact_limit_and_rejects_larger_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value = readings()
    raw_size = len(value.model_dump_json().encode())
    monkeypatch.setattr(assets, "ASSET_BASE_BYTES", raw_size)
    monkeypatch.setattr(assets, "ASSET_RESOURCE_BYTES", 0)
    monkeypatch.setattr(assets, "ASSET_BYTES_PER_TEXT_BYTE", 0)
    assert assets.decode(encode(value), [source()]) == value
    monkeypatch.setattr(assets, "ASSET_BASE_BYTES", raw_size - 1)
    with pytest.raises(ValueError, match="解码预算"):
        assets.decode(encode(value), [source()])


@pytest.mark.parametrize(
    ("updates", "message"),
    [
        ({"end": 4}, "位置"),
        ({"start": 2, "end": 1}, "位置"),
        ({"surface": "別の原文"}, "位置"),
        ({"start": 1, "surface": "本語"}, "遗漏"),
        ({"end": 2, "surface": "日本"}, "遗漏"),
        ({"pos": ["名詞"]}, "六项"),
    ],
)
def test_invalid_token_or_missing_source_is_rejected(
    updates: dict[str, object], message: str
) -> None:
    value = readings()
    resource = value.resources[0]
    resource.tokens[0] = resource.tokens[0].model_copy(update=updates)
    with pytest.raises(ValueError, match=message):
        assets.decode(encode(value), [source()])


def test_overlapping_tokens_are_rejected() -> None:
    value = readings()
    value.resources[0].tokens.append(
        value.resources[0].tokens[0].model_copy(update={"start": 2, "end": 3, "surface": "語"})
    )
    with pytest.raises(ValueError, match="位置"):
        assets.decode(encode(value), [source()])


@pytest.mark.parametrize("field", ["resource_id", "text_sha256"])
def test_resource_identity_or_digest_mismatch_is_rejected(field: str) -> None:
    value = readings()
    value.resources[0] = value.resources[0].model_copy(update={field: "wrong"})
    with pytest.raises(ValueError, match="身份或正文摘要"):
        assets.decode(encode(value), [source()])


def test_resource_count_order_and_source_digest_are_verified() -> None:
    value = readings()
    with pytest.raises(ValueError, match="数量"):
        assets.decode(encode(value), [])
    with pytest.raises(ValueError, match="摘要"):
        assets.decode(encode(value), [TextResource("r1", "changed", source().text_sha256)])
    generated = generate([source(), TextResource("empty", "", source("").text_sha256)])
    with pytest.raises(ValueError, match="身份或正文摘要"):
        assets.decode(
            generated.payload,
            [TextResource("empty", "", source("").text_sha256), source()],
        )


def test_whitespace_gaps_and_empty_resource_list_remain_valid() -> None:
    value = readings()
    value.resources[0].text_sha256 = source(" 日本語 ").text_sha256
    value.resources[0].tokens[0] = (
        value.resources[0].tokens[0].model_copy(update={"start": 1, "end": 4})
    )
    assert assets.decode(encode(value), [source(" 日本語 ")]) == value
    assert assets.decode(generate([]).payload, []).resources == []


def test_multi_chunk_tokens_keep_resource_offsets_and_zero_width_metadata() -> None:
    text = "日本語" * 5000 + "。㍿"
    inputs = [source(text)]
    generated = generate(inputs)
    tokens = assets.decode(generated.payload, inputs).resources[0].tokens
    assert tokens[-1].end == len(text)
    assert "".join(token.surface for token in tokens) == text
    assert any(token.start == token.end for token in tokens)
