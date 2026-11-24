"""HTTP entry points for settings which work without a running Anki instance."""

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.anki_settings_schemas import (
    AnkiConfigurationInput,
    AnkiConfigurationResponse,
    AnkiConnectionInput,
    AnkiConnectionResponse,
)
from app.db import get_session
from app.services import anki_settings as service

router = APIRouter(prefix="/api/settings/anki")
Session = Annotated[AsyncSession, Depends(get_session)]


def database_path(request: Request) -> Path:
    return request.app.state.database_path


@router.get("/connection", operation_id="getAnkiConnection")
async def get_connection(session: Session) -> AnkiConnectionResponse:
    return await service.get_connection_settings(session)


@router.put("/connection", operation_id="saveAnkiConnection")
async def save_connection(
    data: AnkiConnectionInput, session: Session, request: Request
) -> AnkiConnectionResponse:
    return await service.save_connection_settings(session, database_path(request), data)


@router.get("/configurations", operation_id="listAnkiConfigurations")
async def list_configurations(session: Session) -> list[AnkiConfigurationResponse]:
    return await service.list_configurations(session)


@router.post(
    "/configurations",
    operation_id="createAnkiConfiguration",
    status_code=status.HTTP_201_CREATED,
)
async def create_configuration(
    data: AnkiConfigurationInput, session: Session
) -> AnkiConfigurationResponse:
    return await service.create_configuration(session, data)


@router.get("/configurations/{configuration_id}", operation_id="getAnkiConfiguration")
async def get_configuration(configuration_id: str, session: Session) -> AnkiConfigurationResponse:
    return await service.get_configuration(session, configuration_id)


@router.put("/configurations/{configuration_id}", operation_id="updateAnkiConfiguration")
async def update_configuration(
    configuration_id: str, data: AnkiConfigurationInput, session: Session
) -> AnkiConfigurationResponse:
    return await service.update_configuration(session, configuration_id, data)


@router.delete(
    "/configurations/{configuration_id}",
    operation_id="deleteAnkiConfiguration",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_configuration(configuration_id: str, session: Session) -> None:
    await service.delete_configuration(session, configuration_id)
