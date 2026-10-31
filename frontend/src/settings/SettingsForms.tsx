import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useBeforeUnload, useBlocker } from "react-router";
import { ConfirmDialog } from "../Shared";
import {
	completeDraft,
	createDraft,
	draftDirty,
	editDraft,
	receiveDraft,
	resetDraft,
	shouldBlockSettingsNavigation,
} from "./draft";

type RegisteredDraft = {
	autosave?: boolean;
	id: string;
	label: string;
	dirty: boolean;
	pending: boolean;
	save: () => Promise<boolean>;
	discard: () => void;
};
type DraftRef = { current: RegisteredDraft };
const DraftContext = createContext<((draft: DraftRef) => () => void) | null>(
	null,
);

export function useSettingsDraft(draft: RegisteredDraft) {
	const register = useContext(DraftContext);
	const ref = useRef(draft);
	ref.current = draft;
	// biome-ignore lint/correctness/useExhaustiveDependencies: Status changes refresh the navigation dialog while callbacks remain in the stable ref.
	useEffect(() => register?.(ref), [register, draft.dirty, draft.pending]);
}

export function useSettingsFields<T>(initial: T) {
	const [state, setState] = useState(() => createDraft(initial));
	useEffect(() => {
		setState((current) => receiveDraft(current, initial));
	}, [initial]);
	return {
		fields: state.value,
		dirty: draftDirty(state),
		saved: state.saved,
		change: (value: T) => setState((current) => editDraft(current, value)),
		reset: () => setState((current) => resetDraft(current)),
		accept: (submitted: T, persisted: T) =>
			setState((current) => completeDraft(current, submitted, persisted)),
	};
}

export function SettingsDraftProvider({ children }: { children: ReactNode }) {
	const drafts = useRef(new Set<DraftRef>());
	const [, refresh] = useState(0);
	const register = useCallback((draft: DraftRef) => {
		drafts.current.add(draft);
		refresh((value) => value + 1);
		return () => {
			drafts.current.delete(draft);
			refresh((value) => value + 1);
		};
	}, []);
	const entries = () => Array.from(drafts.current, (draft) => draft.current);
	const blocker = useBlocker(({ currentLocation, nextLocation }) =>
		shouldBlockSettingsNavigation(currentLocation, nextLocation, entries()),
	);
	useBeforeUnload(
		useCallback((event) => {
			if (
				Array.from(drafts.current).some(
					({ current }) => current.dirty || current.pending,
				)
			) {
				event.preventDefault();
				event.returnValue = "";
			}
		}, []),
	);
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState(false);
	const registered = entries();
	const pending = saving || registered.some((draft) => draft.pending);
	const onlyAutosaves =
		registered.some((draft) => draft.autosave) &&
		registered.every(
			(draft) => draft.autosave || !(draft.dirty || draft.pending),
		);
	const continueAfterAutosave =
		onlyAutosaves && !registered.some((draft) => draft.dirty || draft.pending);
	const waitForAutosave = onlyAutosaves && pending && !saving;
	const showGuard =
		blocker.state === "blocked" && !waitForAutosave && !continueAfterAutosave;
	useEffect(() => {
		if (blocker.state === "blocked" && continueAfterAutosave && !saving)
			blocker.proceed();
	}, [blocker, continueAfterAutosave, saving]);
	async function saveAndLeave() {
		setSaving(true);
		setFailed(false);
		try {
			for (const draft of entries()) {
				if (draft.dirty && !(await draft.save())) {
					setFailed(true);
					return;
				}
			}
			if (blocker.state === "blocked") blocker.proceed();
		} catch {
			setFailed(true);
		} finally {
			setSaving(false);
		}
	}
	return (
		<DraftContext value={register}>
			{children}
			{showGuard && (
				<ConfirmDialog
					className="settings-dialog settings-leave-dialog"
					titleId="settings-leave-title"
					onClose={() => {
						if (!pending) {
							setFailed(false);
							blocker.reset();
						}
					}}
				>
					<h2 id="settings-leave-title">有尚未保存的修改</h2>
					<p>
						{pending
							? "正在保存，请稍候。"
							: "可以保存后离开，或放弃这次修改。"}
					</p>
					{failed && (
						<p className="inline-error" role="alert">
							保存未完成，请返回检查表单后重试。
						</p>
					)}
					<div className="settings-actions">
						<button
							type="button"
							className="settings-button primary"
							disabled={pending}
							onClick={() => void saveAndLeave()}
						>
							保存后离开
						</button>
						<button
							type="button"
							className="settings-button danger"
							disabled={pending}
							onClick={() => {
								for (const draft of entries()) draft.discard();
								blocker.proceed();
							}}
						>
							放弃修改
						</button>
						<button
							type="button"
							className="settings-button secondary"
							disabled={pending}
							data-dialog-cancel
							onClick={() => {
								setFailed(false);
								blocker.reset();
							}}
						>
							继续编辑
						</button>
					</div>
				</ConfirmDialog>
			)}
		</DraftContext>
	);
}

export function SettingsEditorDialog({
	id,
	title,
	dirty,
	pending,
	save,
	onClose,
	className = "",
	children,
}: {
	id: string;
	title: string;
	dirty: boolean;
	pending: boolean;
	save: () => Promise<boolean>;
	onClose: () => void;
	className?: string;
	children: (requestClose: () => void) => ReactNode;
}) {
	const [confirm, setConfirm] = useState(false);
	const [saving, setSaving] = useState(false);
	const busy = pending || saving;
	useSettingsDraft({
		id,
		label: title,
		dirty,
		pending: busy,
		save,
		discard: onClose,
	});
	function requestClose() {
		if (busy) return;
		if (dirty) setConfirm(true);
		else onClose();
	}
	return (
		<>
			<ConfirmDialog
				className={`settings-dialog ${className}`}
				titleId={`${id}-title`}
				onClose={requestClose}
			>
				<div className="settings-dialog-heading">
					<h2 id={`${id}-title`}>{title}</h2>
					<button
						type="button"
						className="settings-button secondary"
						aria-label="关闭"
						disabled={busy}
						onClick={requestClose}
					>
						×
					</button>
				</div>
				{children(requestClose)}
			</ConfirmDialog>
			{confirm && (
				<ConfirmDialog
					className="settings-dialog settings-leave-dialog"
					titleId={`${id}-discard-title`}
					onClose={() => {
						if (!busy) setConfirm(false);
					}}
				>
					<h2 id={`${id}-discard-title`}>保存这次修改？</h2>
					<p>关闭前可以保存，或放弃未保存的修改。</p>
					<div className="settings-actions">
						<button
							type="button"
							className="settings-button primary"
							disabled={busy}
							onClick={async () => {
								setSaving(true);
								try {
									if (await save()) onClose();
									else setConfirm(false);
								} catch {
									setConfirm(false);
								} finally {
									setSaving(false);
								}
							}}
						>
							保存并关闭
						</button>
						<button
							type="button"
							className="settings-button danger"
							disabled={busy}
							onClick={onClose}
						>
							放弃修改
						</button>
						<button
							type="button"
							className="settings-button secondary"
							disabled={busy}
							data-dialog-cancel
							onClick={() => setConfirm(false)}
						>
							继续编辑
						</button>
					</div>
				</ConfirmDialog>
			)}
		</>
	);
}

export function SettingsSaveBar({
	dirty,
	saved,
	pending,
	onReset,
	formId,
	saveLabel = "保存更改",
}: {
	dirty: boolean;
	saved: boolean;
	pending: boolean;
	onReset: () => void;
	formId?: string;
	saveLabel?: string;
}) {
	return (
		<div className="settings-savebar">
			<span
				className={dirty ? "settings-dirty" : "settings-hint"}
				role="status"
			>
				{pending
					? "正在保存…"
					: dirty
						? "有未保存的修改"
						: saved
							? "已保存"
							: "修改后保存生效"}
			</span>
			<div className="settings-actions">
				<button
					type="button"
					className="settings-button secondary"
					disabled={!dirty || pending}
					onClick={onReset}
				>
					放弃修改
				</button>
				<button
					type="submit"
					form={formId}
					className="settings-button primary"
					disabled={!dirty || pending}
				>
					{pending ? "保存中…" : saveLabel}
				</button>
			</div>
		</div>
	);
}
