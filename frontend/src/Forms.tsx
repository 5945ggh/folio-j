import { type FormEvent, useState } from "react";
import type { Segment, SegmentFields, Source, SourceFields } from "./content";
import { InlineError } from "./Shared";

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
}: {
	initial?: Segment;
	onSave: (fields: SegmentFields) => void;
	onCancel: () => void;
	pending: boolean;
	error: Error | null;
	submitLabel: string;
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
		onSave(fields);
	}
	return (
		<form className="editor-card" onSubmit={submit}>
			<div className="form-grid">
				<label className="field full">
					<span>
						目标原文 <strong aria-hidden="true">*</strong>
					</span>
					<textarea
						required={!locked}
						disabled={locked}
						maxLength={100000}
						rows={7}
						lang="ja"
						value={fields.text}
						onChange={(event) => update("text", event.target.value)}
						placeholder="粘贴或输入要学习的日文，换行会保留"
					/>
				</label>
				{locked && (
					<p className="field-help full">
						目标原文已固定，不能修改。可继续维护附带资料。
					</p>
				)}
				<label className="field full">
					<span>译文</span>
					<textarea
						rows={3}
						maxLength={100000}
						value={fields.translation}
						onChange={(event) => update("translation", event.target.value)}
						placeholder="可选"
					/>
				</label>
			</div>
			<details
				className="more-fields"
				open={Boolean(
					initial &&
						(initial.context_before ||
							initial.context_after ||
							initial.transcription ||
							initial.note ||
							initial.source_ref),
				)}
			>
				<summary>补充资料（可选）</summary>
				<div className="form-grid">
					<label className="field full">
						<span>前文</span>
						<textarea
							rows={3}
							maxLength={100000}
							value={fields.context_before}
							onChange={(event) => update("context_before", event.target.value)}
						/>
					</label>
					<label className="field full">
						<span>后文</span>
						<textarea
							rows={3}
							maxLength={100000}
							value={fields.context_after}
							onChange={(event) => update("context_after", event.target.value)}
						/>
					</label>
					<label className="field full">
						<span>听写</span>
						<textarea
							rows={3}
							maxLength={100000}
							value={fields.transcription}
							onChange={(event) => update("transcription", event.target.value)}
						/>
					</label>
					<label className="field full">
						<span>
							{initial?.material_provenance ? "出处补充" : "出处说明"}
						</span>
						<input
							maxLength={100000}
							value={fields.source_ref}
							onChange={(event) => update("source_ref", event.target.value)}
							placeholder="例如：第 3 章、12:40"
						/>
					</label>
					<label className="field full">
						<span>个人管理备注</span>
						<textarea
							rows={3}
							maxLength={100000}
							value={fields.note}
							onChange={(event) => update("note", event.target.value)}
						/>
					</label>
				</div>
			</details>
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
					取消
				</button>
			</div>
		</form>
	);
}
