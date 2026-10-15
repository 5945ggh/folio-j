import { useMutation, useQueryClient } from "@tanstack/react-query";
import { InlineError } from "../Shared";
import { patchSettings, type Settings } from "./api";
import {
	SettingsSaveBar,
	useSettingsDraft,
	useSettingsFields,
} from "./SettingsForms";
import { commitSettingsResponse } from "./settings-cache";

type PermissionFields = Pick<Settings["defaults"], "permission_mode">;
const permissionFields = (settings: Settings): PermissionFields => ({
	permission_mode: settings.defaults.permission_mode,
});

export function PermissionSettings({ settings }: { settings: Settings }) {
	const client = useQueryClient();
	const draft = useSettingsFields(permissionFields(settings));
	const save = useMutation({
		mutationFn: (defaults: PermissionFields) => patchSettings({ defaults }),
	});
	async function persist() {
		const submitted = draft.fields;
		try {
			const result = await save.mutateAsync(submitted);
			await commitSettingsResponse(client, result, () =>
				draft.accept(submitted, permissionFields(result)),
			);
			return true;
		} catch {
			return false;
		}
	}
	useSettingsDraft({
		id: "conversation-permissions",
		label: "对话与权限",
		dirty: draft.dirty,
		pending: save.isPending,
		save: persist,
		discard: draft.reset,
	});
	return (
		<form
			className="settings-page-form"
			onSubmit={(event) => {
				event.preventDefault();
				void persist();
			}}
		>
			<section
				className="settings-section"
				aria-labelledby="default-permissions-heading"
			>
				<div className="settings-section-heading">
					<h3 id="default-permissions-heading">新对话默认权限</h3>
				</div>
				<fieldset
					className="settings-group settings-permission-group"
					disabled={save.isPending}
				>
					<label className="settings-permission">
						<input
							type="radio"
							name="permission"
							value="review"
							checked={draft.fields.permission_mode === "review"}
							onChange={() => draft.change({ permission_mode: "review" })}
						/>
						<span>
							<strong>审核模式</strong>
							<small>涉及写入或修改学习成果时，先查看提议，再确认执行。</small>
						</span>
					</label>
					<label className="settings-permission">
						<input
							type="radio"
							name="permission"
							value="full_access"
							checked={draft.fields.permission_mode === "full_access"}
							onChange={() => draft.change({ permission_mode: "full_access" })}
						/>
						<span>
							<strong>完全访问</strong>
							<small>允许 Agent 在当前对话的权限范围内直接执行工具操作。</small>
						</span>
					</label>
				</fieldset>
				<p className="settings-hint settings-section-note">
					只影响此后创建的新对话；已有对话保留自己的权限设置。
				</p>
			</section>
			<InlineError error={save.error} />
			<SettingsSaveBar
				dirty={draft.dirty}
				saved={draft.saved}
				pending={save.isPending}
				onReset={draft.reset}
			/>
		</form>
	);
}
