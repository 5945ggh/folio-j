import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { Source } from "../content";
import { NativeSelect } from "../NativeSelect";
import { InlineError } from "../Shared";
import {
	catalogKeys,
	catalogSources,
	prefetchSourceOverview,
	type SourceQuery,
} from "./api";
import { Pagination } from "./Controls";
import { useCatalogScroll, useCatalogState } from "./hooks";
import { Icon, Tool } from "./LibraryTools";
import { SearchInput } from "./SearchInput";
import {
	isDefaultCatalogSort,
	lastCatalogPage,
	nextSourceNavigationIndex,
	sortDirectionArrow,
	sortFieldLabel,
	sourceOverviewDestination,
} from "./state";

let pendingFocusSourceId: string | null = null;

export function SourceDirectory({
	onCreate,
	onSelect,
	onEdit,
}: {
	onCreate: () => void;
	onSelect?: () => void;
	onEdit?: (source: Source) => void;
}) {
	const client = useQueryClient();
	const location = useLocation();
	const navigate = useNavigate();
	const { state, change } = useCatalogState("sources", "sources", "s");
	const [searching, setSearching] = useState(Boolean(state.q));
	const search = useRef<HTMLInputElement>(null);
	const searchButton = useRef<HTMLButtonElement>(null);
	const listNav = useRef<HTMLElement>(null);
	const prefetchTimer = useRef<number | null>(null);
	const placeSearchCaretAtEnd = useRef(false);
	const searchId = useId();
	const query: SourceQuery = {
		q: state.q,
		sort: state.sort as SourceQuery["sort"],
		order: state.order,
		page: state.page,
		page_size: 50,
	};
	const sources = useQuery({
		queryKey: catalogKeys.sources(query),
		queryFn: () => catalogSources(query),
	});
	const scroll = useCatalogScroll(sources.isSuccess, "source-directory", true);
	const last = sources.data
		? lastCatalogPage(sources.data.total, sources.data.page_size)
		: null;
	useEffect(() => {
		if (last !== null && state.page > last) change({ page: last });
	}, [last, state.page, change]);
	useEffect(() => {
		if (!searching) return;
		const input = search.current;
		if (!input) return;
		input.focus();
		if (placeSearchCaretAtEnd.current) {
			placeSearchCaretAtEnd.current = false;
			const end = input.value.length;
			input.setSelectionRange(end, end);
		}
	}, [searching]);
	useEffect(
		() => () => {
			if (prefetchTimer.current !== null) {
				window.clearTimeout(prefetchTimer.current);
				prefetchTimer.current = null;
			}
		},
		[],
	);
	useEffect(() => {
		if (!pendingFocusSourceId) return;
		const targetId = pendingFocusSourceId;
		if (location.pathname !== `/sources/${targetId}`) {
			pendingFocusSourceId = null;
			return;
		}
		if (!sources.isSuccess) return;
		pendingFocusSourceId = null;
		const row = listNav.current?.querySelector<HTMLAnchorElement>(
			`a.s2-source-row[data-source-id="${CSS.escape(targetId)}"]`,
		);
		if (row) {
			row.focus();
			row.scrollIntoView({ block: "nearest" });
		}
	}, [location.pathname, sources.isSuccess]);

	function cancelPrefetch() {
		if (prefetchTimer.current !== null) {
			window.clearTimeout(prefetchTimer.current);
			prefetchTimer.current = null;
		}
	}

	function schedulePrefetch(source: Source) {
		cancelPrefetch();
		prefetchTimer.current = window.setTimeout(() => {
			prefetchTimer.current = null;
			prefetchSourceOverview(client, source);
		}, 80);
	}

	const sortButtonTitle = `来源排序 · ${sortFieldLabel("sources", state.sort)} ${sortDirectionArrow(state.order)}`;
	const sortModified = !isDefaultCatalogSort(
		"sources",
		state.sort,
		state.order,
	);
	return (
		<section className="s2-directory" aria-label="来源列表">
			<header className="s2-directory-heading">
				<h2>来源</h2>
				<div className="s2-tools">
					<button
						ref={searchButton}
						className="library-icon"
						type="button"
						title="搜索来源"
						aria-label="搜索来源"
						aria-expanded={searching}
						aria-controls={searchId}
						onClick={() => setSearching(!searching)}
					>
						<Icon name="search" />
					</button>
					<Tool
						name="sort"
						label="来源排序"
						buttonTitle={sortButtonTitle}
						active={sortModified}
					>
						<label>
							排序依据
							<NativeSelect
								value={state.sort}
								onChange={(e) =>
									change({ sort: e.target.value as typeof state.sort })
								}
							>
								<option value="title">
									{sortFieldLabel("sources", "title")}
								</option>
								<option value="created_at">
									{sortFieldLabel("sources", "created_at")}
								</option>
								<option value="updated_at">
									{sortFieldLabel("sources", "updated_at")}
								</option>
							</NativeSelect>
						</label>
						<div className="library-sort-direction-field">
							<span>排序方向</span>
							<fieldset className="library-sort-direction">
								{(["asc", "desc"] as const).map((order) => (
									<button
										key={order}
										type="button"
										aria-pressed={state.order === order}
										onClick={() => change({ order })}
									>
										{order === "asc" ? "升序" : "降序"}
									</button>
								))}
							</fieldset>
						</div>
					</Tool>
					<button
						className="library-icon"
						type="button"
						title="新建来源"
						aria-label="新建来源"
						onClick={(e) => {
							e.currentTarget.focus();
							onCreate();
						}}
					>
						<Icon name="plus" />
					</button>
				</div>
			</header>
			{searching && (
				<div className="s2-source-search enter-motion">
					<SearchInput
						ref={search}
						id={searchId}
						aria-label="搜索来源名称或描述"
						placeholder="搜索来源…"
						value={state.q}
						onValueChange={(q) => change({ q })}
						onKeyDown={(event) => {
							if (event.key !== "Escape" || event.nativeEvent.isComposing) {
								return;
							}
							event.preventDefault();
							event.stopPropagation();
							setSearching(false);
							searchButton.current?.focus();
						}}
					/>
				</div>
			)}
			{state.q && !searching && (
				<div className="s2-search-chip">
					<button
						type="button"
						className="s2-search-chip-edit"
						aria-label={`编辑来源搜索：${state.q}`}
						title={`编辑来源搜索：${state.q}`}
						onClick={() => {
							placeSearchCaretAtEnd.current = true;
							setSearching(true);
						}}
					>
						来源搜索：{state.q}
					</button>
					<button
						type="button"
						className="s2-search-chip-clear"
						aria-label={`清空搜索词：${state.q}`}
						title="清空搜索词"
						onClick={() => {
							change({ q: "" });
							searchButton.current?.focus();
						}}
					>
						<span aria-hidden="true">×</span>
					</button>
				</div>
			)}
			<div ref={scroll} className="s2-source-scroll">
				{sources.isPending ? (
					<p role="status">正在加载来源…</p>
				) : sources.isError ? (
					<>
						<InlineError error={sources.error} />
						<button
							className="button secondary"
							type="button"
							onClick={() => void sources.refetch()}
						>
							重新加载
						</button>
					</>
				) : sources.data.items.length === 0 ? (
					state.q ? (
						<p className="s2-directory-empty">没有匹配的来源</p>
					) : (
						<div className="s2-directory-empty">
							<p>还没有来源</p>
							<button
								className="button secondary"
								type="button"
								onClick={(event) => {
									event.currentTarget.focus();
									onCreate();
								}}
							>
								新建来源
							</button>
						</div>
					)
				) : (
					<nav
						ref={listNav}
						aria-label="选择来源"
						onKeyDown={(event) => {
							if (
								event.altKey ||
								event.ctrlKey ||
								event.metaKey ||
								event.shiftKey
							)
								return;
							const target = (event.target as Element).closest(
								"a.s2-source-row",
							);
							if (!target) return;
							const links = Array.from(
								event.currentTarget.querySelectorAll<HTMLAnchorElement>(
									"a.s2-source-row",
								),
							);
							const current = links.indexOf(target as HTMLAnchorElement);
							const nextIndex = nextSourceNavigationIndex(
								links.length,
								current,
								event.key,
							);
							if (nextIndex === null) return;
							event.preventDefault();
							if (nextIndex === current) return;
							const nextLink = links[nextIndex];
							const nextSource = sources.data.items[nextIndex];
							if (!nextLink || !nextSource) return;
							if (!onSelect) {
								prefetchSourceOverview(client, nextSource);
								pendingFocusSourceId = nextSource.id;
								navigate(
									sourceOverviewDestination(nextSource.id, location.search),
								);
								nextLink.focus();
								nextLink.scrollIntoView({ block: "nearest" });
							} else {
								nextLink.focus();
								nextLink.scrollIntoView({ block: "nearest" });
							}
						}}
					>
						{sources.data.items.map((source) => {
							const isCurrent = location.pathname === `/sources/${source.id}`;
							return (
								<div className="s2-source-item" key={source.id}>
									<Link
										className={`s2-source-row ${isCurrent ? "selected" : ""}`}
										aria-current={isCurrent ? "page" : undefined}
										data-source-id={source.id}
										title={source.title}
										to={sourceOverviewDestination(source.id, location.search)}
										onMouseEnter={() => {
											if (!isCurrent) schedulePrefetch(source);
										}}
										onMouseLeave={cancelPrefetch}
										onFocus={() => {
											if (!isCurrent) prefetchSourceOverview(client, source);
										}}
										onPointerDown={() => {
											cancelPrefetch();
											if (!isCurrent) prefetchSourceOverview(client, source);
										}}
										onClick={() => {
											cancelPrefetch();
											onSelect?.();
										}}
									>
										<strong>{source.title}</strong>
										<span>
											{source.material_count} 本书 · {source.segment_count}{" "}
											个片段 · {source.analysis_count} 份讲解
										</span>
									</Link>
									{onEdit && (
										<button
											type="button"
											className="library-icon s2-source-row-edit"
											aria-label={`编辑来源「${source.title}」`}
											title="编辑来源"
											onClick={(event) => {
												event.stopPropagation();
												onEdit(source);
											}}
										>
											<Icon name="edit" />
										</button>
									)}
								</div>
							);
						})}
					</nav>
				)}
			</div>
			{sources.data && (
				<Pagination
					page={state.page}
					total={sources.data.total}
					pageSize={sources.data.page_size}
					onChange={(page) => change({ page })}
				/>
			)}
		</section>
	);
}
