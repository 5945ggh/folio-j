import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { statusLabels, Tabs } from "./Controls";
import { SearchInput } from "./SearchInput";
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
export function Tool({
	label,
	name,
	children,
}: {
	label: string;
	name: "search" | "filter" | "sort" | "size";
	children: ReactNode;
}) {
	const id = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const keyboardOpen = useRef(false);
	const [open, setOpen] = useState(false);
	return (
		<span className="library-tool">
			<button
				type="button"
				ref={trigger}
				className="library-icon"
				aria-label={label}
				title={label}
				aria-expanded={open}
				aria-controls={id}
				popoverTarget={id}
				onPointerDown={() => {
					keyboardOpen.current = false;
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ")
						keyboardOpen.current = true;
				}}
			>
				<Icon name={name} />
			</button>
			<div
				id={id}
				popover="auto"
				className="library-popover library-panel popover-motion"
				role="dialog"
				aria-label={label}
				onToggle={(event) => {
					const opening = event.newState === "open";
					setOpen(opening);
					if (!opening) return;
					const box = trigger.current?.getBoundingClientRect();
					if (!box) return;
					const panel = event.currentTarget;
					panel.style.top = `${Math.max(12, Math.min(box.bottom + 8, window.innerHeight - panel.offsetHeight - 12))}px`;
					panel.style.right = `${Math.max(12, Math.min(window.innerWidth - box.right, window.innerWidth - panel.offsetWidth - 12))}px`;
					if (keyboardOpen.current)
						panel.querySelector<HTMLElement>("select, input")?.focus();
					keyboardOpen.current = false;
				}}
			>
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
					items={[
						{ value: "book", label: "书籍" },
						{ value: "comic", label: "漫画", disabled: true },
						{ value: "audiobook", label: "有声书", disabled: true },
						{ value: "video", label: "视频", disabled: true },
					]}
					value="book"
					onChange={() => {}}
				/>
				<div className="library-tools">
					{searching && (
						<SearchInput
							id="library-search"
							ref={search}
							className="library-search-input enter-motion"
							aria-label="搜索书名或来源"
							placeholder="搜索书名或来源…"
							value={state.q}
							onValueChange={(q) => change({ q })}
							onKeyDown={(event) => {
								if (event.key === "Escape" && !event.nativeEvent.isComposing) {
									setSearching(false);
									searchButton.current?.focus();
								}
							}}
						/>
					)}
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
						<Tool name="size" label="卡片大小">
							<label className="library-size-field">
								<span className="library-size-row">
									宽度
									<span className="library-size-value">{size}px</span>
								</span>
								<input
									type="range"
									min="140"
									max="280"
									value={size}
									aria-label="卡片宽度"
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
