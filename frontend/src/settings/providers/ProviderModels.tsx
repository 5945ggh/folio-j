import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	type MouseEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { api } from "../../api/client";
import { requireData } from "../../content";
import { InlineError } from "../../Shared";
import { type Model, type Provider, settingsKeys } from "../api";
import { RunDetail } from "../RunHistory";
import {
	type Capability,
	capabilityPresentation,
	isActiveVerification,
	type VerificationState,
} from "../verification";
import type { ProviderDiscovery } from "./ProviderDiscovery";

export function TimeStamp({ value }: { value: string }) {
	const date = new Date(value);
	return (
		<time dateTime={value} title={date.toLocaleString("zh-CN")}>
			{new Intl.DateTimeFormat("zh-CN", {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(date)}
		</time>
	);
}

function ActionMenu({
	label,
	glyph = "···",
	children,
}: {
	label: string;
	glyph?: string;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDetailsElement>(null);
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (!ref.current?.contains(event.target as Node))
				ref.current?.removeAttribute("open");
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && ref.current?.open) {
				event.preventDefault();
				event.stopPropagation();
				ref.current.open = false;
				ref.current.querySelector("summary")?.focus();
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, []);
	return (
		<details className="provider-action-menu" ref={ref}>
			<summary
				className="settings-button secondary"
				tabIndex={0}
				aria-label={label}
				title={label}
			>
				{glyph}
			</summary>
			<div className="provider-action-menu-panel">{children}</div>
		</details>
	);
}

function closeMenu(event: MouseEvent<HTMLButtonElement>) {
	event.currentTarget.closest("details")?.removeAttribute("open");
}

export function ProviderModels({
	provider,
	discovery,
	onAdd,
	onEdit,
	onDelete,
}: {
	provider: Provider;
	discovery: ProviderDiscovery;
	onAdd: () => void;
	onEdit: (model: Model) => void;
	onDelete: (model: Model) => void;
}) {
	const {
		available,
		selected,
		registering,
		registrationError,
		refresh,
		registerSelected,
	} = discovery;
	return (
		<div className="provider-models-view">
			<div className="provider-section-heading">
				<div>
					<h3>已登记模型</h3>
					<p className="settings-hint">
						{provider.models.length} 个模型，按普通文本与流式文本分别验证。
					</p>
				</div>
				<button
					type="button"
					className="settings-button secondary"
					disabled={registering}
					onClick={onAdd}
				>
					手动登记模型
				</button>
			</div>
			{provider.models.length === 0 ? (
				<div className="provider-empty">
					<p>尚未登记模型。</p>
					<p className="settings-hint">
						从下方发现列表选择，或手动填写上游模型 ID。
					</p>
				</div>
			) : (
				<div className="provider-model-list">
					{provider.models.map((model) => (
						<ModelRow
							key={model.id}
							model={model}
							providerEnabled={provider.enabled}
							managementPending={registering}
							onEdit={() => onEdit(model)}
							onDelete={() => onDelete(model)}
						/>
					))}
				</div>
			)}
			<p className="provider-capability-note">
				当前仅验证普通文本与流式文本。结构化输出验证尚未开放。
			</p>
			<section
				className="provider-discovery"
				aria-labelledby={`discovery-${provider.id}`}
			>
				<div className="provider-section-heading">
					<div>
						<h3 id={`discovery-${provider.id}`}>模型发现</h3>
						<p className="settings-hint">
							{provider.discovery_status === "succeeded"
								? "最近拉取成功"
								: provider.discovery_status === "failed"
									? "拉取失败，保留缓存"
									: "尚未拉取"}{" "}
							· 已发现 {new Set(provider.discovered_models).size} · 待登记{" "}
							{available.length}
						</p>
					</div>
					<button
						className="settings-button secondary"
						type="button"
						disabled={refresh.isPending || registering}
						onClick={() => refresh.mutate()}
					>
						{refresh.isPending ? "拉取中…" : "拉取模型列表"}
					</button>
				</div>
				{provider.last_discovered_at && (
					<p className="settings-hint">
						最近拉取 <TimeStamp value={provider.last_discovered_at} />
					</p>
				)}
				{provider.discovery_error && (
					<p className="provider-warning" role="status">
						{provider.discovery_error}
					</p>
				)}
				<InlineError error={refresh.error} />
				{provider.discovered_models.length > 0 && (
					<details className="provider-discovered-models">
						<summary tabIndex={0}>查看发现列表并登记模型</summary>
						<p className="settings-hint">
							列表接口可访问不代表文本能力已验证。已登记的模型不能重复选择。
						</p>
						<div className="provider-discovery-list">
							{[...new Set(provider.discovered_models)].map((id) => {
								const registered = provider.models.some(
									(model) => model.model_id === id,
								);
								return (
									<label className="provider-discovery-item" key={id}>
										<input
											type="checkbox"
											disabled={registered || registering}
											checked={registered || selected.includes(id)}
											onChange={(event) =>
												discovery.select(id, event.target.checked)
											}
										/>
										<span>{id}</span>
										<small>{registered ? "已登记" : "待添加"}</small>
									</label>
								);
							})}
						</div>
						<div className="settings-actions">
							<button
								className="settings-button primary"
								type="button"
								disabled={selected.length === 0 || registering}
								onClick={() => void registerSelected()}
							>
								{registering ? "登记中…" : `登记所选（${selected.length}）`}
							</button>
							{selected.length > 0 && (
								<button
									type="button"
									className="settings-button secondary"
									disabled={registering}
									onClick={discovery.clear}
								>
									清除选择
								</button>
							)}
						</div>
					</details>
				)}
				{registrationError && (
					<p className="provider-warning" role="status">
						{registrationError}
					</p>
				)}
			</section>
		</div>
	);
}

function ModelRow({
	model,
	providerEnabled,
	managementPending,
	onEdit,
	onDelete,
}: {
	model: Model;
	providerEnabled: boolean;
	managementPending: boolean;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const client = useQueryClient();
	const [showRecord, setShowRecord] = useState<Capability | null>(null);
	const [optimistic, setOptimistic] = useState<Capability[]>([]);
	const textSummary = model.text_verification;
	const streamSummary = model.stream_verification;
	const selectedSummary =
		showRecord === "text"
			? textSummary
			: showRecord === "stream"
				? streamSummary
				: null;
	const textState: VerificationState = optimistic.includes("text")
		? "queued"
		: (textSummary?.status ?? model.text_status);
	const streamState: VerificationState = optimistic.includes("stream")
		? "queued"
		: (streamSummary?.status ?? model.stream_status);
	const latest = [textSummary, streamSummary]
		.filter((item) => item !== null)
		.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
	const busy =
		isActiveVerification(textState) || isActiveVerification(streamState);
	const toggle = useMutation({
		mutationFn: async () => {
			const { data, error, response } = await api.PATCH(
				"/api/provider-models/{model_id}",
				{
					params: { path: { model_id: model.id } },
					body: { enabled: !model.enabled },
				},
			);
			return requireData(data, error, response.status);
		},
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: settingsKeys.providers });
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
		},
	});
	const verify = useMutation({
		mutationFn: async (targets: Capability[]) => {
			let accepted = 0;
			for (const target of targets) {
				try {
					const { data, error, response } = await api.POST(
						"/api/provider-models/{model_id}/verifications",
						{
							params: { path: { model_id: model.id } },
							body: { stream: target === "stream" },
						},
					);
					requireData(data, error, response.status);
					accepted += 1;
				} catch (error) {
					const reason = error instanceof Error ? error.message : "请求未完成";
					throw new Error(
						`已接受 ${accepted} 项验证；${target === "text" ? "普通文本" : "流式文本"}请求未确认接受，其余尚未发送。${reason}。可刷新状态核实后重试。`,
					);
				}
			}
		},
		onSettled: async () => {
			await Promise.all([
				client.invalidateQueries({ queryKey: settingsKeys.providers }),
				client.invalidateQueries({ queryKey: settingsKeys.runs }),
			]);
			setOptimistic([]);
		},
	});
	const disabled =
		managementPending ||
		!providerEnabled ||
		!model.enabled ||
		busy ||
		verify.isPending ||
		toggle.isPending;
	function startVerification(targets: Capability[]) {
		if (disabled || targets.length === 0) return;
		verify.reset();
		setOptimistic(targets);
		verify.mutate(targets);
	}
	function status(capability: Capability, state: VerificationState) {
		const presentation = capabilityPresentation(state);
		const summary = capability === "text" ? textSummary : streamSummary;
		const content = (
			<>
				<span>{capability === "text" ? "普通文本" : "流式文本"}</span>
				<span className={`provider-capability ${state}`}>
					<span aria-hidden="true">{presentation.icon}</span>{" "}
					{presentation.label}
				</span>
			</>
		);
		return summary ? (
			<button
				type="button"
				className="provider-capability-button"
				aria-expanded={showRecord === capability}
				aria-controls={`model-record-${model.id}`}
				onClick={() =>
					setShowRecord(showRecord === capability ? null : capability)
				}
			>
				{content}
				<span className="provider-record-caret" aria-hidden="true">
					⌄
				</span>
			</button>
		) : (
			<div className="provider-capability-button">{content}</div>
		);
	}
	return (
		<article className="provider-model-row">
			<div className="provider-model-heading">
				<div className="provider-model-name">
					<strong>{model.model_id}</strong>
					{!model.enabled && <span className="settings-badge">已停用</span>}
					<small>
						{model.effective_protocol === "responses"
							? "Responses"
							: "Chat Completions"}
						{model.protocol_override ? " · 模型覆盖" : " · 继承服务"}
					</small>
				</div>
				<div className="settings-actions provider-model-actions">
					<button
						type="button"
						className="settings-button secondary"
						disabled={managementPending || verify.isPending || toggle.isPending}
						onClick={onEdit}
					>
						设置
					</button>
					<ActionMenu
						label={`${model.model_id} 文本验证`}
						glyph={busy ? "验证中…" : "验证 ▾"}
					>
						<button
							type="button"
							disabled={disabled}
							onClick={(event) => {
								closeMenu(event);
								startVerification(["text"]);
							}}
						>
							验证普通文本（1 次调用）
						</button>
						<button
							type="button"
							disabled={disabled}
							onClick={(event) => {
								closeMenu(event);
								startVerification(["stream"]);
							}}
						>
							验证流式文本（1 次调用）
						</button>
						<button
							type="button"
							disabled={disabled}
							onClick={(event) => {
								closeMenu(event);
								startVerification(["text", "stream"]);
							}}
						>
							验证两项文本（2 次调用）
						</button>
					</ActionMenu>
					<ActionMenu label={`${model.model_id} 更多操作`}>
						<button
							type="button"
							disabled={
								managementPending || toggle.isPending || verify.isPending
							}
							onClick={(event) => {
								closeMenu(event);
								toggle.mutate();
							}}
						>
							{model.enabled ? "停用模型" : "启用模型"}
						</button>
						<button
							type="button"
							className="provider-danger-text"
							disabled={
								managementPending ||
								busy ||
								verify.isPending ||
								toggle.isPending
							}
							onClick={(event) => {
								closeMenu(event);
								onDelete();
							}}
						>
							删除模型
						</button>
					</ActionMenu>
				</div>
			</div>
			<div className="provider-model-verification">
				<div className="provider-capabilities">
					{status("text", textState)}
					{status("stream", streamState)}
				</div>
				{latest && (
					<p className="provider-model-latest">
						最近验证 <TimeStamp value={latest.created_at} />
					</p>
				)}
			</div>
			<InlineError error={verify.error ?? toggle.error} />
			{selectedSummary && (
				<div
					id={`model-record-${model.id}`}
					className="provider-model-diagnostic"
				>
					<RunDetail id={selectedSummary.id} />
					<button
						type="button"
						className="provider-back"
						onClick={() => setShowRecord(null)}
					>
						收起诊断
					</button>
				</div>
			)}
		</article>
	);
}
