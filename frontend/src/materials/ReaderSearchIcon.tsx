import { Icon } from "../catalog/LibraryTools";

export function ReaderSearchIcon({
	name,
}: {
	name:
		| "original"
		| "segment"
		| "translation"
		| "bookmark"
		| "check"
		| "minus"
		| "chevron"
		| "chapters"
		| "search"
		| "filter";
}) {
	if (name === "search" || name === "filter") return <Icon name={name} />;
	const path = {
		original:
			"M3 5h18M3 10h10M3 15h7M17 19l4 3M20 16a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
		segment: "m12 3 10 5-10 5L2 8l10-5zM2 12l10 5 10-5M2 16l10 5 10-5",
		translation:
			"M4 5h12M10 3v2M7 5c0 6 5 9 8 11M14 5c0 5-5 10-10 12M13 21l5-11 5 11M15 17h6",
		bookmark: "M6 3h12v18l-6-4-6 4V3z",
		check: "m5 12 4 4L19 6",
		minus: "M5 12h14",
		chevron: "m9 5 7 7-7 7",
		chapters: "m3 6 2 2 4-4M12 6h9M3 13h6M12 13h9M3 20h6M12 20h9",
	}[name];
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={path} />
		</svg>
	);
}
