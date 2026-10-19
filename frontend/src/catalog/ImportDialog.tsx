import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { api } from "../api/client";
import {
	listSources,
	queries,
	requireData,
	type Source,
	type SourceFields,
} from "../content";
import { SourceForm } from "../Forms";
import { importMaterial, materialKeys } from "../materials/api";
import { ConfirmDialog, InlineError } from "../Shared";
import { catalogKeys } from "./api";
import { Icon } from "./LibraryTools";
export function ImportDialog({
	sourceId,
	close,
}: {
	sourceId?: string;
	close: () => void;
}) {
	const client = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const sourceSelectId = useId();
	const sourceSelect = useRef<HTMLSelectElement>(null);
	const sourceView = useRef<HTMLDivElement>(null);
	const initialView = useRef(true);
	const mounted = useRef(true);
	const dismissed = useRef(false);
	const transition = useRef<ReturnType<typeof setTimeout> | null>(null);
	const dismiss = () => {
		if (create.isPending) return;
		dismissed.current = true;
		if (transition.current) clearTimeout(transition.current);
		close();
	};
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			if (transition.current) clearTimeout(transition.current);
		};
	}, []);
	const [selected, setSelected] = useState(sourceId ?? "");
	const [newSource, setNewSource] = useState(false);
	const [file, setFile] = useState<File | null>(null);
	useEffect(() => {
		if (initialView.current) {
			initialView.current = false;
			return;
		}
		if (newSource) sourceView.current?.querySelector("input")?.focus();
		else sourceSelect.current?.focus();
	}, [newSource]);
	const sources = useQuery({ queryKey: queries.sources, queryFn: listSources });
	const create = useMutation({
		mutationFn: async (fields: SourceFields) => {
			const { data, error, response } = await api.POST("/api/sources", {
				body: fields,
			});
			return requireData(data, error, response.status);
		},
		onSuccess: (source) => {
			client.setQueryData<Source[]>(queries.sources, (current) => [
				source,
				...(current ?? []).filter((item) => item.id !== source.id),
			]);
			void client.invalidateQueries({ queryKey: queries.sources });
			void client.invalidateQueries({ queryKey: catalogKeys.all });
			if (mounted.current && !dismissed.current) {
				setSelected(source.id);
				setNewSource(false);
			}
		},
	});
	const upload = useMutation({
		mutationFn: () => {
			if (!file || !selected) throw new Error("请选择 EPUB 文件和所属来源。");
			return importMaterial(selected, file);
		},
		onSuccess: ({ material, reused }) => {
			void client.invalidateQueries({ queryKey: catalogKeys.all });
			void client.invalidateQueries({ queryKey: materialKeys.list(selected) });
			void client.invalidateQueries({ queryKey: queries.source(selected) });
			if (mounted.current && !dismissed.current)
				transition.current = setTimeout(() => {
					if (!mounted.current || dismissed.current) return;
					navigate(`/materials/${material.id}`, {
						state: {
							materialReused: reused,
							returnTo: {
								to: `${location.pathname}${location.search}`,
								label: sourceId ? "来源" : "素材库",
							},
						},
					});
				}, 320);
		},
	});
	const importing = upload.isPending || upload.isSuccess;
	const returnToImport = () => {
		if (!create.isPending) setNewSource(false);
	};
	return (
		<ConfirmDialog
			className="import-dialog"
			titleId="import-title"
			onClose={newSource ? returnToImport : dismiss}
			restoreFocusId="library-add"
		>
			<header className="import-dialog-heading">
				<h2 id="import-title">{newSource ? "新建来源" : "添加书籍"}</h2>
				<p>
					{newSource
						? "填写来源信息，创建后继续添加书籍。"
						: "选择一本 EPUB，并设置所属来源。"}
				</p>
			</header>
			<div className="import-view" hidden={newSource}>
				<div className="import-dialog-body">
					<div className="field">
						<span>书籍文件</span>
						<label className="import-file-picker">
							<input
								type="file"
								className="sr-only"
								aria-label="EPUB 文件"
								accept=".epub,application/epub+zip"
								disabled={importing}
								onChange={(event) => {
									setFile(event.target.files?.[0] ?? null);
									upload.reset();
								}}
							/>
							<span className="import-file-icon">
								<Icon name="book" />
							</span>
							<span className="import-file-copy">
								<strong>{file?.name ?? "选择 EPUB 文件"}</strong>
								<span>{file ? "EPUB 电子书" : "每次导入一本书籍"}</span>
							</span>
							<span className="import-file-action">
								{file ? "更换" : "选择文件"}
							</span>
						</label>
					</div>
					<div className="field">
						<div className="import-field-heading">
							<label htmlFor={sourceSelectId}>所属来源</label>
							{!sourceId && (
								<button
									className="import-text-button"
									type="button"
									disabled={importing}
									onClick={() => {
										create.reset();
										upload.reset();
										setNewSource(true);
									}}
								>
									<Icon name="plus" />
									新建来源
								</button>
							)}
						</div>
						<select
							id={sourceSelectId}
							ref={sourceSelect}
							required
							value={selected}
							disabled={importing || Boolean(sourceId)}
							onChange={(event) => {
								setSelected(event.target.value);
								upload.reset();
							}}
						>
							<option value="">
								{sources.isPending ? "正在加载来源…" : "请选择来源"}
							</option>
							{sources.data?.map((source) => (
								<option key={source.id} value={source.id}>
									{source.title}
								</option>
							))}
						</select>
					</div>
					{sources.isError && <InlineError error={sources.error} />}
					<InlineError error={upload.error} />
					{importing && (
						<div className="import-progress" role="status">
							<span
								aria-hidden="true"
								className="import-preparation-indicator"
							/>
							<div>
								<p>
									{upload.isSuccess
										? "书籍已准备好，正在打开…"
										: "正在准备书籍和注音，请稍候。"}
								</p>
								{upload.isPending && <small>关闭后仍会继续导入。</small>}
							</div>
						</div>
					)}
				</div>
				<div className="actions">
					<button
						className="button primary"
						type="button"
						disabled={!file || !selected || importing}
						onClick={() => upload.mutate()}
					>
						{upload.isPending
							? "正在导入…"
							: upload.isSuccess
								? "正在打开…"
								: "导入并阅读"}
					</button>
					<button
						type="button"
						className="button secondary"
						data-dialog-cancel
						onClick={dismiss}
					>
						{importing ? "关闭" : "取消"}
					</button>
				</div>
			</div>
			{newSource && (
				<div className="import-source-view" ref={sourceView}>
					<SourceForm
						className="import-source-form"
						onSave={(fields) => create.mutate(fields)}
						onCancel={returnToImport}
						pending={create.isPending}
						error={create.error}
						submitLabel="创建来源"
						cancelLabel="返回添加书籍"
					/>
				</div>
			)}
		</ConfirmDialog>
	);
}
