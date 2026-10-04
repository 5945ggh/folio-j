import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { statusLabels, Tabs } from "./Controls";
import type { CatalogState } from "./state";
export function Icon({
	name,
}: {
	name: "search" | "filter" | "sort" | "size" | "plus" | "more" | "book";
}) {
	const paths = {
		search: "M21 21l-5-5M19 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
		filter: "M3 6h18M3 12h18M3 18h18M7 3v6M17 9v6M9 15v6",
		sort: "M7 21V3m-4 4 4-4 4 4M17 3v18m-4-4 4 4 4-4",
		size: "M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6M8 8h8v8H8z",
		plus: "M12 4v16M4 12h16",
		more: "M5 12h.01M12 12h.01M19 12h.01",
		book: "M12 5v16M12 5C8 2 4 3 2 4v16c4-2 7-1 10 1 3-2 6-3 10-1V4c-2-1-6-2-10 1",
	};
	return (
		<svg
			viewBox="0 0 24 24"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth={name === "more" ? 3 : 1.6}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d={paths[name]} />
		</svg>
	);
}
function Tool({
	label,
	name,
	children,
}: {
	label: string;
	name: "search" | "filter" | "sort" | "size";
	children: ReactNode;
}) {
	const id = useId();
	return (
		<span className="library-tool">
			<button
				type="button"
				className="library-icon"
				aria-label={label}
				title={label}
				popoverTarget={id}
			>
				<Icon name={name} />
			</button>
			<div id={id} popover="auto" className="library-popover">
				<strong>{label}</strong>
				{children}
			</div>
		</span>
	);
}
export function LibraryTools({
	state,
	change,
	sources,
	size,
	setSize,
	empty,
	add,
}: {
	state: CatalogState;
	change: (patch: Partial<CatalogState>) => void;
	sources?: readonly { id: string; title: string }[];
	size: number;
	setSize: (value: number) => void;
	empty: boolean;
	add: () => void;
}) {
	const [searching, setSearching] = useState(false);
	const search = useRef<HTMLInputElement>(null);
	const searchButton = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (searching) search.current?.focus();
	}, [searching]);
	return (
		<>
			<header className="library-toolbar">
				<Tabs
					id="material-type"
					label="素材类型"
					items={[{ value: "book", label: "书籍" }]}
					value="book"
					onChange={() => {}}
				/>
				<div className="library-tools">
					<div className="library-tool-group">
						<button
							className="library-icon"
							type="button"
							aria-label="搜索书名或来源"
							title="搜索书名或来源"
							aria-expanded={searching}
							aria-controls="library-search"
							ref={searchButton}
							onClick={() => setSearching(!searching)}
						>
							<Icon name="search" />
						</button>
						<Tool name="filter" label="筛选书籍">
							<label>
								所属来源
								<select
									value={state.source_id}
									onChange={(e) => change({ source_id: e.target.value })}
								>
									<option value="">全部来源</option>
									{sources?.map((s) => (
										<option key={s.id} value={s.id}>
											{s.title}
										</option>
									))}
								</select>
							</label>
							<label>
								阅读状态
								<select
									value={state.status}
									onChange={(e) =>
										change({ status: e.target.value as CatalogState["status"] })
									}
								>
									<option value="">全部状态</option>
									{Object.entries(statusLabels).map(([v, l]) => (
										<option key={v} value={v}>
											{l}
										</option>
									))}
								</select>
							</label>
						</Tool>
						<Tool name="sort" label="排序">
							<label>
								排序依据
								<select
									value={state.sort}
									onChange={(e) =>
										change({ sort: e.target.value as CatalogState["sort"] })
									}
								>
									<option value="title">标题</option>
									<option value="created_at">添加时间</option>

									<option value="last_opened_at">最近打开</option>
								</select>
							</label>
							<label>
								排序方向
								<select
									value={state.order}
									onChange={(e) =>
										change({ order: e.target.value as CatalogState["order"] })
									}
								>
									<option value="asc">升序</option>
									<option value="desc">降序</option>
								</select>
							</label>
						</Tool>
						<Tool name="size" label="卡片大小">
							<label>
								宽度 {size}px
								<input
									type="range"
									min="140"
									max="280"
									value={size}
									onChange={(e) => setSize(Number(e.target.value))}
								/>
							</label>
						</Tool>
					</div>
					{!empty && (
						<>
							<span className="library-divider" />
							<button
								id="library-add"
								type="button"
								className="library-icon"
								title="添加书籍"
								aria-label="添加书籍"
								onClick={(e) => {
									e.currentTarget.focus();
									add();
								}}
							>
								<Icon name="plus" />
							</button>
						</>
					)}
				</div>
			</header>
			{searching && (
				<div className="library-search-row">
					<label>
						搜索书名或来源
						<input
							id="library-search"
							type="search"
							ref={search}
							value={state.q}
							onChange={(e) => change({ q: e.target.value })}
							placeholder="搜索书名或来源…"
						/>
					</label>
					<button
						type="button"
						className="library-clear"
						onClick={() => {
							setSearching(false);
							searchButton.current?.focus();
						}}
					>
						收起
					</button>
				</div>
			)}
			{(state.q || state.status || state.source_id) && (
				<div className="library-chips">
					{state.q && (
						<button type="button" onClick={() => change({ q: "" })}>
							搜索：{state.q} ×
						</button>
					)}
					{state.source_id && (
						<button type="button" onClick={() => change({ source_id: "" })}>
							来源：
							{sources?.find((s) => s.id === state.source_id)?.title ??
								"所选来源"}{" "}
							×
						</button>
					)}
					{state.status && (
						<button type="button" onClick={() => change({ status: "" })}>
							{statusLabels[state.status]} ×
						</button>
					)}
					<button
						type="button"
						className="library-clear"
						onClick={() => change({ q: "", status: "", source_id: "" })}
					>
						清空条件
					</button>
				</div>
			)}
		</>
	);
}
