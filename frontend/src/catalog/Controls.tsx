import type { KeyboardEvent } from "react";
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
}: {
	id: string;
	label: string;
	items: readonly { value: string; label: string }[];
	value: string;
	onChange: (value: string) => void;
}) {
	function keydown(event: KeyboardEvent<HTMLDivElement>) {
		const current = items.findIndex((item) => item.value === value);
		let next = current;
		if (event.key === "ArrowRight") next = (current + 1) % items.length;
		else if (event.key === "ArrowLeft")
			next = (current + items.length - 1) % items.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = items.length - 1;
		else return;
		event.preventDefault();
		const item = items[next];
		if (!item) return;
		onChange(item.value);
		event.currentTarget
			.querySelectorAll<HTMLButtonElement>("[role=tab]")
			[next]?.focus();
	}
	return (
		<div
			className="catalog-tabs"
			role="tablist"
			aria-label={label}
			onKeyDown={keydown}
		>
			{items.map((item) => (
				<button
					key={item.value}
					id={`${id}-tab-${item.value}`}
					role="tab"
					aria-selected={value === item.value}
					aria-controls={`${id}-panel-${item.value}`}
					tabIndex={value === item.value ? 0 : -1}
					type="button"
					onClick={() => onChange(item.value)}
				>
					{item.label}
				</button>
			))}
		</div>
	);
}
export function CatalogToolbar({
	state,
	change,
	kind,
	sources,
}: {
	state: CatalogState;
	change: (patch: Partial<CatalogState>) => void;
	kind: CatalogKind;
	sources?: readonly { id: string; title: string }[];
}) {
	return (
		<div className="catalog-toolbar">
			<label className="catalog-search">
				<span className="sr-only">
					{kind === "books" ? "搜索书名或 Source" : "搜索当前列表"}
				</span>
				<input
					type="search"
					placeholder={kind === "books" ? "搜索书名或 Source…" : "搜索…"}
					value={state.q}
					onChange={(e) => change({ q: e.target.value })}
				/>
			</label>
			{sources && (
				<label>
					<span className="sr-only">Source 筛选</span>
					<select
						value={state.source_id}
						onChange={(e) => change({ source_id: e.target.value })}
					>
						<option value="">全部 Source</option>
						{sources.map((source) => (
							<option key={source.id} value={source.id}>
								{source.title}
							</option>
						))}
					</select>
				</label>
			)}
			{kind === "books" && (
				<label>
					<span className="sr-only">阅读状态筛选</span>
					<select
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
					</select>
				</label>
			)}
			<label>
				<span className="sr-only">排序字段</span>
				<select
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
				</select>
			</label>
			<label>
				<span className="sr-only">排序方向</span>
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
			{(state.q || state.status || state.source_id) && (
				<button
					className="button secondary"
					type="button"
					onClick={() => change({ q: "", status: "", source_id: "" })}
				>
					清空筛选
				</button>
			)}
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
