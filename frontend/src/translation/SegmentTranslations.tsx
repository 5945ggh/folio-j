import { useQuery } from "@tanstack/react-query";
import { InlineError } from "../Shared";
import { getSegmentTranslations } from "./api";
import "./translation.css";
export function SegmentTranslations({ segmentId }: { segmentId: string }) {
	const results = useQuery({
		queryKey: ["segment-translations", segmentId],
		queryFn: () => getSegmentTranslations(segmentId),
		retry: false,
	});
	return (
		<details className="segment-translations">
			<summary>
				关联的翻译记录{results.data?.length ? `（${results.data.length}）` : ""}
			</summary>
			<InlineError error={results.error} />
			{results.isPending && <p role="status">正在读取翻译记录…</p>}
			{results.isError && (
				<button type="button" onClick={() => void results.refetch()}>
					重试读取
				</button>
			)}
			{results.data?.map((item) => (
				<details key={item.id}>
					<summary>
						{item.scheme_name} · {item.target_language} ·{" "}
						{new Date(item.created_at).toLocaleString()}
					</summary>
					<p>{item.translation}</p>
					<small>模型：{item.model_id}；回看不会改写当前采用译文。</small>
					<p>前文：{item.context_before || "（空）"}</p>
					<p>后文：{item.context_after || "（空）"}</p>
					{item.material_deleted && <p>原材料已删除；此译文快照保留。</p>}
				</details>
			))}
			{results.data?.length === 0 && (
				<p>还没有关联的翻译结果。当前采用文在片段资料中查看。</p>
			)}
		</details>
	);
}
