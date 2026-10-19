"""Real offline tokenizer checks for codepoint fidelity and bounded inputs."""

import hashlib
import json
import zlib

import pytest

from app.nlp.contracts import TextResource
from app.nlp.tokenization import chunks, generate


@pytest.mark.parametrize("text", ["", "\n。！？", "𠮷Ａ㍿ｅ́\n日本語。次！", "日本語" * 20000])
def test_sentence_chunks_reconstruct_and_bound_utf8(text: str) -> None:
    values = chunks(text)
    assert "".join(value for _, value in values) == text
    assert all(len(value.encode()) <= 12000 for _, value in values)
    assert all(text[offset : offset + len(value)] == value for offset, value in values)


def test_real_a_tokens_preserve_surface_even_for_rewritten_compatibility_characters() -> None:
    text = "𠮷野家へ行った。ＡＢＣ ㍿ 飲みます。\n日本語"
    resources = [TextResource("r1", text, hashlib.sha256(text.encode()).hexdigest())]
    result = generate(resources)
    tokens = json.loads(zlib.decompress(result.payload))["resources"][0]["tokens"]
    assert "".join(t["surface"] for t in tokens) == text
    assert all(text[t["start"] : t["end"]] == t["surface"] for t in tokens)
    assert all(len(t["pos"]) == 6 for t in tokens)
    assert any(t["normalized_form"] != t["surface"] for t in tokens)
    assert any(t["start"] == t["end"] for t in tokens)  # ㍿ expands inside Sudachi.
    assert generate(resources).asset_sha256 == result.asset_sha256


def test_corrupt_resource_digest_is_rejected() -> None:
    with pytest.raises(ValueError, match="摘要"):
        generate([TextResource("r1", "日本語", "broken")])


def test_only_length_failures_are_retried() -> None:
    from sudachipy import errors

    from app.nlp.tokenization import Token, tokenize_chunk

    class LengthFailure:
        def tokenize(self, text: str, mode: object) -> list[Token]:
            raise errors.SudachiError("Input is too long, 65535 bytes")

    # Recursion reaches one character and reports the remaining failure.
    with pytest.raises(errors.SudachiError):
        tokenize_chunk(LengthFailure(), "日本語", 0)

    class OtherFailure:
        calls = 0

        def tokenize(self, text: str, mode: object) -> list[Token]:
            self.calls += 1
            raise errors.SudachiError("broken dictionary")

    failure = OtherFailure()
    with pytest.raises(errors.SudachiError, match="broken dictionary"):
        tokenize_chunk(failure, "日本語", 0)
    assert failure.calls == 1
