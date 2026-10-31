import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { NativeSelect } from "../NativeSelect";
import { InlineError } from "../Shared";
import { catalogKeys, catalogSources, type SourceQuery } from "./api";
import { Pagination } from "./Controls";
import { useCatalogScroll, useCatalogState } from "./hooks";
import { Icon, Tool } from "./LibraryTools";
import { SearchInput } from "./SearchInput";
import { lastCatalogPage, sourceOverviewDestination } from "./state";

export function SourceDirectory({
	onCreate,
	onSelect,
}: {
	onCreate: () => void;
	onSelect?: () => void;
}) {
	const location = useLocation();
	const { state, change } = useCatalogState("sources", "sources", "s");
	const [searching, setSearching] = useState(Boolean(state.q));
	const search = useRef<HTMLInputElement>(null);
	const searchButton = useRef<HTMLButtonElement>(null);
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
		if (searching) search.current?.focus();
	}, [searching]);
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
					<Tool name="sort" label="来源排序">
						<label>
							排序依据
							<NativeSelect
								value={state.sort}
								onChange={(e) =>
									change({ sort: e.target.value as typeof state.sort })
								}
							>
								<option value="title">名称</option>
								<option value="created_at">创建时间</option>
								<option value="updated_at">更新时间</option>
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
				<button
					className="s2-search-chip"
					type="button"
					aria-label={`清除来源搜索：${state.q}`}
					onClick={() => change({ q: "" })}
				>
					来源搜索：{state.q} ×
				</button>
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
							重试来源列表
						</button>
					</>
				) : sources.data.items.length === 0 ? (
					<p className="s2-directory-empty">
						{state.q ? "没有匹配的来源。" : "还没有来源，可在上方新建。"}
					</p>
				) : (
					<nav aria-label="选择来源">
						{sources.data.items.map((source) => (
							<Link
								className={`s2-source-row ${location.pathname === `/sources/${source.id}` ? "selected" : ""}`}
								aria-current={
									location.pathname === `/sources/${source.id}`
										? "page"
										: undefined
								}
								key={source.id}
								title={source.title}
								to={sourceOverviewDestination(source.id, location.search)}
								onClick={onSelect}
							>
								<strong>{source.title}</strong>
								<span>
									{source.material_count} 本书 · {source.segment_count} 个片段 ·{" "}
									{source.analysis_count} 篇讲解
								</span>
							</Link>
						))}
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
