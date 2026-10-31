"""Read-only vocabulary pages using the bounded statistics computation runtime."""

import asyncio

from fastapi import HTTPException

from app.epub_schemas import CompiledBook
from app.epub_storage import decode as decode_epub
from app.nlp.assets import decode
from app.nlp.contracts import DecodedReadings, TextResource
from app.nlp.vocabulary import (
    VOCABULARY_RULE_VERSION,
    VocabularyOccurrence,
    VocabularyPage,
    VocabularySort,
    compute_occurrences,
    compute_vocabulary,
    normalize_query,
)
from app.services.epub_readings import text_resources
from app.services.statistics import (
    SessionFactory,
    StatisticsInput,
    load_bundle,
    load_payload,
    resolve_input,
    verify_input,
)
from app.services.statistics_runtime import StatisticsRuntime
from app.vocabulary_schemas import (
    MaterialVocabularyOccurrence,
    MaterialVocabularyOccurrencesPage,
    MaterialVocabularyOccurrencesResponse,
    MaterialVocabularyResponse,
)


def _decode(
    bundle: bytes, payload: bytes, configuration: str
) -> tuple[CompiledBook, list[TextResource], DecodedReadings]:
    book = decode_epub(bundle)
    inputs = text_resources(book)
    decoded = decode(payload, inputs)
    if decoded.configuration != configuration:
        raise ValueError("分词配置与资产不一致")
    return book, inputs, decoded


def _vocabulary_result(
    bundle: bytes,
    payload: bytes,
    configuration: str,
    query: str,
    pos: str | None,
    sort: VocabularySort,
    offset: int,
    limit: int,
) -> bytes:
    _, inputs, decoded = _decode(bundle, payload, configuration)
    return (
        compute_vocabulary(
            inputs, decoded, query=query, pos=pos, sort=sort, offset=offset, limit=limit
        )
        .model_dump_json()
        .encode()
    )


def _location(book: CompiledBook, item: VocabularyOccurrence) -> MaterialVocabularyOccurrence:
    # Counts use resource identity. Repeated spine presentations therefore map
    # each token to the first chapter containing its complete contiguous range.
    for chapter in book.chapters:
        for index, part in enumerate(chapter.parts):
            if part.resource_id != item.resource_id or not part.start <= item.start < part.end:
                continue
            end = part.end
            for following_index in range(index + 1, len(chapter.parts)):
                following = chapter.parts[following_index]
                if (
                    following.resource_id != part.resource_id
                    or following.spine_index != part.spine_index
                    or following.start != end
                    or end >= item.end
                ):
                    break
                end = following.end
            if end >= item.end:
                return MaterialVocabularyOccurrence(
                    chapter_id=chapter.id,
                    chapter_title=chapter.title,
                    part_index=index,
                    spine_index=part.spine_index,
                    resource_id=item.resource_id,
                    text_sha256=item.text_sha256,
                    start=item.start,
                    end=item.end,
                    before=item.before,
                    match=item.surface,
                    after=item.after,
                    reading=item.reading,
                    parts_of_speech=item.parts_of_speech,
                    is_oov=item.is_oov,
                )
    # Extractable source can straddle a chapter boundary or lack a presentation.
    # Keep the occurrence and count, while withholding an unverifiable jump.
    return MaterialVocabularyOccurrence(
        chapter_id=None,
        chapter_title=None,
        part_index=None,
        spine_index=None,
        resource_id=item.resource_id,
        text_sha256=item.text_sha256,
        start=item.start,
        end=item.end,
        before=item.before,
        match=item.surface,
        after=item.after,
        reading=item.reading,
        parts_of_speech=item.parts_of_speech,
        is_oov=item.is_oov,
    )


def _occurrences_result(
    bundle: bytes,
    payload: bytes,
    configuration: str,
    word: str,
    pos: str | None,
    offset: int,
    limit: int,
) -> bytes:
    book, inputs, decoded = _decode(bundle, payload, configuration)
    page = compute_occurrences(inputs, decoded, word, pos=pos, offset=offset, limit=limit)
    return (
        MaterialVocabularyOccurrencesPage(
            word=word,
            pos=pos,
            total=page.total,
            offset=offset,
            limit=limit,
            items=tuple(_location(book, item) for item in page.items),
        )
        .model_dump_json()
        .encode()
    )


async def _vocabulary(
    factory: SessionFactory,
    identity: StatisticsInput,
    query: str,
    pos: str | None,
    sort: VocabularySort,
    offset: int,
    limit: int,
) -> bytes:
    bundle = await load_bundle(factory, identity)
    payload = await load_payload(factory, identity)
    assert identity.configuration is not None
    try:
        return await asyncio.to_thread(
            _vocabulary_result,
            bundle,
            payload,
            identity.configuration,
            query,
            pos,
            sort,
            offset,
            limit,
        )
    except ValueError as exc:
        raise HTTPException(503, "词汇读取失败，请重试") from exc


async def _occurrences(
    factory: SessionFactory,
    identity: StatisticsInput,
    word: str,
    pos: str | None,
    offset: int,
    limit: int,
) -> bytes:
    bundle = await load_bundle(factory, identity)
    payload = await load_payload(factory, identity)
    assert identity.configuration is not None
    try:
        return await asyncio.to_thread(
            _occurrences_result, bundle, payload, identity.configuration, word, pos, offset, limit
        )
    except ValueError as exc:
        raise HTTPException(503, "词汇出现位置读取失败，请重试") from exc


async def get_vocabulary(
    factory: SessionFactory,
    runtime: StatisticsRuntime,
    material_id: str,
    version_id: str,
    generation_id: str | None = None,
    *,
    query: str = "",
    pos: str | None = None,
    sort: VocabularySort = "frequency_desc",
    offset: int = 0,
    limit: int = 40,
) -> MaterialVocabularyResponse:
    identity = await resolve_input(factory, material_id, version_id, generation_id)
    query = normalize_query(query)
    if identity.generation_id is None:
        page = VocabularyPage(
            query=query,
            pos=pos,
            sort=sort,
            total=0,
            offset=offset,
            limit=limit,
            available_pos=(),
            items=(),
        )
    else:
        key = (
            *identity.lexical_key(),
            "vocabulary",
            VOCABULARY_RULE_VERSION,
            query,
            pos or "",
            sort,
            str(offset),
            str(limit),
        )
        result = await runtime.get(
            key, lambda: _vocabulary(factory, identity, query, pos, sort, offset, limit)
        )
        page = VocabularyPage.model_validate_json(result)
    await verify_input(factory, identity)
    return MaterialVocabularyResponse(
        **page.model_dump(),
        material_id=material_id,
        version_id=version_id,
        generation_id=identity.generation_id,
        analysis_configuration=identity.configuration,
        status="ready" if identity.generation_id is not None else "unavailable",
    )


async def get_occurrences(
    factory: SessionFactory,
    runtime: StatisticsRuntime,
    material_id: str,
    version_id: str,
    generation_id: str,
    word: str,
    *,
    pos: str | None = None,
    offset: int = 0,
    limit: int = 40,
) -> MaterialVocabularyOccurrencesResponse:
    identity = await resolve_input(factory, material_id, version_id, generation_id)
    key = (
        *identity.lexical_key(),
        "vocabulary-occurrences",
        VOCABULARY_RULE_VERSION,
        word,
        pos or "",
        str(offset),
        str(limit),
    )
    result = await runtime.get(
        key, lambda: _occurrences(factory, identity, word, pos, offset, limit)
    )
    page = MaterialVocabularyOccurrencesPage.model_validate_json(result)
    await verify_input(factory, identity)
    assert identity.configuration is not None
    return MaterialVocabularyOccurrencesResponse(
        **page.model_dump(),
        material_id=material_id,
        version_id=version_id,
        generation_id=generation_id,
        analysis_configuration=identity.configuration,
    )
