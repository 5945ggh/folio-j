import { useQuery } from "@tanstack/react-query";
import { useViewActivity } from "../navigation/view-activity";
import { getTranslationResult } from "../translation/api";
import { ReaderPanel } from "./ReaderControls";
import { useReaderSessionRefresh } from "./reader-session-query";

/** A saved translation remains readable when its historical source can no longer be located. */
export function ReaderSearchTranslation({
	materialId,
	resultId,
	inactive,
	onClose,
}: {
	materialId: string;
	resultId: string;
	inactive: boolean;
	onClose: () => void;
}) {
	const activity = useViewActivity();
	const enabled = activity.active && !inactive;
	const key = ["translation-result", resultId];
	const query = useQuery({
		queryKey: key,
		queryFn: async ({ signal }) => {
			const result = await getTranslationResult(resultId, signal);
			if (
				result.reader_deleted ||
				result.material_deleted ||
				result.material_provenance.material_id !== materialId
			)
				throw new Error("译文已移除或材料不可用");
			return result;
		},
		enabled,
		staleTime: activity.activation > 0 ? Number.POSITIVE_INFINITY : 0,
		refetchOnMount: "always",
		retry: false,
	});
	const refreshed = useReaderSessionRefresh(
		key,
		query.refetch,
		enabled,
		activity.activation,
	);
	const result =
		refreshed && query.isFetchedAfterMount && !query.isError
			? query.data
			: undefined;
	return (
		<ReaderPanel title="已保存译文" inactive={inactive} onClose={onClose}>
			<div className="reader-search-saved-translation">
				<p className="reader-search-empty">
					原文位置暂不可用，以下为已保存内容。
				</p>
				{query.isError ? (
					<p role="alert">
						{query.error.message}
						<button type="button" onClick={() => void query.refetch()}>
							重试
						</button>
					</p>
				) : !result ? (
					<p role="status">正在读取译文…</p>
				) : (
					<>
						<blockquote lang="ja">{result.text}</blockquote>
						<p>{result.translation}</p>
					</>
				)}
			</div>
		</ReaderPanel>
	);
}
