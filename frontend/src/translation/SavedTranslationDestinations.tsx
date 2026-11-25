import { Link } from "react-router";

export function SavedTranslationDestinations({
	ids,
	onOpenSegment,
}: {
	ids: string[];
	onOpenSegment?: (id: string) => void;
}) {
	return (
		<section aria-label="已保存的学习片段">
			<p role="status">
				{ids.length > 1
					? `已保存到 ${ids.length} 个学习片段`
					: "已保存到学习片段"}
			</p>
			<div className="translation-actions">
				{ids.map((id, index) =>
					onOpenSegment ? (
						<button type="button" key={id} onClick={() => onOpenSegment(id)}>
							{ids.length > 1 ? `打开片段 ${index + 1} →` : "打开片段 →"}
						</button>
					) : (
						<Link key={id} to={`/segments/${id}`}>
							{ids.length > 1 ? `打开片段 ${index + 1} →` : "打开片段 →"}
						</Link>
					),
				)}
			</div>
		</section>
	);
}
