"""Analysis persistence, revision edits and lossless Markdown normalization."""

import asyncio
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi import HTTPException
from hypothesis import given, settings
from hypothesis import strategies as st
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.analysis_schemas import SectionInput, SectionOperation
from app.db import Base, create_engine
from app.models import Segment, Source
from app.services.analyses import (
    apply_operation,
    create_analysis,
    get_analysis,
    join_revision_blocks,
    list_analyses,
    preview_operation,
    preview_section_replacement,
)
from app.services.normalizer import normalize
from app.services.sources import begin_write, delete_segment


@settings(max_examples=80)
@given(st.text(max_size=400))
def test_normalizer_properties(source: str) -> None:
    first = normalize(source)
    second = normalize(source)
    assert "".join(block.raw for block in first.blocks) == source  # R1/R3: lossless output.
    assert first == second  # R2: all boundaries and headings are deterministic.


@pytest.mark.parametrize(
    "source,expected",
    [
        ("", 0),
        ("序文\r\n\r\n## 文法\r\n内容\r\n", 1),
        ("章\n---\n内容\n", 1),
        ("```md\n## fake\n```\n\n## real\n正文", 1),
        ("## A\n### small\ntext\n## B", 2),
    ],
)
def test_normalization_recovers_exact_source(source: str, expected: int) -> None:
    first = normalize(source)
    second = normalize(source)
    assert "".join(block.raw for block in first.blocks) == source
    assert first == second
    assert sum(block.kind == "section" for block in first.blocks) == expected


@pytest.mark.parametrize("separator", ["\u2028", "\u2029", "\v", "\f"])
def test_commonmark_line_map_ignores_non_crlf_separators(separator: str) -> None:
    source = f"前{separator}文\n## 标题\n正文\n"
    result = normalize(source)
    assert result.blocks[0].raw == f"前{separator}文\n"
    assert result.blocks[1].raw == "## 标题\n正文\n"
    assert result.blocks[1].start_line == 2
    assert "".join(block.raw for block in result.blocks) == source


@pytest.mark.parametrize("line_ending", ["\n", "\r\n", "\r"])
def test_multiline_setext_edit_uses_full_heading_span(line_ending: str) -> None:
    source = line_ending.join(["标题一", "标题二", "---", "", "正文", ""])
    block = normalize(source).blocks[1]
    assert block.heading_lines == 3
    changed_title = preview_section_replacement(block, "新标题", None)
    assert changed_title == line_ending.join(["新标题", "---", "", "正文", ""])
    changed_body = preview_section_replacement(block, None, "新正文")
    assert changed_body == line_ending.join(["标题一", "标题二", "---", "新正文"])


def test_join_revision_blocks_separates_unterminated_body_from_next_heading() -> None:
    original = "## A\n旧正文\n## B\n后文\n"
    blocks = normalize(original).blocks
    replacement = preview_section_replacement(blocks[1], None, "新正文无终止换行")
    assert replacement == "## A\n新正文无终止换行"
    result = join_revision_blocks([blocks[0].raw, replacement, blocks[2].raw])
    assert result == "## A\n新正文无终止换行\n## B\n后文\n"
    assert [block.title for block in normalize(result).blocks] == [None, "A", "B"]
    assert original == "## A\n旧正文\n## B\n后文\n"


@pytest.mark.asyncio
async def test_create_edit_and_read_old_revision(tmp_path: Path) -> None:
    engine = create_engine(tmp_path / "a.db")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        now = datetime.now(UTC)
        async with factory() as session:
            session.add(Source(id="S" * 26, title="来源", created_at=now, updated_at=now))
            session.add(
                Segment(
                    id="G" * 26,
                    source_id="S" * 26,
                    text="原文",
                    created_at=now,
                    updated_at=now,
                    revision=1,
                )
            )
            await session.commit()
        async with factory() as session:
            await begin_write(session)
            created = await create_analysis(
                session,
                segment_id="G" * 26,
                source_md="总述\n\n## A\n解释\n## B\n第二\n",
                operation_key="create-1",
                origin="generation",
            )
            await session.commit()
            original_id = created.revision_id
            assert len(created.sections) == 3
            assert created.sections[0].kind == "preamble"
            assert (await list_analyses(session, "G" * 26))[0].id == created.id
            first_uid = created.sections[1].uid
            await session.commit()
            await begin_write(session)
            insert = SectionOperation(
                kind="insert_sections",
                after_sid=first_uid,
                sections=[SectionInput(title=" C ", body="\u0065\u0301")],
            )
            preview = preview_operation(created, insert)
            assert preview.before == ""
            assert preview.after == "## C\n\n\u00e9\n"
            assert preview.source_md == "总述\n\n## A\n解释\n## C\n\n\u00e9\n## B\n第二\n"
            edited = await apply_operation(
                session,
                segment_id="G" * 26,
                analysis_id=created.id,
                base_revision_id=original_id,
                operation_key="edit-1",
                operation=insert,
                run_id="R" * 26,
            )
            await session.commit()
            assert edited.parent_revision_id == original_id
            assert edited.run_id == "R" * 26
            assert edited.source_md == preview.source_md
            assert [row.title for row in edited.sections] == [None, "A", "C", "B"]
            assert edited.sections[1].uid == first_uid
            assert edited.sections[2].uid not in {row.uid for row in created.sections}
            old = await get_analysis(session, created.id, original_id)
            assert old.source_md == "总述\n\n## A\n解释\n## B\n第二\n"
            assert len(old.sections) == 3
            repeated_create = await create_analysis(
                session,
                segment_id="G" * 26,
                source_md=old.source_md,
                operation_key="create-1",
                origin="generation",
            )
            assert repeated_create.revision_id == original_id
            again = await apply_operation(
                session,
                segment_id="G" * 26,
                analysis_id=created.id,
                base_revision_id=original_id,
                operation_key="edit-1",
                operation=SectionOperation(
                    kind="insert_sections",
                    after_sid=first_uid,
                    sections=[SectionInput(title=" C ", body="\u0065\u0301")],
                ),
                run_id="R" * 26,
            )
            assert again.revision_id == edited.revision_id
            with pytest.raises(HTTPException) as changed_origin:
                await apply_operation(
                    session,
                    segment_id="G" * 26,
                    analysis_id=created.id,
                    base_revision_id=original_id,
                    operation_key="edit-1",
                    operation=SectionOperation(
                        kind="insert_sections",
                        after_sid=first_uid,
                        sections=[SectionInput(title=" C ", body="\u0065\u0301")],
                    ),
                    run_id="Q" * 26,
                )
            assert changed_origin.value.status_code == 409
            with pytest.raises(HTTPException) as outside:
                await apply_operation(
                    session,
                    segment_id="X" * 26,
                    analysis_id=created.id,
                    base_revision_id=original_id,
                    operation_key="edit-1",
                    operation=SectionOperation(
                        kind="insert_sections",
                        after_sid=first_uid,
                        sections=[SectionInput(title=" C ", body="\u0065\u0301")],
                    ),
                    run_id="R" * 26,
                )
            assert outside.value.status_code == 404
            with pytest.raises(HTTPException) as conflict:
                await apply_operation(
                    session,
                    segment_id="G" * 26,
                    analysis_id=created.id,
                    base_revision_id=original_id,
                    operation_key="edit-stale",
                    operation=SectionOperation(kind="delete_section", sid=first_uid),
                )
            assert conflict.value.status_code == 409
            await session.rollback()
            await begin_write(session)
            body_update = await apply_operation(
                session,
                segment_id="G" * 26,
                analysis_id=created.id,
                base_revision_id=edited.revision_id,
                operation_key="edit-body-no-newline",
                operation=SectionOperation(
                    kind="update_section", sid=first_uid, body="新正文无终止换行"
                ),
            )
            await session.commit()
            assert [row.title for row in body_update.sections] == [None, "A", "C", "B"]
            assert "新正文无终止换行\n## C" in body_update.source_md
            assert body_update.sections[1].uid == first_uid
            assert (
                await get_analysis(session, created.id, edited.revision_id)
            ).source_md == edited.source_md
            await session.commit()
            await delete_segment(session, "G" * 26, asyncio.Lock())
            with pytest.raises(HTTPException) as deleted:
                await get_analysis(session, created.id)
            assert deleted.value.status_code == 404
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_insert_after_section_without_terminal_newline(tmp_path: Path) -> None:
    engine = create_engine(tmp_path / "b.db")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        now = datetime.now(UTC)
        async with factory() as session:
            session.add(Source(id="S" * 26, title="来源", created_at=now, updated_at=now))
            session.add(
                Segment(
                    id="G" * 26,
                    source_id="S" * 26,
                    text="原文",
                    created_at=now,
                    updated_at=now,
                    revision=1,
                )
            )
            await session.commit()
            await begin_write(session)
            created = await create_analysis(
                session,
                segment_id="G" * 26,
                source_md="## A\n正文没有结尾换行",
                operation_key="new-no-newline",
                origin="generation",
            )
            await session.commit()
            assert created.sections[-1].raw.endswith("正文没有结尾换行")
            await begin_write(session)
            edited = await apply_operation(
                session,
                segment_id="G" * 26,
                analysis_id=created.id,
                base_revision_id=created.revision_id,
                operation_key="insert-after-eof",
                operation=SectionOperation(
                    kind="insert_sections",
                    after_sid=created.sections[-1].uid,
                    sections=[SectionInput(title="B", body="第二块")],
                ),
            )
            await session.commit()
            assert [section.title for section in edited.sections] == [None, "A", "B"]
            assert "正文没有结尾换行\n## B" in edited.source_md
            assert edited.sections[1].uid == created.sections[1].uid
            old = await get_analysis(session, created.id, created.revision_id)
            assert old.source_md == "## A\n正文没有结尾换行"
    finally:
        await engine.dispose()


@pytest.mark.parametrize(
    ("source_md", "updated_md"),
    [
        ("## 旧标题\n\n\n正文\n", "## 新标题\n\n\n正文\n"),
        ("旧标题\n---\n\n\n正文\n", "新标题\n---\n\n\n正文\n"),
    ],
)
@pytest.mark.asyncio
async def test_title_only_edit_preserves_body_and_document_title(
    tmp_path: Path, source_md: str, updated_md: str
) -> None:
    engine = create_engine(tmp_path / "title.db")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        now = datetime.now(UTC)
        async with factory() as session:
            session.add(Source(id="S" * 26, title="来源", created_at=now, updated_at=now))
            session.add(
                Segment(
                    id="G" * 26,
                    source_id="S" * 26,
                    text="原文",
                    created_at=now,
                    updated_at=now,
                    revision=1,
                )
            )
            await session.commit()
            await begin_write(session)
            created = await create_analysis(
                session,
                segment_id="G" * 26,
                source_md=source_md,
                operation_key="create-title",
                origin="generation",
                title="讲解文档",
            )
            await session.commit()
            await begin_write(session)
            edited = await apply_operation(
                session,
                segment_id="G" * 26,
                analysis_id=created.id,
                base_revision_id=created.revision_id,
                operation_key="edit-title",
                operation=SectionOperation(
                    kind="update_section", sid=created.sections[1].uid, title="新标题"
                ),
            )
            await session.commit()
            assert edited.title == "讲解文档"
            assert edited.sections[1].raw == updated_md
            assert edited.sections[1].uid == created.sections[1].uid
            old = await get_analysis(session, created.id, created.revision_id)
            assert old.sections[1].raw == source_md
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_create_analysis_does_not_commit_callers_transaction(tmp_path: Path) -> None:
    engine = create_engine(tmp_path / "rollback.db")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        now = datetime.now(UTC)
        async with factory() as session:
            session.add(Source(id="S" * 26, title="来源", created_at=now, updated_at=now))
            session.add(
                Segment(
                    id="G" * 26,
                    source_id="S" * 26,
                    text="原文",
                    created_at=now,
                    updated_at=now,
                    revision=1,
                )
            )
            await session.commit()
            await begin_write(session)
            await create_analysis(
                session,
                segment_id="G" * 26,
                source_md="## A\n正文",
                operation_key="rollback-create",
                origin="generation",
            )
            await session.rollback()
        async with factory() as session:
            assert await list_analyses(session, "G" * 26) == []
    finally:
        await engine.dispose()
