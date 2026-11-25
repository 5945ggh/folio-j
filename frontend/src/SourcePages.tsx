import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api } from "./api/client";
import {
	catalogKeys,
	catalogSources,
	type SourceQuery,
	seedSourceQueryData,
} from "./catalog/api";
import { readPreference, savePreference } from "./catalog/hooks";
import { forgetSourceImports } from "./catalog/import-state";
import { Icon } from "./catalog/LibraryTools";
import { SourceDirectory } from "./catalog/SourceDirectory";
import { SourceEditDialog } from "./catalog/SourceEditDialog";
import { SourceSpace } from "./catalog/SourceSpace";
import { SourceContent } from "./catalog/SourceViews";
import { forgetSourceDetails } from "./catalog/source-deletion";
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

const sourceDrawerFocus = ["source-drawer-trigger", "source-welcome-create"];

function SourceFrame({
	children,
	showSourceSwitch = true,
}: {
	children: ReactNode | ((startCreate: () => void) => ReactNode);
	showSourceSwitch?: boolean;
}) {
	const client = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const [creating, setCreating] = useState(false);
	const [drawer, setDrawer] = useState(false);
	const [editingSource, setEditingSource] = useState<Source | null>(null);
	useEffect(() => {
		if (!showSourceSwitch) setDrawer(false);
	}, [showSourceSwitch]);
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
			client.setQueryData(queries.source(source.id), source);
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
			<SourceSpace
				directory={
					<SourceDirectory onCreate={startCreate} onEdit={setEditingSource} />
				}
			>
				<div className="source-detail-content">
					{showSourceSwitch && (
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
					)}
					{typeof children === "function" ? children(startCreate) : children}
				</div>
			</SourceSpace>
			{showSourceSwitch && drawer && (
				<ConfirmDialog
					titleId="source-drawer-title"
					className="s2-source-drawer"
					animateEntrance={false}
					onClose={() => setDrawer(false)}
					restoreFocusId={sourceDrawerFocus}
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
						submitLabel="创建来源"
					/>
				</ConfirmDialog>
			)}
			{editingSource && (
				<SourceEditDialog
					key={editingSource.id}
					initial={editingSource}
					onClose={() => setEditingSource(null)}
				/>
			)}
		</Shell>
	);
}

export function SourceIndex() {
	const client = useQueryClient();
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
		if (target.isSuccess && !target.isFetching && target.data) {
			seedSourceQueryData(client, target.data);
			navigate(sourceOverviewDestination(target.data.id, entrySearch), {
				replace: true,
			});
		}
	}, [
		client,
		target.data,
		target.isSuccess,
		target.isFetching,
		navigate,
		entrySearch,
	]);
	const noSources =
		target.isSuccess && !target.isFetching && target.data === null;
	return (
		<SourceFrame showSourceSwitch={!noSources}>
			{(startCreate) =>
				target.isPending || target.isFetching ? (
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
					<div className="source-welcome s2-welcome">
						<div className="source-welcome-icon">
							<Icon name="book" />
						</div>
						<h1>创建第一个来源</h1>
						<p>创建后就可以导入书籍或添加日文片段。</p>
						<div className="actions">
							<button
								id="source-welcome-create"
								className="button primary"
								type="button"
								onClick={(event) => {
									event.currentTarget.focus();
									startCreate();
								}}
							>
								新建来源
							</button>
						</div>
					</div>
				) : null
			}
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
	const submitting = useRef(false);
	const impact = useQuery({
		queryKey: queries.impact(source.id),
		queryFn: () => getDeleteImpact(source.id),
		staleTime: 0,
	});
	const remove = useMutation({
		mutationFn: async () => {
			if (!impact.data || impact.data.source_id !== source.id)
				throw new Error("无法确认要删除的来源，请刷新后重试。");
			const { error, response } = await api.DELETE("/api/sources/{source_id}", {
				params: { path: { source_id: source.id } },
			});
			if (error || !response.ok) throw errorMessage(error, response.status);
		},
		onSuccess: deleted,
		onSettled: () => {
			submitting.current = false;
		},
	});
	function cancel() {
		if (!submitting.current) close();
	}
	return (
		<ConfirmDialog titleId="delete-title" onClose={cancel}>
			<p className="eyebrow">删除确认</p>
			<h2 id="delete-title">删除「{source.title}」？</h2>
			{impact.isPending ? (
				<p>正在统计关联内容…</p>
			) : impact.isError ? (
				<InlineError error={impact.error} />
			) : (
				<p>
					将一并删除该来源下的{" "}
					<strong>{impact.data.segment_count} 个片段</strong>、
					<strong>{impact.data.analysis_count} 份讲解（含历史版本）</strong>、
					<strong>{impact.data.thread_count} 段对话</strong>和{" "}
					<strong>{impact.data.message_count} 条消息</strong>。
					{impact.data.active_job_count > 0 &&
						`将停止 ${impact.data.active_job_count} 个对话任务。`}
					{impact.data.material_count > 0 &&
						`同时移除 ${impact.data.material_count} 本已导入的书籍及其阅读数据。这些书籍的翻译任务也会停止。`}
					此操作无法撤销，不会影响你本地保存的 EPUB 文件。
				</p>
			)}
			<InlineError error={remove.error} />
			<div className="actions">
				<button
					className="button danger"
					type="button"
					disabled={!impact.isSuccess || impact.isFetching || remove.isPending}
					onClick={() => {
						if (submitting.current) return;
						submitting.current = true;
						remove.mutate();
					}}
				>
					{remove.isPending ? "删除中…" : "确认删除"}
				</button>
				<button
					className="button secondary"
					type="button"
					disabled={remove.isPending}
					data-dialog-cancel
					onClick={cancel}
				>
					取消
				</button>
				{impact.isError && (
					<button
						className="button secondary"
						type="button"
						onClick={() => void impact.refetch()}
					>
						重试
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
	const [creating, setCreating] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [info, setInfo] = useState(false);
	const menuId = useId();
	const menu = useRef<HTMLDivElement>(null);
	const menuTrigger = useRef<HTMLButtonElement>(null);
	const source = useQuery({
		queryKey: queries.source(id),
		queryFn: () => getSource(id),
	});
	const hasSource = source.isSuccess;
	useLayoutEffect(() => {
		if (!hasSource) return;
		const panel = menu.current;
		const button = menuTrigger.current;
		const content = button?.closest(".source-detail-content");
		if (!panel || !button || !content) return;

		const positionMenu = () => {
			if (!panel.matches(":popover-open")) return;
			const anchor = button.getBoundingClientRect();
			const scrollArea = content.getBoundingClientRect();
			if (
				anchor.bottom <= Math.max(0, scrollArea.top) ||
				anchor.top >= Math.min(innerHeight, scrollArea.bottom)
			) {
				panel.hidePopover();
				return;
			}
			panel.style.right = `${Math.max(12, Math.min(innerWidth - anchor.right, innerWidth - panel.offsetWidth - 12))}px`;
			const panelHeight = panel.offsetHeight;
			const below = anchor.bottom + 6;
			const above = anchor.top - panelHeight - 6;
			const bottomLimit = innerHeight - panelHeight - 12;
			const placeAbove = below > bottomLimit && above >= 12;
			panel.style.top = placeAbove
				? "auto"
				: `${Math.max(12, Math.min(below, bottomLimit))}px`;
			panel.style.bottom = placeAbove
				? `${innerHeight - anchor.top + 6}px`
				: "auto";
		};
		const layout = new ResizeObserver(positionMenu);
		const stopTracking = () => {
			layout.disconnect();
			content.removeEventListener("scroll", positionMenu);
			window.removeEventListener("scroll", positionMenu);
			window.removeEventListener("resize", positionMenu);
		};
		const onToggle = () => {
			if (!panel.matches(":popover-open")) {
				stopTracking();
				return;
			}
			positionMenu();
			if (!panel.matches(":popover-open")) return;
			layout.observe(content);
			layout.observe(button);
			content.addEventListener("scroll", positionMenu, { passive: true });
			window.addEventListener("scroll", positionMenu, { passive: true });
			window.addEventListener("resize", positionMenu);
			panel.querySelector<HTMLButtonElement>("button")?.focus({
				preventScroll: true,
			});
		};

		panel.addEventListener("toggle", onToggle);
		return () => {
			panel.removeEventListener("toggle", onToggle);
			stopTracking();
		};
	}, [hasSource]);
	useEffect(() => {
		if (source.isSuccess) savePreference("last-source", id);
	}, [id, source.isSuccess]);
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
							ref={menuTrigger}
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
								{source.data.description || "暂无描述"}
							</p>
							<h3>来源备注</h3>
							<p className="s2-full-text">{source.data.note || "暂无备注"}</p>
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
						<SourceEditDialog
							key={source.data.id}
							initial={source.data}
							onClose={() => setEditing(false)}
						/>
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
							deleted={async () => {
								forgetSourceImports(client, id);
								await forgetSourceDetails(client, id);
								void client.invalidateQueries({ queryKey: queries.sources });
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
