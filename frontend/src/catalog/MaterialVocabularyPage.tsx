import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { vocabularyReaderHref } from "../materials/vocabulary-navigation";
import { NativeSelect } from "../NativeSelect";
import { returnDestination, returnState } from "../navigation";
import { InlineError, Shell } from "../Shared";
import { bookDetailsKey, getBookDetails } from "./api";
import { statisticCount } from "./statistics";
import { materialStatisticsOptions } from "./statistics-query";
import {
	getVocabulary,
	getVocabularyOccurrences,
	type VocabularyItem,
} from "./vocabulary-api";
import {
	OCCURRENCE_PAGE_SIZE,
	readVocabularyState,
	updateVocabularyState,
	VOCABULARY_PAGE_SIZE,
	type VocabularyState,
} from "./vocabulary-state";
import "./book-management.css";
import "./vocabulary.css";

function Retry({ error, retry }: { error: Error; retry: () => void }) {
	return (
		<div className="vocabulary-state">
			<InlineError error={error} />
			<button type="button" className="book-details-action" onClick={retry}>
				重试
			</button>
		</div>
	);
}

function WordPagination({
	page,
	total,
	size,
	label,
	change,
}: {
	page: number;
	total: number;
	size: number;
	label: string;
	change: (page: number) => void;
}) {
	const pages = Math.max(1, Math.ceil(total / size));
	if (pages === 1 && page === 1) return null;
	return (
		<nav className="vocabulary-pagination" aria-label={`${label}分页`}>
			<button
				type="button"
				className="book-details-action"
				disabled={page <= 1}
				onClick={() => change(page - 1)}
				aria-label={`${label}上一页`}
			>
				上一页
			</button>
			<span>
				第 {page} / {pages} 页
			</span>
			<button
				type="button"
				className="book-details-action"
				disabled={page >= pages}
				onClick={() => change(page + 1)}
				aria-label={`${label}下一页`}
			>
				下一页
			</button>
		</nav>
	);
}

function posLabels(item: VocabularyItem): string {
	return [
		...new Set(item.parts_of_speech.map((pos) => pos[0]).filter(Boolean)),
	].join(" · ");
}

function WordOccurrences({
	materialId,
	versionId,
	generationId,
	state,
	selected,
	change,
}: {
	materialId: string;
	versionId: string;
	generationId: string;
	state: VocabularyState;
	selected?: VocabularyItem;
	change: (patch: Partial<VocabularyState>, push?: boolean) => void;
}) {
	const location = useLocation();
	const heading = useRef<HTMLHeadingElement>(null);
	const back = returnDestination(location.state, {
		to: `/materials/${materialId}/details`,
		label: "书籍详情",
	});
	const params = {
		version_id: versionId,
		generation_id: generationId,
		word: state.word,
		pos: state.pos || undefined,
		offset: (state.occurrencePage - 1) * OCCURRENCE_PAGE_SIZE,
		limit: OCCURRENCE_PAGE_SIZE,
	};
	const result = useQuery({
		queryKey: ["materials", materialId, "vocabulary-occurrences", params],
		queryFn: ({ signal }) =>
			getVocabularyOccurrences(materialId, params, signal),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnMount: "always",
	});
	useEffect(() => {
		if (window.matchMedia("(max-width: 760px)").matches) {
			heading.current?.focus({ preventScroll: true });
			heading.current?.scrollIntoView({ block: "start" });
		}
	}, []);
	return (
		<section
			className="vocabulary-occurrences"
			aria-label="出现位置"
			aria-busy={result.isFetching}
		>
			<header className="vocabulary-occurrence-heading">
				<button
					type="button"
					className="vocabulary-close"
					onClick={() => change({ word: "" })}
				>
					<span aria-hidden="true">← </span>返回词汇列表
				</button>
				<div className="vocabulary-word-title">
					<h2 ref={heading} tabIndex={-1} lang="ja">
						{state.word}
					</h2>
					<span>出现位置</span>
				</div>
				{selected && (
					<p lang="ja">
						{selected.readings.join(" · ")}
						{selected.readings.length > 0 ? "　" : ""}
						{posLabels(selected)}
					</p>
				)}
				{result.data && !result.isError && (
					<p>
						{state.pos ? `${state.pos} · ` : ""}共{" "}
						{statisticCount(result.data.total)} 次，按原文顺序
					</p>
				)}
			</header>
			{result.isPending ? (
				<p className="vocabulary-state" role="status">
					正在读取出现位置…
				</p>
			) : result.isError ? (
				<Retry error={result.error} retry={() => void result.refetch()} />
			) : result.data.items.length === 0 ? (
				<div className="vocabulary-state">
					<p>当前条件下没有出现位置。</p>
					{state.occurrencePage > 1 && (
						<button
							type="button"
							className="book-details-action"
							onClick={() => change({ occurrencePage: 1 })}
						>
							返回第一页
						</button>
					)}
				</div>
			) : (
				<ol
					className="vocabulary-occurrence-list"
					start={result.data.offset + 1}
				>
					{result.data.items.map((item, index) => {
						const href = vocabularyReaderHref(materialId, versionId, item);
						return (
							<li key={`${item.resource_id}:${item.start}:${item.end}`}>
								<div className="vocabulary-occurrence-source">
									<span>{result.data.offset + index + 1}</span>
									<span>{item.chapter_title || "正文资源"}</span>
								</div>
								<p className="vocabulary-context" lang="ja">
									{item.before}
									<mark>{item.match}</mark>
									{item.after}
								</p>
								<div className="vocabulary-occurrence-footer">
									<span lang="ja">
										{item.reading} ·{" "}
										{item.parts_of_speech
											.filter((part) => part !== "*")
											.join("・")}
									</span>
									{href ? (
										<Link
											to={href}
											state={returnState(
												{
													to: `${location.pathname}${location.search}`,
													label: "词汇列表",
												},
												back,
												`/materials/${materialId}`,
											)}
										>
											查看原文 <span aria-hidden="true">↗</span>
										</Link>
									) : (
										<span>此处暂无法定位到阅读页</span>
									)}
								</div>
							</li>
						);
					})}
				</ol>
			)}
			{result.data && !result.isError && (
				<WordPagination
					page={state.occurrencePage}
					total={result.data.total}
					size={OCCURRENCE_PAGE_SIZE}
					label="出现位置"
					change={(occurrencePage) => change({ occurrencePage })}
				/>
			)}
		</section>
	);
}

function VocabularyExplorer({
	materialId,
	versionId,
	generationId,
}: {
	materialId: string;
	versionId: string;
	generationId: string;
}) {
	const location = useLocation();
	const navigate = useNavigate();
	const state = readVocabularyState(location.search);
	const [draft, setDraft] = useState(state.q);
	const list = useRef<HTMLDivElement>(null);
	const previousWord = useRef(state.word);
	const params = {
		version_id: versionId,
		generation_id: generationId,
		q: state.q,
		pos: state.pos || undefined,
		sort: state.sort,
		offset: (state.page - 1) * VOCABULARY_PAGE_SIZE,
		limit: VOCABULARY_PAGE_SIZE,
	};
	const vocabulary = useQuery({
		queryKey: ["materials", materialId, "vocabulary", params],
		queryFn: ({ signal }) => getVocabulary(materialId, params, signal),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnMount: "always",
	});
	function change(patch: Partial<VocabularyState>, push = false) {
		void navigate(
			{
				pathname: location.pathname,
				search: updateVocabularyState(state, patch),
			},
			{ replace: !push, state: location.state },
		);
	}
	useEffect(() => setDraft(state.q), [state.q]);
	useEffect(() => {
		const previous = previousWord.current;
		previousWord.current = state.word;
		if (previous && !state.word) {
			const button = [
				...(list.current?.querySelectorAll<HTMLButtonElement>(
					"button[data-word]",
				) ?? []),
			].find((item) => item.dataset.word === previous);
			button?.focus({ preventScroll: true });
			button?.scrollIntoView({ block: "nearest" });
		}
	}, [state.word]);
	useEffect(() => {
		if (!vocabulary.data) return;
		list.current
			?.querySelector("[aria-pressed=true]")
			?.scrollIntoView({ block: "nearest" });
	}, [vocabulary.data]);
	const data = vocabulary.data;
	const selected = data?.items.find((item) => item.word === state.word);
	return (
		<div className="vocabulary-explorer" data-word-open={Boolean(state.word)}>
			<div className="vocabulary-explorer-toolbar">
				<form
					className="vocabulary-search"
					onSubmit={(event) => {
						event.preventDefault();
						change({ q: draft });
					}}
				>
					<label>
						<span className="sr-only">搜索词形或读音</span>
						<input
							type="search"
							value={draft}
							maxLength={160}
							placeholder="搜索词形或读音"
							onChange={(event) => {
								setDraft(event.target.value);
								if (!event.target.value && state.q) change({ q: "" });
							}}
						/>
					</label>
					<button type="submit" className="book-details-action">
						搜索
					</button>
				</form>
				<label className="vocabulary-filter">
					<span>词性</span>
					<NativeSelect
						aria-label="词性"
						value={state.pos}
						onChange={(event) => change({ pos: event.target.value })}
					>
						<option value="">全部词性</option>
						{state.pos && !data?.available_pos.includes(state.pos) && (
							<option value={state.pos}>{state.pos}</option>
						)}
						{data?.available_pos.map((pos) => (
							<option key={pos} value={pos}>
								{pos}
							</option>
						))}
					</NativeSelect>
				</label>
				<label className="vocabulary-filter">
					<span>排序</span>
					<NativeSelect
						aria-label="词频排序"
						value={state.sort}
						onChange={(event) =>
							change({
								sort:
									event.target.value === "frequency_asc"
										? "frequency_asc"
										: "frequency_desc",
							})
						}
					>
						<option value="frequency_desc">出现次数 · 从多到少</option>
						<option value="frequency_asc">出现次数 · 从少到多</option>
					</NativeSelect>
				</label>
			</div>
			<div className="vocabulary-result-summary" role="status">
				<span>
					{vocabulary.isPending
						? "正在读取词汇…"
						: vocabulary.isError
							? "词汇暂不可用"
							: `${statisticCount(data?.total)} 种词${state.q || state.pos ? "符合筛选条件" : ""}`}
					<span className="vocabulary-count-note">
						{state.pos ? " · 次数仅统计所选词性" : " · 按词典形归并"}
					</span>
				</span>
				{(state.q || state.pos) && (
					<button type="button" onClick={() => change({ q: "", pos: "" })}>
						清空筛选
					</button>
				)}
			</div>
			<div className="vocabulary-workspace">
				<section
					className="vocabulary-list-panel"
					aria-label="词汇列表"
					aria-busy={vocabulary.isFetching}
				>
					<div className="vocabulary-list-heading">
						<span>词汇 / 读音</span>
						<span>词性</span>
						<span>次数</span>
					</div>
					<div className="vocabulary-list" ref={list}>
						{vocabulary.isPending ? (
							<p className="vocabulary-state">正在读取词汇…</p>
						) : vocabulary.isError ? (
							<Retry
								error={vocabulary.error}
								retry={() => void vocabulary.refetch()}
							/>
						) : data?.status === "unavailable" ? (
							<p className="vocabulary-state">
								词汇尚未准备，完成文本分析后会自动显示。
							</p>
						) : data?.items.length === 0 ? (
							<div className="vocabulary-state">
								<p>
									{state.q || state.pos
										? "没有符合条件的词汇。试试其他词形、读音或词性。"
										: "当前材料没有可计入的词汇。"}
								</p>
								{state.page > 1 && (
									<button
										type="button"
										className="book-details-action"
										onClick={() => change({ page: 1 })}
									>
										返回第一页
									</button>
								)}
							</div>
						) : (
							data?.items.map((item) => (
								<button
									key={item.word}
									type="button"
									className="vocabulary-row"
									data-word={item.word}
									aria-pressed={state.word === item.word}
									onClick={() => change({ word: item.word }, true)}
								>
									<span className="vocabulary-row-word" lang="ja">
										<strong>{item.word}</strong>
										<small>
											{item.readings.join(" · ")}
											{item.variants_truncated ? " 等" : ""}
										</small>
									</span>
									<span className="vocabulary-row-pos" lang="ja">
										{posLabels(item)}
									</span>
									<span className="vocabulary-frequency">
										{statisticCount(item.frequency)}
										<span aria-hidden="true"> ›</span>
									</span>
								</button>
							))
						)}
					</div>
					{data && !vocabulary.isError && (
						<WordPagination
							page={state.page}
							total={data.total}
							size={VOCABULARY_PAGE_SIZE}
							label="词汇"
							change={(page) => change({ page })}
						/>
					)}
				</section>
				{state.word ? (
					<WordOccurrences
						key={`${generationId}:${state.word}:${state.pos}`}
						materialId={materialId}
						versionId={versionId}
						generationId={generationId}
						state={state}
						selected={selected}
						change={change}
					/>
				) : (
					<aside className="vocabulary-empty-detail">
						<span aria-hidden="true">文</span>
						<h2>在原文中理解词汇</h2>
						<p>选择一个词，查看它的实际词形、上下文与出现位置。</p>
					</aside>
				)}
			</div>
		</div>
	);
}

function VocabularyContent({
	materialId,
	versionId,
}: {
	materialId: string;
	versionId: string;
}) {
	const location = useLocation();
	const back = returnDestination(location.state, {
		to: `/materials/${materialId}/details`,
		label: "书籍详情",
	});
	const analysis = useQuery(materialStatisticsOptions(materialId, versionId));
	if (analysis.isPending)
		return (
			<p className="vocabulary-state" role="status">
				正在读取文本分析…
			</p>
		);
	if (analysis.isError)
		return (
			<Retry error={analysis.error} retry={() => void analysis.refetch()} />
		);
	if (!analysis.data.generation_id)
		return (
			<div className="vocabulary-state">
				<h2>词汇尚未准备</h2>
				<p>
					完成文本分析后，词汇会在这里自动显示。已有书籍可以进入阅读以准备注音与分词。
				</p>
				<Link
					className="book-details-action"
					to={`/materials/${materialId}`}
					state={returnState(
						{ to: `${location.pathname}${location.search}`, label: "词汇列表" },
						back,
						`/materials/${materialId}`,
					)}
				>
					进入阅读
				</Link>
			</div>
		);
	return (
		<VocabularyExplorer
			materialId={materialId}
			versionId={versionId}
			generationId={analysis.data.generation_id}
		/>
	);
}

export function MaterialVocabularyPage() {
	const { id = "" } = useParams();
	return <MaterialVocabulary key={id} id={id} />;
}

function MaterialVocabulary({ id }: { id: string }) {
	const location = useLocation();
	const details = useQuery({
		queryKey: bookDetailsKey(id),
		queryFn: () => getBookDetails(id),
	});
	const back = returnDestination(location.state, {
		to: `/materials/${id}/details`,
		label: "书籍详情",
	});
	return (
		<Shell className="vocabulary-page">
			<header className="book-details-toolbar">
				<Link className="book-details-back" to={back.to} state={back.state}>
					<span aria-hidden="true">←</span>
					{back.label}
				</Link>
				<span className="book-details-toolbar-divider" aria-hidden="true" />
				<span>词汇</span>
			</header>
			<div className="vocabulary-page-heading">
				<div>
					<p className="vocabulary-material-title">
						{details.data?.title || "材料词汇"}
					</p>
					<h1>词汇</h1>
				</div>
				<p>从出现频率到具体语境</p>
			</div>
			{details.isPending ? (
				<p className="vocabulary-state" role="status">
					正在读取材料信息…
				</p>
			) : details.isError ? (
				<Retry error={details.error} retry={() => void details.refetch()} />
			) : (
				<VocabularyContent
					materialId={id}
					versionId={details.data.version_id}
				/>
			)}
			<details className="vocabulary-rules">
				<summary>词汇范围与计数方式</summary>
				<p>
					范围为全部可提取正文，包括目录和后记。同一正文资源重复呈现只计一次；出现位置优先定位到第一个可完整显示该词的位置。
				</p>
				<p>
					按词典形归并，缺失时使用原文词形。保留助词、助动词、数字和未登录词，排除空白、标点和零跨度记录。词性筛选后重新计算次数；搜索词形或读音会显示命中词在所选词性下的全部出现。
				</p>
				<p>
					读音来自原文中的实际切分结果，同一词可以有多种读音和词性。结果随文本分析更新。
				</p>
			</details>
		</Shell>
	);
}
