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
		<details
			className="provider-action-menu"
			ref={ref}
			onToggle={(event) => {
				const menu = event.currentTarget;
				if (!menu.open) return;
				const dialog = menu.closest("dialog")?.getBoundingClientRect();
				const panel = menu.querySelector<HTMLElement>(
					".provider-action-menu-panel",
				);
				if (!dialog || !panel) return;
				const trigger = menu.getBoundingClientRect();
				const below = dialog.bottom - trigger.bottom;
				menu.toggleAttribute(
					"data-above",
					below < panel.offsetHeight + 6 && trigger.top - dialog.top > below,
				);
			}}
		>
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
	onAdd,
	onEdit,
	onDelete,
}: {
	provider: Provider;
	onAdd: () => void;
	onEdit: (model: Model) => void;
	onDelete: (model: Model) => void;
}) {
	return (
		<div className="provider-models-view">
			<div className="provider-section-heading">
				<h3>已登记模型</h3>
				<button
					type="button"
					className="settings-button primary"
					onClick={onAdd}
				>
					<span aria-hidden="true">＋</span> 登记模型
				</button>
			</div>
			{provider.models.length ? (
				<div className="provider-model-list">
					{provider.models.map((model) => (
						<ModelRow
							key={model.id}
							model={model}
							providerEnabled={provider.enabled}
							onEdit={() => onEdit(model)}
							onDelete={() => onDelete(model)}
						/>
					))}
				</div>
			) : (
				<p className="provider-empty settings-hint">
					还没有已登记的模型。可以从服务列表选择，或手动填写模型 ID。
				</p>
			)}
		</div>
	);
}

function ModelRow({
	model,
	providerEnabled,
	onEdit,
	onDelete,
}: {
	model: Model;
	providerEnabled: boolean;
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
					<span className="provider-model-state">
						{model.enabled ? "已启用" : "已停用"}
					</span>
				</div>
				<div className="settings-actions provider-model-actions">
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
						<small className="provider-verification-note">
							暂未提供结构化输出验证。
						</small>
					</ActionMenu>
					<ActionMenu label={`${model.model_id} 更多操作`}>
						<button
							type="button"
							disabled={verify.isPending || toggle.isPending}
							onClick={(event) => {
								closeMenu(event);
								onEdit();
							}}
						>
							编辑参数
						</button>
						<button
							type="button"
							disabled={toggle.isPending || verify.isPending}
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
							disabled={busy || verify.isPending || toggle.isPending}
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
