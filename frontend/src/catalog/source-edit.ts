import type { SourceFields } from "../content";

export function changedSourceFields(
	fields: SourceFields,
	initial: SourceFields,
): Partial<SourceFields> {
	return Object.fromEntries(
		(Object.keys(initial) as (keyof SourceFields)[])
			.filter((key) => fields[key] !== initial[key])
			.map((key) => [key, fields[key]]),
	);
}
