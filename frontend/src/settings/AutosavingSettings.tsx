import { useRef, useState } from "react";
import { InlineError } from "../Shared";
import { createAutosaveQueue } from "./autosave-queue";
import { useSettingsDraft, useSettingsFields } from "./SettingsForms";

export function useAutosavingFields<T extends object>(
	id: string,
	label: string,
	initial: T,
	write: (value: T, accept: (persisted: T) => void) => Promise<void>,
	invalidMessage: string,
) {
	const form = useRef<HTMLFormElement>(null);
	const fields = useSettingsFields(initial);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const [invalid, setInvalid] = useState(false);
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
	function finishEditing() {
		if (fields.dirty || pending) void save();
		else if (form.current?.checkValidity()) setInvalid(false);
	}
	function select(value: T) {
		fields.change(value);
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
		save: () => save(fields.fields, true),
		discard,
	});
	return {
		...fields,
		form,
		finishEditing,
		select,
		feedback: (
			<>
				{error && (
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
							: fields.saved
								? "已自动保存"
								: ""}
				</span>
			</>
		),
	};
}
