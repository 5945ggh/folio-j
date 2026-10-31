import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { NativeSelect } from "../NativeSelect";
import { SearchInput } from "./SearchInput";
import { type CatalogKind, type CatalogState, sortFields } from "./state";

const sortLabels = {
	title: "标题",
	created_at: "添加时间",
	updated_at: "更新时间",
	last_opened_at: "最近打开",
};
export const statusLabels = {
	not_started: "未开始",
	in_progress: "进行中",
	completed: "已完成",
};
export function Tabs({
	id,
	label,
	items,
	value,
	onChange,
	className = "",
}: {
	id: string;
	label: string;
	items: readonly { value: string; label: string; disabled?: boolean }[];
	value: string;
	onChange: (value: string) => void;
	className?: string;
}) {
	function keydown(event: KeyboardEvent<HTMLDivElement>) {
		const enabled = items.filter((item) => !item.disabled);
		if (enabled.length === 0) return;
		const current = enabled.findIndex((item) => item.value === value);
		let next = current;
		if (event.key === "ArrowRight") next = (current + 1) % enabled.length;
		else if (event.key === "ArrowLeft")
			next = (current + enabled.length - 1) % enabled.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = enabled.length - 1;
		else return;
		event.preventDefault();
		const item = enabled[next];
		if (!item) return;
		onChange(item.value);
		event.currentTarget
			.querySelectorAll<HTMLButtonElement>("[role=tab]:not(:disabled)")
			[next]?.focus();
	}
	return (
		<div
			className={`catalog-tabs ${className}`}
			role="tablist"
			aria-label={label}
			onKeyDown={keydown}
		>
			{items.map((item) => {
				const hintId = `${id}-tab-${item.value}-hint`;
				const button = (
					<button
						key={item.value}
						id={`${id}-tab-${item.value}`}
						role="tab"
						aria-selected={value === item.value}
						aria-controls={
							item.disabled ? undefined : `${id}-panel-${item.value}`
						}
						aria-describedby={item.disabled ? hintId : undefined}
						tabIndex={value === item.value ? 0 : -1}
						type="button"
						disabled={item.disabled}
						onClick={() => onChange(item.value)}
					>
						{item.label}
					</button>
				);
				if (!item.disabled) return button;
				return (
					<span className="catalog-tab-unavailable" key={item.value}>
						{button}
						<span id={hintId} className="catalog-tab-hint" role="tooltip">
							{item.label}支持会有的！
						</span>
					</span>
				);
			})}
		</div>
	);
}
export function CatalogToolbar({
	state,
	change,
	kind,
	sources,
	children,
}: {
	state: CatalogState;
	change: (patch: Partial<CatalogState>) => void;
	kind: CatalogKind;
	sources?: readonly { id: string; title: string }[];
	children?: ReactNode;
}) {
	const sourceList = kind === "segments" || kind === "analyses";
	const listLabel = kind === "segments" ? "片段" : "讲解";
	const searchLabel = sourceList
		? `搜索${listLabel}`
		: kind === "books"
			? "搜索书名或 Source"
			: "搜索当前列表";
	const searchId = useId();
	const sortId = useId();
	const sortTrigger = useRef<HTMLButtonElement>(null);
	const keyboardSort = useRef(false);
	const sorting = (
		<>
			<label className={sourceList ? "source-sort-field" : undefined}>
				<span className={sourceList ? undefined : "sr-only"}>
					{sourceList ? "排序依据" : "排序字段"}
				</span>
				<NativeSelect
					value={state.sort}
					onChange={(e) =>
						change({ sort: e.target.value as CatalogState["sort"] })
					}
				>
					{sortFields[kind].map((field) => (
						<option key={field} value={field}>
							{kind !== "books" && field === "created_at"
								? "创建时间"
								: sortLabels[field]}
						</option>
					))}
				</NativeSelect>
			</label>
			{sourceList ? (
				<div className="source-sort-direction-field">
					<span>排序方向</span>
					<fieldset className="source-sort-direction" aria-label="排序方向">
						{(["desc", "asc"] as const).map((order) => (
							<button
								key={order}
								type="button"
								aria-pressed={state.order === order}
								onClick={() => change({ order })}
							>
								{order === "desc" ? "降序" : "升序"}
							</button>
						))}
					</fieldset>
				</div>
			) : (
				<label>
					<span className="sr-only">排序方向</span>
					<NativeSelect
						value={state.order}
						onChange={(e) =>
							change({ order: e.target.value as CatalogState["order"] })
						}
					>
						<option value="asc">升序</option>
						<option value="desc">降序</option>
					</NativeSelect>
				</label>
			)}
		</>
	);
	return (
		<div
			className={`catalog-toolbar${sourceList ? " source-list-toolbar" : ""}`}
		>
			<label className="catalog-search" htmlFor={searchId}>
				<span className="sr-only">{searchLabel}</span>
				{sourceList && (
					<svg
						className="source-list-search-icon"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="M21 21l-5-5M19 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0" />
					</svg>
				)}
				<SearchInput
					id={searchId}
					placeholder={
						sourceList || kind === "books" ? `${searchLabel}…` : "搜索…"
					}
					value={state.q}
					onValueChange={(q) => change({ q })}
				/>
			</label>
			{sources && (
				<label>
					<span className="sr-only">Source 筛选</span>
					<NativeSelect
						value={state.source_id}
						onChange={(e) => change({ source_id: e.target.value })}
					>
						<option value="">全部 Source</option>
						{sources.map((source) => (
							<option key={source.id} value={source.id}>
								{source.title}
							</option>
						))}
					</NativeSelect>
				</label>
			)}
			{kind === "books" && (
				<label>
					<span className="sr-only">阅读状态筛选</span>
					<NativeSelect
						value={state.status}
						onChange={(e) =>
							change({ status: e.target.value as CatalogState["status"] })
						}
					>
						<option value="">全部状态</option>
						{Object.entries(statusLabels).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</NativeSelect>
				</label>
			)}
			{sourceList ? (
				<div className="source-list-sort-control">
					<button
						ref={sortTrigger}
						type="button"
						className="source-list-sort-trigger"
						aria-label={`${listLabel}排序`}
						popoverTarget={sortId}
						onPointerDown={() => {
							keyboardSort.current = false;
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ")
								keyboardSort.current = true;
						}}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="M7 21V3m-4 4 4-4 4 4M17 3v18m-4-4 4 4 4-4" />
						</svg>
						排序
					</button>
					<div
						id={sortId}
						popover="auto"
						className="library-popover source-list-sort popover-motion"
						role="dialog"
						aria-label={`${listLabel}排序`}
						onToggle={(event) => {
							if (event.newState !== "open") return;
							const box = sortTrigger.current?.getBoundingClientRect();
							if (!box) return;
							const panel = event.currentTarget;
							panel.style.top = `${Math.max(12, Math.min(box.bottom + 8, window.innerHeight - panel.offsetHeight - 12))}px`;
							panel.style.right = `${Math.max(12, Math.min(window.innerWidth - box.right, window.innerWidth - panel.offsetWidth - 12))}px`;
							if (keyboardSort.current) panel.querySelector("select")?.focus();
							keyboardSort.current = false;
						}}
					>
						<strong>{listLabel}排序</strong>
						{sorting}
					</div>
				</div>
			) : (
				sorting
			)}
			{!sourceList && (state.q || state.status || state.source_id) && (
				<button
					className="button secondary"
					type="button"
					onClick={() => change({ q: "", status: "", source_id: "" })}
				>
					清空筛选
				</button>
			)}
			{sourceList && <div className="source-list-action">{children}</div>}
		</div>
	);
}
export function Pagination({
	page,
	total,
	pageSize = 50,
	onChange,
}: {
	page: number;
	total: number;
	pageSize?: number;
	onChange: (page: number) => void;
}) {
	const pages = Math.max(1, Math.ceil(total / pageSize));
	if (pages === 1) return <p className="catalog-count">共 {total} 项</p>;
	return (
		<nav className="catalog-pagination" aria-label="分页">
			<span className="pagination-count">
				共 {total} 项 · 第 {page} / {pages} 页
			</span>
			<button
				className="button secondary"
				type="button"
				disabled={page <= 1}
				onClick={() => onChange(page - 1)}
			>
				上一页
			</button>
			<button
				className="button secondary"
				type="button"
				disabled={page >= pages}
				onClick={() => onChange(page + 1)}
			>
				下一页
			</button>
		</nav>
	);
}
