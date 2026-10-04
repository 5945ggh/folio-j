import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api } from "./api/client";
import { catalogKeys } from "./catalog/api";
import { readPreference, savePreference } from "./catalog/hooks";
import { SourceContent, SourceDirectory } from "./catalog/SourceViews";
import { sourceListSearch } from "./catalog/state";
import {
	errorMessage,
	getDeleteImpact,
	getSource,
	queries,
	requireData,
	type SegmentFields,
	type Source,
	type SourceFields,
} from "./content";
import { SegmentForm, SourceForm } from "./Forms";
import {
	ConfirmDialog,
	InlineError,
	Loading,
	PageError,
	Shell,
} from "./Shared";

export function SourceIndex() {
	const client = useQueryClient();
	const navigate = useNavigate();
	const active = useRef(true);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	const [creating, setCreating] = useState(false);
	const create = useMutation({
		mutationFn: async (fields: SourceFields) => {
			const { data, error, response } = await api.POST("/api/sources", {
				body: fields,
			});
			return requireData(data, error, response.status);
		},
		onSuccess: (source) => {
			void client.invalidateQueries({ queryKey: queries.sources });
			void client.invalidateQueries({ queryKey: catalogKeys.all });
			if (active.current) navigate(`/sources/${source.id}`);
		},
	});
	return (
		<Shell>
			<div className="page-heading">
				<div>
					<p className="eyebrow">SOURCES</p>
					<h1>Source</h1>
					<p>按作品或出处整理学习片段，随时返回原文阅读。</p>
				</div>
				<button
					className="button primary"
					type="button"
					onClick={() => {
						create.reset();
						setCreating(true);
					}}
				>
					新建 Source
				</button>
			</div>
			{creating && (
				<section aria-label="新建 Source" className="form-section">
					<h2>新建 Source</h2>
					<SourceForm
						onSave={(fields) => create.mutate(fields)}
						onCancel={() => setCreating(false)}
						pending={create.isPending}
						error={create.error}
						submitLabel="保存 Source"
					/>
				</section>
			)}
			<SourceDirectory />
		</Shell>
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
	const location = useLocation();
	const sourceIndex = `/sources${sourceListSearch(location.search, "s", "")}`;
	const [contextCollapsed, setContextCollapsed] = useState(
		() => readPreference("source-context") === "collapsed",
	);
	const { id = "" } = useParams();
	const navigate = useNavigate();
	const client = useQueryClient();
	const activeId = useRef<string | null>(id);
	activeId.current = id;
	useEffect(() => {
		return () => {
			activeId.current = null;
		};
	}, []);
	const [editing, setEditing] = useState(false);
	const [creating, setCreating] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const source = useQuery({
		queryKey: queries.source(id),
		queryFn: () => getSource(id),
	});
	const update = useMutation({
		mutationFn: async (fields: SourceFields) => {
			const { data, error, response } = await api.PATCH(
				"/api/sources/{source_id}",
				{ params: { path: { source_id: id } }, body: fields },
			);
			return requireData(data, error, response.status);
		},
		onSuccess: () => {
			if (activeId.current === id) setEditing(false);
			void client.invalidateQueries({ queryKey: queries.source(id) });
			void client.invalidateQueries({ queryKey: queries.sources });
			void client.invalidateQueries({ queryKey: catalogKeys.all });
		},
	});
	const create = useMutation({
		mutationFn: async (fields: SegmentFields) => {
			const { data, error, response } = await api.POST(
				"/api/sources/{source_id}/segments",
				{ params: { path: { source_id: id } }, body: fields },
			);
			return requireData(data, error, response.status);
		},
		onSuccess: (segment) => {
			void client.invalidateQueries({ queryKey: queries.source(id) });
			void client.invalidateQueries({ queryKey: queries.sources });
			void client.invalidateQueries({ queryKey: catalogKeys.all });
			void client.invalidateQueries({ queryKey: queries.segments(id) });
			if (activeId.current === id)
				navigate(`/segments/${segment.id}`, {
					state: {
						returnTo: {
							to: `/sources/${id}?view=segments`,
							label: source.data?.title ?? "来源详情",
						},
					},
				});
		},
	});
	if (source.isPending) return <Loading />;
	if (source.isError)
		return (
			<PageError error={source.error} retry={() => void source.refetch()} />
		);
	return (
		<Shell>
			<div
				className={`source-space ${contextCollapsed ? "source-context-hidden" : ""}`}
			>
				<aside className="source-context-panel">
					<Link className="button secondary" to={sourceIndex}>
						管理 Source
					</Link>
					<SourceDirectory compact />
				</aside>
				<div className="source-detail-content">
					<nav className="breadcrumb" aria-label="位置">
						<Link to={sourceIndex}>Source</Link>
						<span aria-hidden="true">/</span>
						<span aria-current="page">{source.data.title}</span>
					</nav>
					<div className="page-heading">
						<div>
							<p className="eyebrow">SOURCE</p>
							<h1>{source.data.title}</h1>
							<p>{source.data.description || "这份来源还没有描述。"}</p>
						</div>
						<div className="heading-actions">
							<details className="source-management">
								<summary className="button secondary">更多</summary>
								<div>
									<button
										className="text-danger"
										type="button"
										onClick={(event) => {
											event.currentTarget.focus();
											setDeleting(true);
										}}
									>
										删除 Source 及其内容…
									</button>
								</div>
							</details>
							<button
								className="button secondary source-context-toggle"
								type="button"
								aria-expanded={!contextCollapsed}
								onClick={() => {
									setContextCollapsed(!contextCollapsed);
									savePreference(
										"source-context",
										contextCollapsed ? "expanded" : "collapsed",
									);
								}}
							>
								{contextCollapsed ? "展开 Source 列表" : "收起 Source 列表"}
							</button>
							<button
								className="button secondary"
								type="button"
								onClick={() => {
									update.reset();
									setEditing(!editing);
								}}
							>
								编辑 Source
							</button>
							<button
								className="button primary"
								type="button"
								onClick={() => {
									create.reset();
									setCreating(true);
								}}
							>
								添加片段
							</button>
						</div>
					</div>
					{source.data.note && !editing && (
						<aside className="note-card">
							<span>管理备注</span>
							<p>{source.data.note}</p>
						</aside>
					)}
					{editing && (
						<section className="form-section" aria-label="编辑 Source">
							<h2>编辑 Source</h2>
							<SourceForm
								key={source.data.updated_at}
								initial={source.data}
								onSave={(fields) => update.mutate(fields)}
								onCancel={() => setEditing(false)}
								pending={update.isPending}
								error={update.error}
								submitLabel="保存更改"
							/>
						</section>
					)}
					{creating && (
						<section className="form-section" aria-label="添加片段">
							<h2>添加片段</h2>
							<SegmentForm
								onSave={(fields) => create.mutate(fields)}
								onCancel={() => setCreating(false)}
								pending={create.isPending}
								error={create.error}
								submitLabel="保存片段"
							/>
						</section>
					)}
					<SourceContent source={source.data} />

					{deleting && (
						<SourceDelete
							source={source.data}
							close={() => setDeleting(false)}
							deleted={() => {
								void client.invalidateQueries({ queryKey: queries.sources });
								void client.invalidateQueries({ queryKey: catalogKeys.all });
								if (activeId.current === id) navigate("/sources");
							}}
						/>
					)}
				</div>
			</div>
		</Shell>
	);
}
