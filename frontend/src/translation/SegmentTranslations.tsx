import { useQuery } from "@tanstack/react-query";
import { InlineError } from "../Shared";
import { getSegmentTranslations } from "./api";
import "./translation.css";

export function SegmentCurrentTranslation({
	translation,
}: {
	translation: string;
}) {
	if (!translation.trim()) return null;
	return (
		<section className="segment-translation-area" aria-label="当前译文">
			<h3>当前译文</h3>
			<p className="segment-current-translation">{translation}</p>
		</section>
	);
}

export function SegmentTranslations({ segmentId }: { segmentId: string }) {
	const results = useQuery({
		queryKey: ["segment-translations", segmentId],
		queryFn: () => getSegmentTranslations(segmentId),
		retry: false,
	});
	if (results.isSuccess && results.data.length === 0) return null;
	return (
		<section className="segment-translation-area" aria-label="关联翻译记录">
			<InlineError error={results.error} />
			{results.isPending && <p role="status">正在读取翻译记录…</p>}
			{results.isError && (
				<button type="button" onClick={() => void results.refetch()}>
					重试读取
				</button>
			)}
			{!!results.data?.length && (
				<details className="segment-translations">
					<summary>关联的翻译记录（{results.data.length}）</summary>
					<p className="segment-translation-hint">回看记录不会改写当前译文。</p>
					{results.data.map((item) => (
						<details key={item.id}>
							<summary>
								{item.scheme_name} · {item.target_language} ·{" "}
								{new Date(item.created_at).toLocaleString()}
							</summary>
							<p>{item.translation}</p>
							<details className="segment-translation-context">
								<summary>本次翻译的语境与模型</summary>
								<p>前文：{item.context_before || "（空）"}</p>
								<p>后文：{item.context_after || "（空）"}</p>
								<p>模型：{item.model_id}</p>
							</details>
							{item.material_deleted && <p>原材料已删除；此译文快照保留。</p>}
							{item.reader_deleted && (
								<p>此处阅读翻译已删除；关联译文快照保留。</p>
							)}
						</details>
					))}
				</details>
			)}
		</section>
	);
}
