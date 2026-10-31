import { type ReactNode, useEffect, useRef, useState } from "react";
import { InlineError } from "../Shared";
import { createAutosaveQueue } from "./autosave-queue";
import { useSettingsDraft, useSettingsFields } from "./SettingsForms";

export function useAutosavingFields<T extends object>(
	id: string,
	label: string,
	initial: T,
	write: (value: T, accept: (persisted: T) => void) => Promise<void>,
	invalidMessage: string,
	review?: {
		required: (error: Error) => boolean;
		render: (
			error: Error,
			fields: T,
			retry: (value: T) => void,
			discard: () => void,
		) => ReactNode;
	},
) {
	const form = useRef<HTMLFormElement>(null);
	const [pending, setPending] = useState(false);
	const fields = useSettingsFields(initial, pending);
	const [error, setError] = useState<Error | null>(null);
	const [invalid, setInvalid] = useState(false);
	const [showSaved, setShowSaved] = useState(false);
	useEffect(() => {
		if (!fields.saved || fields.dirty || pending) {
			setShowSaved(false);
			return;
		}
		setShowSaved(true);
		const timer = window.setTimeout(() => setShowSaved(false), 2500);
		return () => window.clearTimeout(timer);
	}, [fields.saved, fields.dirty, pending]);
	const commit = (value: T) =>
		write(value, (persisted) => fields.accept(value, persisted));
	const latestCommit = useRef(commit);
	latestCommit.current = commit;
	const [enqueue] = useState(() =>
		createAutosaveQueue<T>((value) => latestCommit.current(value)),
	);

	async function save(value = fields.fields, retry = false) {
		if (error && !retry) return false;
		if (!form.current?.checkValidity()) {
			setInvalid(true);
			return false;
		}
		setInvalid(false);
		setError(null);
		setPending(true);
		try {
			await enqueue(value);
			return true;
		} catch (cause) {
			setError(
				cause instanceof Error ? cause : new Error("保存失败，请重试。"),
			);
			return false;
		} finally {
			setPending(false);
		}
	}
	const reviewError = error && review?.required(error) ? error : null;
	function finishEditing() {
		if (fields.dirty || pending) void save();
		else if (form.current?.checkValidity()) setInvalid(false);
	}
	function select(value: T) {
		fields.change(value, true);
		void save(value);
	}
	function discard() {
		fields.reset();
		setError(null);
		setInvalid(false);
	}
	useSettingsDraft({
		autosave: true,
		id,
		label,
		dirty: fields.dirty,
		pending,
		save: () =>
			reviewError ? Promise.resolve(false) : save(fields.fields, true),
		discard,
	});
	return {
		...fields,
		pending,
		form,
		needsReview: !!reviewError,
		finishEditing,
		select,
		feedback: (
			<>
				{reviewError &&
					review?.render(
						reviewError,
						fields.fields,
						(value) => {
							fields.change(value);
							void save(value, true);
						},
						discard,
					)}
				{error && !reviewError && (
					<div className="settings-actions">
						<InlineError error={error} />
						<button
							type="button"
							className="settings-button secondary"
							onClick={() => void save(fields.fields, true)}
						>
							重试保存
						</button>
						<button
							type="button"
							className="settings-button secondary"
							onClick={discard}
						>
							放弃修改
						</button>
					</div>
				)}
				{invalid && (
					<p className="inline-error" role="alert">
						{invalidMessage}
					</p>
				)}
				<span className="settings-hint" role="status">
					{pending
						? "正在保存…"
						: fields.dirty
							? "有未保存的修改"
							: showSaved && fields.saved && !error && !invalid
								? "已自动保存"
								: ""}
				</span>
			</>
		),
	};
}
