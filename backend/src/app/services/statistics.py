"""Read-only statistics over immutable material text and exact analysis generations."""

import asyncio
import unicodedata
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.epub_storage import decode as decode_epub
from app.material_models import Material, MaterialReadingsCurrent, MaterialReadingsGeneration
from app.models import Source
from app.nlp.assets import decode
from app.nlp.statistics import (
    LEXICAL_RULE_VERSION,
    TEXT_RULE_VERSION,
    LexicalStatistics,
    TextStatistics,
    compute_lexical,
    compute_text,
)
from app.services.epub_readings import text_resources
from app.services.statistics_runtime import CacheKey, StatisticsRuntime
from app.statistics_schemas import MaterialStatisticsResponse

SessionFactory = async_sessionmaker[AsyncSession]


@dataclass(frozen=True)
class StatisticsInput:
    material_id: str
    version_id: str
    product_sha256: str
    generation_id: str | None
    asset_sha256: str | None
    configuration: str | None

    def text_key(self) -> CacheKey:
        return (
            "text",
            self.material_id,
            self.version_id,
            self.product_sha256,
            TEXT_RULE_VERSION,
            unicodedata.unidata_version,
        )

    def lexical_key(self) -> CacheKey:
        assert self.generation_id is not None
        assert self.asset_sha256 is not None
        assert self.configuration is not None
        return (
            "lexical",
            self.material_id,
            self.version_id,
            self.product_sha256,
            self.generation_id,
            self.asset_sha256,
            self.configuration,
            LEXICAL_RULE_VERSION,
        )


async def _identity(
    factory: SessionFactory, material_id: str, version_id: str, generation_id: str | None
) -> StatisticsInput:
    async with factory() as session:
        material = (
            await session.execute(
                select(Material.version_id, Material.product_sha256)
                .join(Source, Material.source_id == Source.id)
                .where(
                    Material.id == material_id,
                    Material.deleted_at.is_(None),
                    Source.deleted_at.is_(None),
                )
            )
        ).one_or_none()
        if material is None:
            raise HTTPException(404, "材料不存在")
        if material.version_id != version_id:
            raise HTTPException(409, "材料版本已改变")
        statement = select(
            MaterialReadingsGeneration.id,
            MaterialReadingsGeneration.asset_sha256,
            MaterialReadingsGeneration.configuration,
        ).where(
            MaterialReadingsGeneration.material_id == material_id,
            MaterialReadingsGeneration.version_id == version_id,
        )
        if generation_id is None:
            statement = statement.join(
                MaterialReadingsCurrent,
                MaterialReadingsCurrent.generation_id == MaterialReadingsGeneration.id,
            ).where(MaterialReadingsCurrent.material_id == material_id)
        else:
            statement = statement.where(MaterialReadingsGeneration.id == generation_id)
        asset = (await session.execute(statement)).one_or_none()
        if generation_id is not None and asset is None:
            raise HTTPException(404, "分词代次不存在")
        return StatisticsInput(
            material_id,
            version_id,
            material.product_sha256,
            asset.id if asset else None,
            asset.asset_sha256 if asset else None,
            asset.configuration if asset else None,
        )


async def _bundle(factory: SessionFactory, identity: StatisticsInput) -> bytes:
    async with factory() as session:
        result = await session.scalar(
            select(Material.compiled_bundle)
            .join(Source, Material.source_id == Source.id)
            .where(
                Material.id == identity.material_id,
                Material.deleted_at.is_(None),
                Material.version_id == identity.version_id,
                Material.product_sha256 == identity.product_sha256,
                Source.deleted_at.is_(None),
            )
        )
        if result is None:
            raise HTTPException(404, "材料不存在")
        return result


def _text_result(bundle: bytes) -> bytes:
    book = decode_epub(bundle)
    return compute_text(text_resources(book)).model_dump_json().encode()


def _lexical_result(bundle: bytes, payload: bytes, configuration: str) -> bytes:
    book = decode_epub(bundle)
    inputs = text_resources(book)
    decoded = decode(payload, inputs)
    if decoded.configuration != configuration:
        raise ValueError("分词配置与资产不一致")
    return compute_lexical(inputs, decoded).model_dump_json().encode()


async def _text(factory: SessionFactory, identity: StatisticsInput) -> bytes:
    bundle = await _bundle(factory, identity)
    try:
        return await asyncio.to_thread(_text_result, bundle)
    except ValueError as exc:
        raise HTTPException(503, "正文统计失败，请重试") from exc


async def _lexical(factory: SessionFactory, identity: StatisticsInput) -> bytes:
    bundle = await _bundle(factory, identity)
    async with factory() as session:
        payload = await session.scalar(
            select(MaterialReadingsGeneration.payload).where(
                MaterialReadingsGeneration.id == identity.generation_id,
                MaterialReadingsGeneration.material_id == identity.material_id,
                MaterialReadingsGeneration.version_id == identity.version_id,
                MaterialReadingsGeneration.asset_sha256 == identity.asset_sha256,
                MaterialReadingsGeneration.configuration == identity.configuration,
            )
        )
        if payload is None:
            raise HTTPException(404, "分词代次不存在")
    assert identity.configuration is not None
    try:
        return await asyncio.to_thread(_lexical_result, bundle, payload, identity.configuration)
    except ValueError as exc:
        raise HTTPException(503, "词法统计失败，请重试") from exc


async def get_statistics(
    factory: SessionFactory,
    runtime: StatisticsRuntime,
    material_id: str,
    version_id: str,
    generation_id: str | None = None,
) -> MaterialStatisticsResponse:
    identity = await _identity(factory, material_id, version_id, generation_id)
    text = await runtime.get(identity.text_key(), lambda: _text(factory, identity))
    lexical = (
        await runtime.get(identity.lexical_key(), lambda: _lexical(factory, identity))
        if identity.generation_id is not None
        else None
    )
    # A new session observes Source deletion after cache hits or slow worker work.
    observed = await _identity(factory, material_id, version_id, identity.generation_id)
    if observed.product_sha256 != identity.product_sha256:
        raise HTTPException(409, "材料内容已改变")
    return MaterialStatisticsResponse(
        material_id=material_id,
        version_id=version_id,
        generation_id=identity.generation_id,
        text=TextStatistics.model_validate_json(text),
        lexical=LexicalStatistics.model_validate_json(lexical) if lexical is not None else None,
        analysis_configuration=identity.configuration,
    )
