"""Singleton settings, kept outside model prompts and saved learning content."""

from sqlalchemy import Boolean, CheckConstraint, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class SegmentContextPreferences(Base):
    __tablename__ = "segment_context_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_segment_context_singleton"),
        CheckConstraint("revision >= 0", name="ck_segment_context_revision"),
        *(
            CheckConstraint(f"{field} BETWEEN 0 AND 100000", name=f"ck_segment_context_{field}")
            for field in (
                "before_sentences",
                "after_sentences",
                "before_characters",
                "after_characters",
            )
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    before_sentences: Mapped[int] = mapped_column(Integer, nullable=False)
    after_sentences: Mapped[int] = mapped_column(Integer, nullable=False)
    before_characters: Mapped[int] = mapped_column(Integer, nullable=False)
    after_characters: Mapped[int] = mapped_column(Integer, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
