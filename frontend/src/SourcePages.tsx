import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "./api/client";
import {
	errorMessage,
	getDeleteImpact,
	getSource,
	listSegments,
	listSources,
	queries,
	requireData,
	type SegmentFields,
	type Source,
	type SourceFields,
} from "./content";
import { SegmentForm, SourceForm } from "./Forms";
import {
	ConfirmDialog,
	dateLabel,
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
	const sources = useQuery({ queryKey: queries.sources, queryFn: listSources });
	const create = useMutation({
		mutationFn: async (fields: SourceFields) => {
			const { data, error, response } = await api.POST("/api/sources", {
				body: fields,
			});
			return requireData(data, error, response.status);
		},
		onSuccess: (source) => {
			void client.invalidateQueries({ queryKey: queries.sources });
			if (active.current) navigate(`/sources/${source.id}`);
		},
	});
	if (sources.isPending) return <Loading />;
	if (sources.isError)
		return (
			<PageError error={sources.error} retry={() => void sources.refetch()} />
		);
	return (
		<Shell>
			<div className="page-heading">
				<div>
					<p className="eyebrow">SOURCES</p>
					<h1>来源目录</h1>
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
					新建来源
				</button>
			</div>
			{creating && (
				<section aria-label="新建来源" className="form-section">
					<h2>新建来源</h2>
					<SourceForm
						onSave={(fields) => create.mutate(fields)}
						onCancel={() => setCreating(false)}
						pending={create.isPending}
						error={create.error}
						submitLabel="保存来源"
					/>
				</section>
			)}
			<section className="list-section" aria-label="来源列表">
				<div className="section-heading">
					<h2>全部来源</h2>
					<span>{sources.data.length} 个来源</span>
				</div>
				{sources.data.length === 0 ? (
					<div className="empty-state">
						<p>
							还没有来源。先为作品或出处创建一条来源记录，再添加想学习的片段。
						</p>
					</div>
				) : (
					<div className="source-list">
						{sources.data.map((source) => (
							<Link
								key={source.id}
								className="source-row"
								to={`/sources/${source.id}`}
							>
								<div>
									<h3>{source.title}</h3>
									{source.description && <p>{source.description}</p>}
								</div>
								<span className="count">{source.segment_count} 个片段</span>
								<span className="row-arrow" aria-hidden="true">
									→
								</span>
							</Link>
						))}
					</div>
				)}
			</section>
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
					删除后无法从页面恢复；其他来源不受影响。
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
	const segments = useQuery({
		queryKey: queries.segments(id),
		queryFn: () => listSegments(id),
		enabled: source.isSuccess,
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
			void client.invalidateQueries({ queryKey: queries.segments(id) });
			if (activeId.current === id) navigate(`/segments/${segment.id}`);
		},
	});
	if (source.isPending) return <Loading />;
	if (source.isError)
		return (
			<PageError error={source.error} retry={() => void source.refetch()} />
		);
	return (
		<Shell>
			<nav className="breadcrumb" aria-label="位置">
				<Link to="/">来源目录</Link>
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
					<button
						className="button secondary"
						type="button"
						onClick={() => {
							update.reset();
							setEditing(!editing);
						}}
					>
						编辑来源
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
				<section className="form-section" aria-label="编辑来源">
					<h2>编辑来源</h2>
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
			<section className="list-section" aria-label="片段列表">
				<div className="section-heading">
					<h2>学习片段</h2>
					<span>{source.data.segment_count} 个片段</span>
				</div>
				{segments.isPending ? (
					<p className="loading">正在加载片段…</p>
				) : segments.isError ? (
					<div className="state-card">
						<InlineError error={segments.error} />
						<button
							className="button secondary"
							type="button"
							onClick={() => void segments.refetch()}
						>
							重试
						</button>
					</div>
				) : segments.data.length === 0 ? (
					<div className="empty-state">
						<p>还没有片段。手动添加一段日文，保存后可随时重读。</p>
					</div>
				) : (
					<div className="segment-list">
						{segments.data.map((segment) => (
							<Link
								className="segment-row"
								key={segment.id}
								to={`/segments/${segment.id}`}
							>
								<span className="segment-text" lang="ja">
									{segment.text}
								</span>
								<span className="segment-meta">
									{segment.source_ref || dateLabel(segment.created_at)}{" "}
									<span aria-hidden="true">→</span>
								</span>
							</Link>
						))}
					</div>
				)}
			</section>
			<div className="danger-zone">
				<button
					className="text-danger"
					type="button"
					onClick={() => setDeleting(true)}
				>
					删除此来源及其片段
				</button>
			</div>
			{deleting && (
				<SourceDelete
					source={source.data}
					close={() => setDeleting(false)}
					deleted={() => {
						void client.invalidateQueries({ queryKey: queries.sources });
						if (activeId.current === id) navigate("/");
					}}
				/>
			)}
		</Shell>
	);
}
