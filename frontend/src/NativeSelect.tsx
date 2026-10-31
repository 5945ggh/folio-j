import type { ComponentPropsWithRef } from "react";
import "./native-select.css";

type NativeSelectProps = ComponentPropsWithRef<"select"> & {
	wrapperClassName?: string;
};

/** Keep native selection and focus behavior; share only the closed control's arrow. */
export function NativeSelect({
	className = "",
	wrapperClassName = "",
	multiple,
	size,
	...props
}: NativeSelectProps) {
	if (multiple || (size !== undefined && size > 1))
		return (
			<select
				{...props}
				className={className}
				multiple={multiple}
				size={size}
			/>
		);
	return (
		<span className={`native-select ${wrapperClassName}`}>
			<select
				{...props}
				className={`native-select-control ${className}`}
				size={size}
			/>
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
				focusable="false"
			>
				<path d="m4 6 4 4 4-4" />
			</svg>
		</span>
	);
}
