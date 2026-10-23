import { type FormEvent, useState } from "react";
import type { Segment, SegmentFields, Source, SourceFields } from "./content";
import { SegmentMaterialOrigin } from "./materials/SegmentMaterialOrigin";
import { InlineError } from "./Shared";
import "./segments/material-fields.css";

export function SourceForm({
	initial,
	onSave,
	onCancel,
	pending,
	error,
	submitLabel,
	cancelLabel = "取消",
	className = "",
}: {
	initial?: Source;
	onSave: (fields: SourceFields) => void;
	onCancel: () => void;
	pending: boolean;
	error: Error | null;
	submitLabel: string;
	cancelLabel?: string;
	className?: string;
}) {
	const [fields, setFields] = useState<SourceFields>({
		title: initial?.title ?? "",
		description: initial?.description ?? "",
		note: initial?.note ?? "",
	});
	function submit(event: FormEvent) {
		event.preventDefault();
		if (pending) return;
		onSave(fields);
	}
	return (
		<form className={`editor-card ${className}`} onSubmit={submit}>
			<div className="form-grid">
				<label className="field full">
					<span>
						来源名称 <strong aria-hidden="true">*</strong>
					</span>
					<input
						required
						disabled={pending}
						maxLength={200}
						value={fields.title}
						onChange={(event) =>
							setFields({ ...fields, title: event.target.value })
						}
						placeholder="例如：小说名、动画名或课程"
					/>
				</label>
				<label className="field full">
					<span>来源描述</span>
					<textarea
						rows={2}
						disabled={pending}
						value={fields.description}
						onChange={(event) =>
							setFields({ ...fields, description: event.target.value })
						}
						placeholder="可记录作品、版本或出处范围"
					/>
				</label>
				<label className="field full">
					<span>管理备注</span>
					<textarea
						rows={2}
						disabled={pending}
						value={fields.note}
						onChange={(event) =>
							setFields({ ...fields, note: event.target.value })
						}
						placeholder="只供自己管理资料"
					/>
				</label>
			</div>
			<InlineError error={error} />
			<div className="actions">
				<button className="button primary" disabled={pending} type="submit">
					{pending ? "保存中…" : submitLabel}
				</button>
				<button
					className="button secondary"
					disabled={pending}
					type="button"
					onClick={onCancel}
				>
					{cancelLabel}
				</button>
			</div>
		</form>
	);
}

export function SegmentForm({
	initial,
	onSave,
	onCancel,
	pending,
	error,
	submitLabel,
	submitDisabled = false,
}: {
	initial?: Segment;
	onSave: (fields: SegmentFields) => void;
	onCancel: () => void;
	pending: boolean;
	error: Error | null;
	submitLabel: string;
	submitDisabled?: boolean;
}) {
	const [fields, setFields] = useState<SegmentFields>({
		text: initial?.text ?? "",
		translation: initial?.translation ?? "",
		context_before: initial?.context_before ?? "",
		context_after: initial?.context_after ?? "",
		transcription: initial?.transcription ?? "",
		note: initial?.note ?? "",
		source_ref: initial?.source_ref ?? "",
	});
	const locked = Boolean(initial?.text_locked_at);
	function update(name: keyof SegmentFields, value: string) {
		setFields((current) => ({ ...current, [name]: value }));
	}
	function submit(event: FormEvent) {
		event.preventDefault();
		if (pending || submitDisabled) return;
		onSave(fields);
	}
	return (
		<form className="editor-card segment-data-form" onSubmit={submit}>
			<fieldset className="segment-data-group">
				<legend>原文与语境</legend>
				<details
					className="segment-context-editor"
					open={Boolean(initial?.context_before)}
				>
					<summary>前文（可选）</summary>
					<label className="field">
						<span className="sr-only">前文</span>
						<textarea
							rows={2}
							maxLength={100000}
							lang="ja"
							disabled={pending}
							value={fields.context_before}
							onChange={(event) => update("context_before", event.target.value)}
						/>
					</label>
				</details>
				{locked ? (
					<div className="segment-fixed-original">
						<div className="segment-fixed-heading">
							<span>目标原文</span>
							<small>已固定</small>
						</div>
						<section
							className="segment-fixed-text"
							aria-label="目标原文（已固定）"
							// biome-ignore lint/a11y/noNoninteractiveTabindex: The complete locked text remains keyboard-scrollable.
							tabIndex={0}
							lang="ja"
						>
							{fields.text}
						</section>
					</div>
				) : (
					<label className="field">
						<span>
							目标原文 <strong aria-hidden="true">*</strong>
						</span>
						<textarea
							required
							disabled={pending}
							maxLength={100000}
							rows={4}
							lang="ja"
							value={fields.text}
							onChange={(event) => update("text", event.target.value)}
							placeholder="粘贴或输入要学习的日文，换行会保留"
						/>
					</label>
				)}
				<details
					className="segment-context-editor"
					open={Boolean(initial?.context_after)}
				>
					<summary>后文（可选）</summary>
					<label className="field">
						<span className="sr-only">后文</span>
						<textarea
							rows={2}
							maxLength={100000}
							lang="ja"
							disabled={pending}
							value={fields.context_after}
							onChange={(event) => update("context_after", event.target.value)}
						/>
					</label>
				</details>
			</fieldset>
			<fieldset className="segment-data-group">
				<legend>译文与听写</legend>
				<label className="field">
					<span>译文</span>
					<textarea
						rows={3}
						maxLength={100000}
						disabled={pending}
						value={fields.translation}
						onChange={(event) => update("translation", event.target.value)}
						placeholder="可选"
					/>
				</label>
				<label className="field">
					<span>听写</span>
					<textarea
						rows={2}
						maxLength={100000}
						disabled={pending}
						lang="ja"
						value={fields.transcription}
						onChange={(event) => update("transcription", event.target.value)}
						placeholder="可选"
					/>
				</label>
			</fieldset>
			<fieldset className="segment-data-group">
				<legend>出处与备注</legend>
				{initial && (
					<SegmentMaterialOrigin segment={initial} showReturnLink={false} />
				)}
				<label className="field">
					<span>{initial?.material_provenance ? "出处补充" : "出处说明"}</span>
					<input
						maxLength={100000}
						disabled={pending}
						value={fields.source_ref}
						onChange={(event) => update("source_ref", event.target.value)}
						placeholder="例如：第 3 章、12:40"
					/>
				</label>
				<label className="field">
					<span>个人管理备注</span>
					<textarea
						rows={2}
						maxLength={100000}
						disabled={pending}
						value={fields.note}
						onChange={(event) => update("note", event.target.value)}
					/>
				</label>
			</fieldset>
			<InlineError error={error} />
			<div className="actions">
				<button
					className="button primary"
					disabled={pending || submitDisabled}
					type="submit"
				>
					{pending ? "保存中…" : submitLabel}
				</button>
				<button
					className="button secondary"
					disabled={pending}
					type="button"
					onClick={onCancel}
				>
					取消
				</button>
			</div>
		</form>
	);
}
