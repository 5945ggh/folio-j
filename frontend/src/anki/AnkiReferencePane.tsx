import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
	analysisKeys,
	analysisListOptions,
	getAnalysis,
} from "../analysis/api";
import { Markdown } from "../analysis/Markdown";
import { getSegment, queries } from "../content";
import { DictionaryDefinitionNodes } from "../dictionary/DictionaryDefinitionNodes";
import {
	type DictionaryMatch,
	dictionaryIdentity,
	dictionaryKey,
	getDictionary,
	lookupDictionary,
} from "../dictionary/dictionary-api";
import type { ChapterTranslation } from "../materials/chapter-translations-query";
import { ReaderSearchIcon } from "../materials/ReaderSearchIcon";
import type { ChapterSegment } from "../materials/study-api";
import { previewAnalyses, previewDocument } from "../materials/study-preview";
import { NativeSelect } from "../NativeSelect";
import {
	getTranslationHistory,
	type TranslationResult,
} from "../translation/api";
import type { AnkiFieldDefinition } from "./api";
import { type AnkiMaterialContext, dictionarySenseTexts } from "./context";

export type ReferenceTab = "dictionary" | "translation" | "segment";

const DICTIONARY_QUERY_LIMIT = 8192;

function initialDictionarySearch(context: AnkiMaterialContext): string {
	if (context.dictionarySeed) {
		return context.dictionarySeed.term || context.dictionarySeed.surface;
	}
	const selection = context.selection.trim();
	// Match the dictionary's maximum word span and leave sentence queries in context.
	return context.origin === "selection" &&
		Array.from(selection).length <= 32 &&
		!/[\p{White_Space}\p{Punctuation}]/u.test(selection)
		? selection
		: "";
}

function FillButton({
	label,
	fieldName,
	onClick,
}: {
	label: string;
	fieldName?: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className="anki-fill-btn"
			aria-label={label}
			data-tooltip={label}
			onClick={onClick}
		>
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<path d="M4 18v-3a6 6 0 0 1 6-6h10m-5-5 5 5-5 5" />
			</svg>
			{fieldName}
		</button>
	);
}

function DictionaryReferenceBody({
	entry,
	fillLabel,
	onAdopt,
}: {
	entry: DictionaryMatch;
	fillLabel: string;
	onAdopt: (text: string) => void;
}) {
	const senses = useMemo(() => dictionarySenseTexts(entry), [entry]);
	return (
		<div className="dict-definitions" lang="ja">
			<DictionaryDefinitionNodes
				nodes={entry.definitions}
				actionFor={(node) => {
					const text = senses.get(node);
					return (
						text && (
							<FillButton label={fillLabel} onClick={() => onAdopt(text)} />
						)
					);
				}}
			/>
		</div>
	);
}

function TranslationGroupCard({
	materialId,
	translation,
	initial,
	fillLabel,
	onAdopt,
}: {
	materialId: string;
	translation: Pick<ChapterTranslation, "excerpt" | "identity_sha256">;
	initial?: TranslationResult;
	fillLabel: string;
	onAdopt: (text: string) => void;
}) {
	const history = useInfiniteQuery({
		queryKey: [
			"anki-ref-translation-history",
			materialId,
			translation.identity_sha256,
		],
		initialPageParam: 0,
		queryFn: ({ pageParam, signal }) =>
			getTranslationHistory(
				materialId,
				pageParam,
				translation.identity_sha256,
				signal,
			),
		getNextPageParam: (lastPage) => lastPage.next_offset ?? undefined,
		retry: false,
	});

	const results = useMemo(() => {
		const seen = new Map<string, TranslationResult>();
		if (initial) seen.set(initial.id, initial);
		for (const page of history.data?.pages ?? []) {
			for (const item of page.results) {
				if (!seen.has(item.id)) seen.set(item.id, item);
			}
		}
		return [...seen.values()];
	}, [history.data, initial]);

	return (
		<section className="anki-ref-card">
			<p className="anki-ref-group-title" lang="ja">
				{translation.excerpt}
			</p>
			{history.isPending && <p className="anki-ref-meta">正在加载译文…</p>}
			{history.isError && (
				<div className="anki-ref-meta">
					加载译文失败。{" "}
					<button
						type="button"
						className="anki-link-btn"
						onClick={() => void history.refetch()}
					>
						重试
					</button>
				</div>
			)}
			{results.map((item) => (
				<div className="anki-sense-row" key={item.id}>
					<div className="anki-sense-text">
						<div className="anki-ref-meta" style={{ marginBottom: 3 }}>
							{new Date(item.created_at).toLocaleString()} ·{" "}
							{item.target_language}
						</div>
						<div>{item.translation}</div>
					</div>
					<FillButton
						label={fillLabel}
						onClick={() => onAdopt(item.translation)}
					/>
				</div>
			))}
			{history.hasNextPage && (
				<button
					type="button"
					className="anki-link-btn"
					disabled={history.isFetchingNextPage}
					onClick={() => void history.fetchNextPage()}
				>
					{history.isFetchingNextPage ? "正在加载…" : "加载更早的译文"}
				</button>
			)}
		</section>
	);
}

function SegmentDetailCard({
	segment,
	expanded,
	onToggle,
	fillLabel,
	onAdopt,
}: {
	segment: ChapterSegment;
	expanded: boolean;
	onToggle: () => void;
	fillLabel: string;
	onAdopt: (text: string) => void;
}) {
	const detailQuery = useQuery({
		queryKey: queries.segment(segment.segment_id),
		queryFn: ({ signal }) => getSegment(segment.segment_id, signal),
		enabled: expanded,
		retry: false,
	});
	const analysesQuery = useInfiniteQuery({
		...analysisListOptions(segment.segment_id),
		enabled: expanded,
		retry: false,
	});
	const analyses = previewAnalyses(
		analysesQuery.data?.pages,
		segment.segment_id,
	);
	const [selectedAnalysisId, setSelectedAnalysisId] = useState("");
	const activeAnalysis =
		analyses.find((item) => item.id === selectedAnalysisId) ?? analyses[0];
	const activeAnalysisId = activeAnalysis?.id ?? "";
	const revision = activeAnalysis?.current_revision_id;
	const analysisDetailQuery = useQuery({
		queryKey: analysisKeys.detail(activeAnalysisId, revision),
		queryFn: () => getAnalysis(activeAnalysisId, revision),
		enabled: expanded && Boolean(activeAnalysis),
		retry: false,
	});
	const detail = previewDocument(
		analysisDetailQuery.data,
		segment.segment_id,
		activeAnalysis,
	);
	const translationText = detailQuery.data?.translation?.trim() || "";
	const noteText = detailQuery.data?.note?.trim() || "";
	const explanationMarkdown = detail?.source_md?.trim() || "";

	return (
		<section className="anki-ref-card">
			<div className="anki-ref-card-head">
				<span className="anki-ref-group-title" lang="ja" style={{ margin: 0 }}>
					{segment.excerpt}
				</span>
				<button
					type="button"
					className="anki-link-btn"
					aria-expanded={expanded}
					onClick={onToggle}
				>
					{expanded ? "收起" : "展开查看"}
				</button>
			</div>
			<div className="anki-ref-meta">
				保存于 {new Date(segment.created_at).toLocaleString()}
			</div>

			{expanded && (
				<>
					{detailQuery.isPending && (
						<p className="anki-ref-meta">正在加载片段内容…</p>
					)}
					{detailQuery.isError && (
						<div className="anki-ref-meta">
							加载片段失败。{" "}
							<button
								type="button"
								className="anki-link-btn"
								onClick={() => void detailQuery.refetch()}
							>
								重试
							</button>
						</div>
					)}
					{translationText && (
						<div className="anki-sense-row">
							<div className="anki-sense-text">
								<div className="anki-ref-meta">片段译文</div>
								<div>{translationText}</div>
							</div>
							<FillButton
								label={fillLabel}
								onClick={() => onAdopt(translationText)}
							/>
						</div>
					)}
					{noteText && (
						<div className="anki-sense-row">
							<div className="anki-sense-text">
								<div className="anki-ref-meta">备注</div>
								<div>{noteText}</div>
							</div>
							<FillButton label={fillLabel} onClick={() => onAdopt(noteText)} />
						</div>
					)}
					{(analysesQuery.isError || analysisDetailQuery.isError) && (
						<p role="alert" className="anki-ref-meta">
							加载讲解失败。{" "}
							<button
								type="button"
								className="anki-link-btn"
								onClick={() =>
									void (analysesQuery.isError
										? analysesQuery.refetch()
										: analysisDetailQuery.refetch())
								}
							>
								重试
							</button>
						</p>
					)}
					{analyses.length > 0 && (
						<div className="anki-sense-row" style={{ flexDirection: "column" }}>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									width: "100%",
									gap: 8,
								}}
							>
								<span className="anki-ref-meta">
									讲解（划选任意文字可摘录）
								</span>
								{analyses.length > 1 && (
									<NativeSelect
										className="anki-reader-select"
										style={{ width: "auto", maxWidth: 180 }}
										aria-label="选择讲解"
										value={activeAnalysisId}
										onChange={(event) =>
											setSelectedAnalysisId(event.target.value)
										}
									>
										{analyses.map((item) => (
											<option key={item.id} value={item.id}>
												{item.title}
											</option>
										))}
									</NativeSelect>
								)}
							</div>
							{analysisDetailQuery.isPending && (
								<p className="anki-ref-meta">正在加载讲解…</p>
							)}
							{analysesQuery.hasNextPage && (
								<button
									type="button"
									className="anki-link-btn"
									onClick={() => void analysesQuery.fetchNextPage()}
									disabled={analysesQuery.isFetchingNextPage}
								>
									加载更多讲解
								</button>
							)}
							{explanationMarkdown && (
								<div
									className="anki-sense-text reader-markdown"
									style={{ width: "100%", fontSize: 12.5 }}
								>
									<Markdown text={explanationMarkdown} />
								</div>
							)}
						</div>
					)}
					{detailQuery.isSuccess &&
						!translationText &&
						!noteText &&
						analyses.length === 0 &&
						analysesQuery.isSuccess && (
							<p className="anki-ref-meta">
								该学习片段暂无译文、备注或讲解内容。
							</p>
						)}
				</>
			)}
		</section>
	);
}

export function AnkiReferencePane({
	context,
	materialId,
	segments,
	translations,
	textFields,
	activeFieldId,
	activeFieldHasValue,
	compactMode,
	isOpen,
	recordsStatus,
	onBackToDraft,
	onActiveFieldChange,
	onApplyText,
	onApplyTerm,
	onApplyReading,
	termFieldLabel,
	readingFieldLabel,
}: {
	context: AnkiMaterialContext;
	materialId: string;
	segments: readonly ChapterSegment[];
	translations: readonly ChapterTranslation[];
	textFields: readonly AnkiFieldDefinition[];
	activeFieldId: string;
	activeFieldHasValue: boolean;
	compactMode: boolean;
	isOpen: boolean;
	recordsStatus: "ready" | "error" | "loading";
	onBackToDraft: () => void;
	onActiveFieldChange: (fieldId: string) => void;
	onApplyText: (
		fieldId: string,
		text: string,
		mode: "replace" | "append",
	) => void;
	onApplyTerm: (entry: DictionaryMatch) => void;
	onApplyReading: (reading: string) => void;
	termFieldLabel?: string;
	readingFieldLabel?: string;
}) {
	const initialSearch = initialDictionarySearch(context);
	const [searchInput, setSearchInput] = useState(initialSearch);
	const [searchTerm, setSearchTerm] = useState("");
	const searchInputRef = useRef<HTMLInputElement>(null);
	const composingSearch = useRef(false);
	const searchText = searchInput.trim().normalize("NFC");
	const searchTooLong = Array.from(searchText).length > DICTIONARY_QUERY_LIMIT;
	const searchErrorId = useId();
	const updateSearchInput = (value: string) => {
		setSearchInput(value);
		if (!composingSearch.current && !value.trim()) setSearchTerm("");
	};

	const dictionaryStatusQuery = useQuery({
		queryKey: dictionaryKey,
		queryFn: ({ signal }) => getDictionary(signal),
		staleTime: 60_000,
		retry: false,
		enabled: isOpen,
	});
	const expectedDictionaryId = dictionaryIdentity(dictionaryStatusQuery.data);
	const hasDictionary = typeof expectedDictionaryId === "string";

	const initial = context.initialTranslation;
	const translationGroups = initial
		? [
				{
					identity_sha256: initial.identity_sha256,
					excerpt: context.selection,
				},
				...translations.filter(
					(item) => item.identity_sha256 !== initial.identity_sha256,
				),
			]
		: translations;
	const initialTab: ReferenceTab =
		context.origin !== "selection"
			? context.origin
			: hasDictionary
				? "dictionary"
				: translationGroups.length
					? "translation"
					: "segment";

	const [tab, setTab] = useState<ReferenceTab>(initialTab);
	const needsOnDemandLookup =
		!context.dictionarySeed &&
		Boolean(context.lookupInput?.text || context.selection.trim());
	const contextLookup = useQuery({
		queryKey: [
			"dictionary",
			"lookup",
			expectedDictionaryId,
			"anki-reference",
			context.key,
		],
		queryFn: ({ signal }) =>
			lookupDictionary(
				{
					...(context.lookupInput ?? { text: context.selection.trim() }),
					auto_expand: true,
					assisted_ranking: true,
					expected_dictionary_id: expectedDictionaryId,
				},
				signal,
			),
		enabled:
			isOpen && tab === "dictionary" && hasDictionary && needsOnDemandLookup,
		retry: false,
	});
	const searchLookup = useQuery({
		queryKey: [
			"dictionary",
			"lookup",
			expectedDictionaryId,
			"anki-search",
			searchTerm,
		],
		queryFn: ({ signal }) =>
			lookupDictionary(
				{
					text: searchTerm,
					auto_expand: false,
					assisted_ranking: true,
					expected_dictionary_id: expectedDictionaryId,
				},
				signal,
			),
		enabled:
			isOpen && tab === "dictionary" && hasDictionary && Boolean(searchTerm),
		retry: false,
	});
	const seed = searchTerm ? undefined : context.dictionarySeed;
	const activeLookup = searchTerm ? searchLookup : contextLookup;
	const dictionaryEntries = seed?.entries ?? activeLookup.data?.matches ?? [];
	const visibleDictionaryEntries = searchTerm
		? dictionaryEntries
		: dictionaryEntries.slice(0, 6);
	const canSearch = hasDictionary && Boolean(searchText) && !searchTooLong;

	const submitSearch = () => {
		if (!canSearch || composingSearch.current) return;
		if (searchText === searchTerm) {
			void searchLookup.refetch();
		} else {
			setSearchTerm(searchText);
		}
	};

	const [expandedSegmentId, setExpandedSegmentId] = useState<string | null>(
		context.initialSegmentId ??
			(segments.length === 1 ? (segments[0]?.segment_id ?? null) : null),
	);
	const [excerpt, setExcerpt] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onSelectionChange = () => {
			const sel = document.getSelection();
			if (!sel || sel.isCollapsed || !sel.rangeCount || !scrollRef.current) {
				setExcerpt("");
				return;
			}
			const range = sel.getRangeAt(0);
			if (!scrollRef.current.contains(range.commonAncestorContainer)) {
				setExcerpt("");
				return;
			}
			const text = sel.toString().trim();
			setExcerpt(text);
		};
		document.addEventListener("selectionchange", onSelectionChange);
		return () =>
			document.removeEventListener("selectionchange", onSelectionChange);
	}, []);

	const activeField =
		textFields.find((item) => item.id === activeFieldId) ?? textFields[0];
	const targetLabel = activeField?.label || "字段";

	const fillLabel = activeFieldHasValue
		? `追加到「${targetLabel}」`
		: `填入「${targetLabel}」`;

	const adoptText = (text: string, mode?: "replace" | "append") => {
		if (!activeField) return;
		const resolvedMode = mode ?? (activeFieldHasValue ? "append" : "replace");
		onApplyText(activeField.id, text, resolvedMode);
		setExcerpt("");
		document.getSelection()?.removeAllRanges();
	};

	return (
		<aside className="anki-ref-pane" aria-label="制卡参考资料">
			{compactMode && (
				<div
					style={{
						padding: "8px 12px 0",
						display: "flex",
						alignItems: "center",
					}}
				>
					<button
						type="button"
						className="anki-link-btn"
						onClick={onBackToDraft}
					>
						← 返回草稿
					</button>
				</div>
			)}

			<div className="anki-ref-tabs" role="tablist" aria-label="参考来源">
				<button
					type="button"
					role="tab"
					className="anki-ref-tab"
					aria-selected={tab === "dictionary"}
					onClick={() => setTab("dictionary")}
				>
					词典
					{dictionaryEntries.length > 0 && (
						<span>{dictionaryEntries.length}</span>
					)}
				</button>
				<button
					type="button"
					role="tab"
					className="anki-ref-tab"
					aria-selected={tab === "translation"}
					onClick={() => setTab("translation")}
				>
					翻译
					{translationGroups.length > 0 && (
						<span>{translationGroups.length}</span>
					)}
				</button>
				<button
					type="button"
					role="tab"
					className="anki-ref-tab"
					aria-selected={tab === "segment"}
					onClick={() => setTab("segment")}
				>
					学习片段
					{segments.length > 0 && <span>{segments.length}</span>}
				</button>
			</div>

			{tab === "dictionary" && (
				<>
					<search
						className="anki-ref-search"
						aria-label="离线词典"
						onKeyDown={(event) => {
							const submitByEnter =
								event.key === "Enter" &&
								event.target === searchInputRef.current;
							if (!submitByEnter && event.key !== "Escape") return;
							if (
								composingSearch.current ||
								event.nativeEvent.isComposing ||
								event.nativeEvent.keyCode === 229
							) {
								event.stopPropagation();
								return;
							}
							const restoreOriginal =
								searchTerm || (searchInput && searchInput !== initialSearch);
							if (event.key === "Escape" && !restoreOriginal) return;
							event.stopPropagation();
							event.preventDefault();
							if (submitByEnter) {
								submitSearch();
							} else {
								setSearchInput(initialSearch);
								setSearchTerm("");
								searchInputRef.current?.focus();
							}
						}}
					>
						<button
							type="button"
							aria-label="提交词典搜索"
							disabled={!canSearch}
							onClick={submitSearch}
						>
							<ReaderSearchIcon name="search" />
						</button>
						<input
							ref={searchInputRef}
							type="search"
							aria-label="搜索词典"
							aria-invalid={searchTooLong || undefined}
							aria-describedby={searchTooLong ? searchErrorId : undefined}
							placeholder="搜索词典"
							autoComplete="off"
							enterKeyHint="search"
							spellCheck={false}
							value={searchInput}
							onChange={(event) => updateSearchInput(event.currentTarget.value)}
							onCompositionStart={() => {
								composingSearch.current = true;
							}}
							onCompositionEnd={(event) => {
								composingSearch.current = false;
								updateSearchInput(event.currentTarget.value);
							}}
							onBlur={() => {
								composingSearch.current = false;
							}}
						/>
						{(searchInput || searchTerm) && (
							<button
								type="button"
								aria-label="清空词典搜索"
								onClick={() => {
									composingSearch.current = false;
									updateSearchInput("");
									searchInputRef.current?.focus();
								}}
							>
								×
							</button>
						)}
					</search>
					{searchTooLong && (
						<p
							id={searchErrorId}
							className="anki-ref-search-error"
							role="status"
						>
							搜索词最多 {DICTIONARY_QUERY_LIMIT} 字
						</p>
					)}
				</>
			)}

			<div className="anki-ref-scroll" ref={scrollRef}>
				{tab === "dictionary" &&
					(!seed && dictionaryStatusQuery.isPending ? (
						<div className="anki-ref-empty" role="status">
							正在加载离线词典…
						</div>
					) : !seed && !hasDictionary && dictionaryStatusQuery.isError ? (
						<div className="anki-ref-empty" role="status">
							加载离线词典失败{" "}
							<button
								type="button"
								className="anki-link-btn"
								onClick={() => void dictionaryStatusQuery.refetch()}
							>
								重试
							</button>
						</div>
					) : !seed && !hasDictionary ? (
						<div className="anki-ref-empty">
							尚未导入离线词典，可在「设置 → 词典」导入。
						</div>
					) : !seed &&
						(searchTerm || needsOnDemandLookup) &&
						activeLookup.isPending ? (
						<div className="anki-ref-empty" role="status">
							正在查阅词典…
						</div>
					) : !seed && activeLookup.isError ? (
						<div className="anki-ref-empty" role="status">
							词典查询失败。{" "}
							<button
								type="button"
								className="anki-link-btn"
								onClick={() => void activeLookup.refetch()}
							>
								重试
							</button>
						</div>
					) : dictionaryEntries.length === 0 ? (
						<div className="anki-ref-empty" role="status">
							{searchTerm || context.selection
								? `当前词典未查到「${searchTerm || context.selection}」的词条。`
								: "输入词语后搜索。"}
						</div>
					) : (
						visibleDictionaryEntries.map((entry) => (
							<article className="anki-ref-card" key={entry.id}>
								<div className="anki-ref-card-head">
									<div>
										<span className="anki-ref-term" lang="ja">
											{entry.term}
										</span>
										{entry.reading && entry.reading !== entry.term && (
											<span
												className="anki-ref-reading"
												lang="ja"
												style={{ marginLeft: 7 }}
											>
												{entry.reading}
											</span>
										)}
									</div>
									<div className="anki-ref-chips">
										{termFieldLabel && (
											<FillButton
												label={`将词条填入「${termFieldLabel}」`}
												fieldName="词条"
												onClick={() => onApplyTerm(entry)}
											/>
										)}
										{readingFieldLabel && entry.reading && (
											<FillButton
												label={`将读音填入「${readingFieldLabel}」`}
												fieldName="读音"
												onClick={() => onApplyReading(entry.reading)}
											/>
										)}
									</div>
								</div>

								<DictionaryReferenceBody
									entry={entry}
									fillLabel={fillLabel}
									onAdopt={adoptText}
								/>
							</article>
						))
					))}

				{tab === "translation" &&
					(translationGroups.length === 0 ? (
						<div className="anki-ref-empty">
							{recordsStatus === "error"
								? "加载本章记录失败。"
								: recordsStatus === "loading"
									? "正在加载本章记录…"
									: "与当前选区重叠的原文暂无译文记录。"}
						</div>
					) : (
						translationGroups.map((item) => (
							<TranslationGroupCard
								key={item.identity_sha256}
								materialId={materialId}
								translation={item}
								initial={
									item.identity_sha256 === initial?.identity_sha256
										? initial
										: undefined
								}
								fillLabel={fillLabel}
								onAdopt={(text) => adoptText(text)}
							/>
						))
					))}

				{tab === "segment" &&
					(segments.length === 0 ? (
						<div className="anki-ref-empty">
							{recordsStatus === "error"
								? "加载本章记录失败。"
								: recordsStatus === "loading"
									? "正在加载本章记录…"
									: "与当前选区重叠的原文暂无学习片段。"}
						</div>
					) : (
						segments.map((item) => (
							<SegmentDetailCard
								key={item.segment_id}
								segment={item}
								expanded={expandedSegmentId === item.segment_id}
								onToggle={() =>
									setExpandedSegmentId((prev) =>
										prev === item.segment_id ? null : item.segment_id,
									)
								}
								fillLabel={fillLabel}
								onAdopt={(text) => adoptText(text)}
							/>
						))
					))}
			</div>

			{textFields.length > 0 && (
				<div className="anki-ref-quote-bar">
					<div className="anki-ref-target-row">
						<span>填入目标</span>
						<NativeSelect
							className="anki-reader-select"
							style={{ width: "auto", minWidth: 120 }}
							aria-label="选择引用填入的目标字段"
							value={activeField?.id ?? ""}
							onChange={(event) => onActiveFieldChange(event.target.value)}
						>
							{textFields.map((field) => (
								<option key={field.id} value={field.id}>
									{field.label}
								</option>
							))}
						</NativeSelect>
					</div>

					{excerpt ? (
						<>
							<div className="anki-ref-excerpt">{excerpt}</div>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									justifyContent: "flex-end",
									gap: 6,
								}}
							>
								{activeFieldHasValue ? (
									<>
										<button
											type="button"
											className="anki-btn-secondary"
											style={{ padding: "4px 9px", fontSize: 12 }}
											onClick={() => adoptText(excerpt, "replace")}
										>
											替换「{targetLabel}」
										</button>
										<button
											type="button"
											className="anki-btn-primary"
											style={{ padding: "4px 10px", fontSize: 12 }}
											onClick={() => adoptText(excerpt, "append")}
										>
											追加到「{targetLabel}」
										</button>
									</>
								) : (
									<button
										type="button"
										className="anki-btn-primary"
										style={{ padding: "4px 10px", fontSize: 12 }}
										onClick={() => adoptText(excerpt, "replace")}
									>
										填入「{targetLabel}」
									</button>
								)}
							</div>
						</>
					) : (
						<span className="anki-ref-meta">
							点击填入按钮插入整条内容，或划选任意文字摘录。
						</span>
					)}
				</div>
			)}
		</aside>
	);
}
