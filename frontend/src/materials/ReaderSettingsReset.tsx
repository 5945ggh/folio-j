/** Compact group action; the accessible name keeps its scope explicit. */
export function ReaderSettingsReset({
	label,
	description,
	disabled = false,
	onReset,
}: {
	label: string;
	description: string;
	disabled?: boolean;
	onReset: () => void;
}) {
	return (
		<button
			type="button"
			className="reader-settings-reset-button"
			aria-label={`重置${label}`}
			title={description}
			disabled={disabled}
			onClick={onReset}
		>
			重置
		</button>
	);
}
