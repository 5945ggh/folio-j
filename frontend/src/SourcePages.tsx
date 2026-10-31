import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api } from "./api/client";
import { catalogKeys, catalogSources, type SourceQuery } from "./catalog/api";
import { readPreference, savePreference } from "./catalog/hooks";
import { forgetSourceImports } from "./catalog/import-state";
import { Icon } from "./catalog/LibraryTools";
import { SourceDirectory } from "./catalog/SourceDirectory";
import { SourceSpace } from "./catalog/SourceSpace";
import { SourceContent } from "./catalog/SourceViews";
import {
	readCatalogState,
	sourceEntrySearch,
	sourceOverviewDestination,
} from "./catalog/state";
import {
	errorMessage,
	getDeleteImpact,
	getSource,
	queries,
	RequestError,
	requireData,
	type SegmentFields,
	type Source,
	type SourceFields,
} from "./content";
import { SegmentForm, SourceForm } from "./Forms";
import { ConfirmDialog, InlineError, Shell } from "./Shared";

function SourceFrame({ children }: { children: ReactNode }) {
	const client = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const [creating, setCreating] = useState(false);
	const [drawer, setDrawer] = useState(false);
	const active = useRef(false);
	const generation = useRef(0);
	useEffect(
		() => () => {
			active.current = false;
		},
		[],
	);
	const create = useMutation({
		mutationFn: async ({
			fields,
		}: {
			fields: SourceFields;
			generation: number;
		}) => {
			const { data, error, response } = await api.POST("/api/sources", {
				body: fields,
			});
			return requireData(data, error, response.status);
		},
		onSuccess: (source, request) => {
			void client.invalidateQueries({ queryKey: queries.sources });
			void client.invalidateQueries({ queryKey: catalogKeys.all });
			if (active.current && request.generation === generation.current) {
				setCreating(false);
				setDrawer(false);
				navigate(
					sourceOverviewDestination(
						source.id,
						location.pathname === "/sources"
							? sourceEntrySearch(location.search)
							: location.search,
					),
				);
			}
		},
	});
	function startCreate() {
		generation.current += 1;
		active.current = true;
		create.reset();
		setCreating(true);
	}
	function closeCreate() {
		active.current = false;
		setCreating(false);
	}
	return (
		<Shell className="library-a1 sources-s2" fullWidth>
			<SourceSpace directory={<SourceDirectory onCreate={startCreate} />}>
				<div className="source-detail-content">
					<button
						id="source-drawer-trigger"
						type="button"
						className="button secondary s2-source-reveal"
						onClick={(e) => {
							e.currentTarget.focus();
							setDrawer(true);
						}}
					>
						切换来源
					</button>
					{children}
				</div>
			</SourceSpace>
			{drawer && (
				<ConfirmDialog
					titleId="source-drawer-title"
					className="s2-source-drawer"
					animateEntrance={false}
					onClose={() => setDrawer(false)}
					restoreFocusId="source-drawer-trigger"
				>
					<div className="section-heading">
						<h2 id="source-drawer-title">来源目录</h2>
						<button
							type="button"
							className="button secondary"
							data-dialog-cancel
							onClick={() => setDrawer(false)}
						>
							关闭
						</button>
					</div>
					<SourceDirectory
						onCreate={startCreate}
						onSelect={() => setDrawer(false)}
					/>
				</ConfirmDialog>
			)}
			{creating && (
				<ConfirmDialog titleId="create-source-title" onClose={closeCreate}>
					<h2 id="create-source-title">新建来源</h2>
					<SourceForm
						onSave={(fields) =>
							create.mutate({ fields, generation: generation.current })
						}
						onCancel={closeCreate}
						pending={create.isPending}
						error={create.error}
						submitLabel="保存来源"
					/>
				</ConfirmDialog>
			)}
		</Shell>
	);
}

export function SourceIndex() {
	const navigate = useNavigate();
	const location = useLocation();
	const entrySearch = sourceEntrySearch(location.search);
	const sort = readCatalogState(
		entrySearch,
		"sources",
		readPreference("sort-sources"),
		"s",
	);
	const remembered = readPreference("last-source");
	const target = useQuery({
		queryKey: ["source-entry", remembered, sort.sort, sort.order],
		staleTime: 0,
		queryFn: async () => {
			if (remembered && /^[A-Za-z0-9_-]+$/.test(remembered)) {
				try {
					return await getSource(remembered);
				} catch (error) {
					if (!(error instanceof RequestError && error.status === 404))
						throw error;
				}
			}
			const result = await catalogSources({
				sort: sort.sort as SourceQuery["sort"],
				order: sort.order,
				page: 1,
				page_size: 1,
			});
			return result.items[0] ?? null;
		},
	});
	useEffect(() => {
		if (target.isSuccess && !target.isFetching && target.data)
			navigate(sourceOverviewDestination(target.data.id, entrySearch), {
				replace: true,
			});
	}, [target.data, target.isSuccess, target.isFetching, navigate, entrySearch]);
	return (
		<SourceFrame>
			{target.isPending || target.isFetching ? (
				<p role="status">正在打开来源…</p>
			) : target.isError ? (
				<div className="state-card">
					<InlineError error={target.error} />
					<button
						className="button secondary"
						type="button"
						onClick={() => void target.refetch()}
					>
						重试
					</button>
				</div>
			) : !target.data ? (
				<div className="s2-welcome">
					<h1>从一份来源开始</h1>
					<p>在来源栏新建来源，便可导入素材或手动添加片段</p>
				</div>
			) : null}
		</SourceFrame>
	);
}
function SourceDelete({
	source,
	close,
	deleted,
}: {
	source: Source;
	close: () => void;
	deleted: () => void;
}) {
	const [previewFailure, setPreviewFailure] = useState(false);
	const impact = useQuery({
		queryKey: queries.impact(source.id),
		queryFn: () => getDeleteImpact(source.id),
		staleTime: 0,
	});
	const remove = useMutation({
		mutationFn: async () => {
			setPreviewFailure(false);
			const latest = await impact.refetch();
			if (latest.isError || !latest.data) {
				setPreviewFailure(true);
				throw latest.error ?? new Error("无法核对删除范围，请重试。");
			}
			if (
				latest.data.material_count !== impact.data?.material_count ||
				latest.data.segment_count !== impact.data?.segment_count ||
				latest.data.thread_count !== impact.data?.thread_count ||
				latest.data.message_count !== impact.data?.message_count ||
				latest.data.active_job_count !== impact.data?.active_job_count
			)
				throw new Error("删除范围刚刚变化，请核对最新影响后再次确认。");
			const { error, response } = await api.DELETE("/api/sources/{source_id}", {
				params: { path: { source_id: source.id } },
			});
			if (error || !response.ok) throw errorMessage(error, response.status);
		},
		onSuccess: deleted,
	});
	useEffect(() => {
		if (previewFailure && impact.isSuccess) {
			remove.reset();
			setPreviewFailure(false);
		}
	}, [impact.isSuccess, previewFailure, remove.reset]);
	return (
		<ConfirmDialog titleId="delete-title" onClose={close}>
			<p className="eyebrow">删除确认</p>
			<h2 id="delete-title">删除「{source.title}」？</h2>
			{impact.isPending ? (
				<p>正在读取当前影响范围…</p>
			) : impact.isError ? (
				<InlineError error={impact.error} />
			) : (
				<p>
					这会一并删除该来源下的{" "}
					<strong>{impact.data.segment_count} 个片段</strong>、
					<strong>{impact.data.thread_count} 条讨论</strong>和{" "}
					<strong>{impact.data.message_count} 条消息</strong>。
					{impact.data.active_job_count > 0 &&
						`其中 ${impact.data.active_job_count} 个进行中的任务会被中断。`}
					该来源下的 {impact.data.material_count}{" "}
					份阅读材料也将不可再打开，托管原书暂时保留。删除后无法从页面恢复；其他来源不受影响。
				</p>
			)}
			<InlineError
				error={
					impact.isError && remove.error === impact.error ? null : remove.error
				}
			/>
			<div className="actions">
				<button
					className="button danger"
					type="button"
					disabled={!impact.isSuccess || remove.isPending}
					onClick={() => remove.mutate()}
				>
					{remove.isPending ? "删除中…" : "确认删除"}
				</button>
				<button
					className="button secondary"
					type="button"
					disabled={remove.isPending}
					onClick={close}
				>
					取消
				</button>
				{impact.isError && (
					<button
						className="button secondary"
						type="button"
						onClick={() => void impact.refetch()}
					>
						重试预览
					</button>
				)}
			</div>
		</ConfirmDialog>
	);
}

export function SourceDetail() {
	const { id = "" } = useParams();
	const location = useLocation();
	const navigate = useNavigate();
	const client = useQueryClient();
	const active = useRef(true);
	const segmentActive = useRef(false);
	const segmentGeneration = useRef(0);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
			segmentActive.current = false;
		};
	}, []);
	const [editing, setEditing] = useState(false);
	const editGeneration = useRef(0);
	const [creating, setCreating] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [info, setInfo] = useState(false);
	const menuId = useId();
	const menu = useRef<HTMLDivElement>(null);
	const source = useQuery({
		queryKey: queries.source(id),
		queryFn: () => getSource(id),
	});
	useEffect(() => {
		if (source.isSuccess) savePreference("last-source", id);
	}, [id, source.isSuccess]);
	const update = useMutation({
		mutationFn: async ({
			fields,
		}: {
			fields: SourceFields;
			generation: number;
		}) => {
			const { data, error, response } = await api.PATCH(
				"/api/sources/{source_id}",
				{ params: { path: { source_id: id } }, body: fields },
			);
			return requireData(data, error, response.status);
		},
		onSuccess: (_source, request) => {
			if (active.current && request.generation === editGeneration.current)
				setEditing(false);
			void client.invalidateQueries({ queryKey: queries.source(id) });
			void client.invalidateQueries({ queryKey: queries.sources });
			void client.invalidateQueries({ queryKey: catalogKeys.all });
		},
	});
	const create = useMutation({
		mutationFn: async ({
			fields,
		}: {
			fields: SegmentFields;
			generation: number;
		}) => {
			const { data, error, response } = await api.POST(
				"/api/sources/{source_id}/segments",
				{ params: { path: { source_id: id } }, body: fields },
			);
			return requireData(data, error, response.status);
		},
		onSuccess: (segment, request) => {
			void client.invalidateQueries({ queryKey: queries.source(id) });
			void client.invalidateQueries({ queryKey: queries.sources });
			void client.invalidateQueries({ queryKey: catalogKeys.all });
			void client.invalidateQueries({ queryKey: queries.segments(id) });
			if (
				active.current &&
				segmentActive.current &&
				request.generation === segmentGeneration.current
			)
				navigate(`/segments/${segment.id}`, {
					state: {
						returnTo: {
							to: `${location.pathname}${location.search}`,
							label: source.data?.title ?? "来源",
						},
					},
				});
		},
	});
	function closeSegment() {
		segmentActive.current = false;
		setCreating(false);
	}
	function action(run: () => void) {
		menu.current?.hidePopover();
		document.getElementById("source-menu-trigger")?.focus();
		run();
	}
	return (
		<SourceFrame>
			{source.isPending ? (
				<p role="status">正在加载来源…</p>
			) : source.isError ? (
				<div className="state-card">
					<h1>来源不可用</h1>
					<InlineError error={source.error} />
					<div className="actions">
						<Link className="button secondary" to="/sources">
							返回来源目录
						</Link>
						<button
							className="button secondary"
							type="button"
							onClick={() => void source.refetch()}
						>
							重试
						</button>
					</div>
				</div>
			) : (
				<>
					<header className="s2-source-heading">
						<div>
							<h1>{source.data.title}</h1>
							{source.data.description && <p>{source.data.description}</p>}
						</div>
						<button
							id="source-menu-trigger"
							className="library-icon"
							type="button"
							aria-label="来源的更多操作"
							title="来源的更多操作"
							aria-haspopup="menu"
							popoverTarget={menuId}
						>
							<Icon name="more" />
						</button>
						<div
							id={menuId}
							ref={menu}
							className="library-popover s2-source-menu popover-motion"
							role="menu"
							popover="auto"
							onToggle={(e) => {
								if (e.newState === "open")
									e.currentTarget
										.querySelector<HTMLButtonElement>("button")
										?.focus();
							}}
							onKeyDown={(e) => {
								const buttons = Array.from(
									e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
								);
								const current = buttons.indexOf(
									document.activeElement as HTMLButtonElement,
								);
								const next =
									e.key === "ArrowDown"
										? (current + 1) % buttons.length
										: e.key === "ArrowUp"
											? (current - 1 + buttons.length) % buttons.length
											: e.key === "Home"
												? 0
												: e.key === "End"
													? buttons.length - 1
													: null;
								if (next !== null) {
									e.preventDefault();
									buttons[next]?.focus();
								}
							}}
						>
							<button
								type="button"
								role="menuitem"
								onClick={() => action(() => setInfo(true))}
							>
								来源信息
							</button>
							<button
								type="button"
								role="menuitem"
								onClick={() =>
									action(() => {
										editGeneration.current += 1;
										update.reset();
										setEditing(true);
									})
								}
							>
								编辑来源
							</button>
							<button
								type="button"
								role="menuitem"
								className="text-danger"
								onClick={() => action(() => setDeleting(true))}
							>
								删除来源及其内容…
							</button>
						</div>
					</header>
					<SourceContent
						source={source.data}
						onAddSegment={() => {
							segmentGeneration.current += 1;
							segmentActive.current = true;
							create.reset();
							setCreating(true);
						}}
						onShowInfo={() => setInfo(true)}
					/>
					{info && (
						<ConfirmDialog
							titleId="source-info-title"
							onClose={() => setInfo(false)}
							restoreFocusId="source-menu-trigger"
						>
							<h2 id="source-info-title">来源信息</h2>
							<h3>{source.data.title}</h3>
							<p className="s2-full-text">
								{source.data.description || "尚无描述"}
							</p>
							<h3>来源备注</h3>
							<p className="s2-full-text">{source.data.note || "尚无备注"}</p>
							<button
								className="button secondary"
								type="button"
								data-dialog-cancel
								onClick={() => setInfo(false)}
							>
								关闭
							</button>
						</ConfirmDialog>
					)}
					{editing && (
						<ConfirmDialog
							titleId="edit-source-title"
							onClose={() => setEditing(false)}
							restoreFocusId="source-menu-trigger"
						>
							<h2 id="edit-source-title">编辑来源</h2>
							<SourceForm
								initial={source.data}
								onSave={(fields) =>
									update.mutate({ fields, generation: editGeneration.current })
								}
								onCancel={() => setEditing(false)}
								pending={update.isPending}
								error={update.error}
								submitLabel="保存更改"
							/>
						</ConfirmDialog>
					)}
					{creating && (
						<ConfirmDialog titleId="add-segment-title" onClose={closeSegment}>
							<h2 id="add-segment-title">添加片段</h2>
							<SegmentForm
								onSave={(fields) =>
									create.mutate({
										fields,
										generation: segmentGeneration.current,
									})
								}
								onCancel={closeSegment}
								pending={create.isPending}
								error={create.error}
								submitLabel="保存片段"
							/>
						</ConfirmDialog>
					)}
					{deleting && (
						<SourceDelete
							source={source.data}
							close={() => setDeleting(false)}
							deleted={() => {
								forgetSourceImports(client, id);
								void client.invalidateQueries({ queryKey: queries.sources });
								void client.invalidateQueries({ queryKey: queries.source(id) });
								void client.invalidateQueries({ queryKey: catalogKeys.all });
								void client.invalidateQueries({ queryKey: ["source-entry"] });
								if (active.current) {
									savePreference("last-source", "");
									navigate("/sources");
								}
							}}
						/>
					)}
				</>
			)}
		</SourceFrame>
	);
}
