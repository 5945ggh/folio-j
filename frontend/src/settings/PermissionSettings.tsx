import { useQueryClient } from "@tanstack/react-query";
import { useAutosavingFields } from "./AutosavingSettings";
import { patchSettings, type Settings } from "./api";
import { commitSettingsResponse } from "./settings-cache";

type PermissionFields = Pick<Settings["defaults"], "permission_mode">;
const permissionFields = (settings: Settings): PermissionFields => ({
	permission_mode: settings.defaults.permission_mode,
});

export function PermissionSettings({ settings }: { settings: Settings }) {
	const client = useQueryClient();
	const draft = useAutosavingFields(
		"conversation-permissions",
		"对话与权限",
		permissionFields(settings),
		async (defaults, accept) => {
			const result = await patchSettings({ defaults });
			await commitSettingsResponse(client, result, () =>
				accept(permissionFields(result)),
			);
		},
		"请选择新对话的默认权限。",
	);
	return (
		<form
			className="settings-page-form"
			ref={draft.form}
			onSubmit={(event) => {
				event.preventDefault();
				draft.finishEditing();
			}}
		>
			<section
				className="settings-section"
				aria-labelledby="default-permissions-heading"
			>
				<div className="settings-section-heading">
					<h3 id="default-permissions-heading">新对话默认权限</h3>
				</div>
				<fieldset className="settings-group settings-permission-group">
					<label className="settings-permission">
						<input
							type="radio"
							name="permission"
							value="review"
							checked={draft.fields.permission_mode === "review"}
							onChange={() => draft.select({ permission_mode: "review" })}
						/>
						<span>
							<strong>修改前确认</strong>
							<small>
								AI 需要修改讲解内容时，先展示具体方案，经你确认后再保存。
							</small>
						</span>
					</label>
					<label className="settings-permission">
						<input
							type="radio"
							name="permission"
							value="full_access"
							checked={draft.fields.permission_mode === "full_access"}
							onChange={() => draft.select({ permission_mode: "full_access" })}
						/>
						<span>
							<strong>允许直接修改</strong>
							<small>
								AI 可在当前对话中直接保存对讲解的修改，无需逐次确认。
							</small>
						</span>
					</label>
				</fieldset>
				<p className="settings-hint settings-section-note">
					仅对之后新建的对话生效，已有对话不受影响。
				</p>
			</section>
			{draft.feedback}
		</form>
	);
}
