"""Thin HTTP routes for settings and model verification."""

import asyncio
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.services import settings as service
from app.settings_schemas import (
    DefaultsInput,
    DefaultsResponse,
    ModelInput,
    ModelPatch,
    ModelResponse,
    ProfileInput,
    ProfileResponse,
    ProviderInput,
    ProviderPatch,
    ProviderResponse,
    RunResponse,
    RunStatus,
    SettingsPatch,
    SettingsResponse,
    StyleInput,
    StyleResponse,
    VerificationInput,
)

router = APIRouter(prefix="/api")
Session = Annotated[AsyncSession, Depends(get_session)]


def database_path(request: Request) -> Path:
    return request.app.state.database_path


@router.get("/settings", response_model=SettingsResponse, operation_id="getSettings")
async def get_settings(session: Session) -> SettingsResponse:
    return await service.get_settings(session)


@router.patch("/settings", response_model=SettingsResponse, operation_id="patchSettings")
async def patch_settings(data: SettingsPatch, session: Session) -> SettingsResponse:
    return await service.patch_settings(session, data)


@router.put("/settings/profile", response_model=ProfileResponse, operation_id="putProfile")
async def put_profile(data: ProfileInput, session: Session) -> ProfileResponse:
    return await service.put_profile(session, data)


@router.post(
    "/settings/styles",
    response_model=StyleResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="createStyle",
)
async def create_style(data: StyleInput, session: Session) -> StyleResponse:
    return await service.create_style(session, data)


@router.put("/settings/styles/{style_id}", response_model=StyleResponse, operation_id="putStyle")
async def put_style(style_id: str, data: StyleInput, session: Session) -> StyleResponse:
    return await service.put_style(session, style_id, data)


@router.delete(
    "/settings/styles/{style_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteStyle",
)
async def delete_style(style_id: str, session: Session) -> None:
    await service.delete_style(session, style_id)


@router.put("/settings/defaults", response_model=DefaultsResponse, operation_id="putDefaults")
async def put_defaults(data: DefaultsInput, session: Session) -> DefaultsResponse:
    return await service.put_defaults(session, data)


@router.get("/providers", response_model=list[ProviderResponse], operation_id="listProviders")
async def list_providers(session: Session) -> list[ProviderResponse]:
    return await service.list_providers(session)


@router.post(
    "/providers",
    response_model=ProviderResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="createProvider",
)
async def create_provider(
    data: ProviderInput, session: Session, request: Request
) -> ProviderResponse:
    return await service.create_provider(session, database_path(request), data)


@router.get("/providers/{provider_id}", response_model=ProviderResponse, operation_id="getProvider")
async def get_provider(provider_id: str, session: Session) -> ProviderResponse:
    return await service.provider_response(
        session, await service.get_provider(session, provider_id)
    )


@router.patch(
    "/providers/{provider_id}", response_model=ProviderResponse, operation_id="patchProvider"
)
async def patch_provider(
    provider_id: str, data: ProviderPatch, session: Session, request: Request
) -> ProviderResponse:
    return await service.patch_provider(session, database_path(request), provider_id, data)


@router.delete(
    "/providers/{provider_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteProvider",
)
async def delete_provider(provider_id: str, session: Session) -> None:
    await service.delete_provider(session, provider_id)


@router.post(
    "/providers/{provider_id}/refresh-models",
    response_model=ProviderResponse,
    operation_id="refreshModels",
)
async def refresh_models(provider_id: str, session: Session, request: Request) -> ProviderResponse:
    return await service.refresh_models(session, database_path(request), provider_id)


@router.post(
    "/providers/{provider_id}/models",
    response_model=ModelResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="createModel",
)
async def create_model(provider_id: str, data: ModelInput, session: Session) -> ModelResponse:
    return await service.create_model(session, provider_id, data)


@router.patch(
    "/provider-models/{model_id}", response_model=ModelResponse, operation_id="patchModel"
)
async def patch_model(model_id: str, data: ModelPatch, session: Session) -> ModelResponse:
    return await service.patch_model(session, model_id, data)


@router.delete(
    "/provider-models/{model_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteModel",
)
async def delete_model(model_id: str, session: Session) -> None:
    await service.delete_model(session, model_id)


@router.post(
    "/provider-models/{model_id}/verifications",
    response_model=RunResponse,
    status_code=status.HTTP_202_ACCEPTED,
    operation_id="verifyModel",
)
async def verify_model(
    model_id: str, data: VerificationInput, session: Session, request: Request
) -> RunResponse:
    result = await service.accept_verification(session, model_id, data)
    if request.app.state.verification_worker_enabled:
        task = asyncio.create_task(service.execute_verification(request.app, result.id))
        request.app.state.verification_tasks.add(task)
        task.add_done_callback(request.app.state.verification_tasks.discard)
    return result


@router.get("/runs", response_model=list[RunResponse], operation_id="listRuns")
async def list_runs(
    session: Session,
    limit: Annotated[int, Query(ge=1, le=50)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    provider_id: Annotated[str | None, Query(description="Provider 登记身份")] = None,
    model_id: Annotated[str | None, Query(description="ProviderModel 登记身份，非模型名称")] = None,
    status: RunStatus | None = None,
) -> list[RunResponse]:
    return await service.list_runs(
        session,
        limit=limit,
        offset=offset,
        provider_id=provider_id,
        model_id=model_id,
        status=status,
    )


@router.get("/runs/{run_id}", response_model=RunResponse, operation_id="getRun")
async def get_run(run_id: str, session: Session) -> RunResponse:
    return await service.get_run(session, run_id)
