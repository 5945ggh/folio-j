"""Bounded decoding of trusted local analysis assets against their source text."""

import hashlib
import zlib
from collections.abc import Sequence

from app.nlp.contracts import DecodedReadings, TextResource

# These budgets grow with the source rather than imposing a smaller book limit.
# The per-byte allowance leaves room for compatibility expansion, lexical fields,
# and JSON overhead; repeated spine occurrences retain their own allowance.
ASSET_BASE_BYTES = 64 * 1024
ASSET_RESOURCE_BYTES = 1024
ASSET_BYTES_PER_TEXT_BYTE = 4096


def decode(payload: bytes, inputs: Sequence[TextResource]) -> DecodedReadings:
    """Read the full ordered asset without a chapter or reader dependency.

    This validates locally generated assets, not arbitrary external NLP packs.
    Original codepoint ranges, including zero-width tokens, stay unchanged.
    """
    limit = (
        ASSET_BASE_BYTES
        + len(inputs) * ASSET_RESOURCE_BYTES
        + sum(len(resource.text.encode()) for resource in inputs) * ASSET_BYTES_PER_TEXT_BYTE
    )
    try:
        stream = zlib.decompressobj()
        raw = stream.decompress(payload, limit + 1)
    except zlib.error as exc:
        raise ValueError("分词资产压缩数据无效") from exc
    if len(raw) > limit or stream.unconsumed_tail:
        raise ValueError("分词资产超过正文解码预算")
    if not stream.eof or stream.unused_data:
        raise ValueError("分词资产压缩数据不完整或含多余内容")
    result = DecodedReadings.model_validate_json(raw)
    if len(result.resources) != len(inputs):
        raise ValueError("分词资产资源数量与正文不一致")
    for resource, source in zip(result.resources, inputs, strict=True):
        digest = hashlib.sha256(source.text.encode()).hexdigest()
        if (
            resource.resource_id != source.resource_id
            or resource.text_sha256 != source.text_sha256
            or digest != source.text_sha256
        ):
            raise ValueError("分词资产资源身份或正文摘要不一致")
        previous = 0
        for token in resource.tokens:
            if (
                not previous <= token.start <= token.end <= len(source.text)
                or source.text[token.start : token.end] != token.surface
            ):
                raise ValueError("分词资产位置与原文不一致")
            if source.text[previous : token.start].strip():
                raise ValueError("分词资产遗漏原文")
            if len(token.pos) != 6:
                raise ValueError("分词资产词性字段不是六项")
            previous = token.end
        if source.text[previous:].strip():
            raise ValueError("分词资产遗漏原文结尾")
    return result
