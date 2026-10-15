import "./book-cover-placeholder.css";
export function BookCoverPlaceholder({ title }: { title: string }) {
	return (
		<div
			className="book-cover-placeholder r1-cover-fallback"
			aria-hidden="true"
		>
			<strong className="r1-cover-title">{title}</strong>
			<i className="r1-cover-slashes" />
		</div>
	);
}
