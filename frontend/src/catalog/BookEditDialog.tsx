import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useBeforeUnload, useBlocker } from "react-router";
import { queries, RequestError } from "../content";
import { materialKeys } from "../materials/api";
import { ConfirmDialog, InlineError } from "../Shared";
import {
	type BookDetails,
	type BookMetadataUpdate,
	bookDetailsKey,
	catalogKeys,
	getBookDetails,
	updateBookMetadata,
} from "./api";
import { BookCoverPlaceholder } from "./BookCoverPlaceholder";
import {
	bookMetadataUpdate,
	bookTitleError,
	type CoverIntent,
	coverFileError,
	metadataDraftChanged,
} from "./book-metadata";
import "./book-management.css";

function readCover(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("无法读取图片，请重新选择。"));
		reader.onload = () => {
			const data = String(reader.result);
			const image = new Image();
			image.onerror = () =>
				reject(new Error("图片无法解码，请选择有效的 PNG 或 JPEG。"));
			image.onload = () => {
				if (image.naturalWidth * image.naturalHeight > 16_000_000)
					reject(new Error("图片不能超过 1600 万像素。"));
				else resolve(data);
			};
			image.src = data;
		};
		reader.readAsDataURL(file);
	});
}

export function BookEditDialog({
	id,
	close,
	restoreFocusId,
}: {
	id: string;
	close: () => void;
	restoreFocusId?: string;
}) {
	const details = useQuery({
		queryKey: bookDetailsKey(id),
		queryFn: () => getBookDetails(id),
		staleTime: 0,
	});
	if (details.data)
		return (
			<BookEditor
				initial={details.data}
				close={close}
				restoreFocusId={restoreFocusId}
			/>
		);
	return (
		<ConfirmDialog
			titleId="book-edit-loading"
			onClose={close}
			className="book-edit-dialog"
			restoreFocusId={restoreFocusId}
		>
			<h2 id="book-edit-loading">编辑书籍信息</h2>
			{details.isError ? (
				<InlineError error={details.error} />
			) : (
				<p role="status">正在读取当前信息…</p>
			)}
			<div className="actions">
				{details.isError && (
					<button
						type="button"
						className="button primary"
						onClick={() => void details.refetch()}
					>
						重试
					</button>
				)}
				<button
					type="button"
					className="button secondary"
					data-dialog-cancel
					onClick={close}
				>
					取消
				</button>
			</div>
		</ConfirmDialog>
	);
}

function BookEditor({
	initial,
	close,
	restoreFocusId,
}: {
	initial: BookDetails;
	close: () => void;
	restoreFocusId?: string;
}) {
	const client = useQueryClient();
	const titleId = useId();
	const [base, setBase] = useState(initial);
	const [title, setTitle] = useState(initial.title);
	const [coverAction, setCoverAction] = useState<CoverIntent>("keep");
	const [cover, setCover] = useState<BookMetadataUpdate["cover"]>();
	const [preview, setPreview] = useState<string | null>(null);
	const [imageError, setImageError] = useState<Error | null>(null);
	const [readingFile, setReadingFile] = useState(false);
	const [reloadError, setReloadError] = useState<Error | null>(null);
	const [reloading, setReloading] = useState(false);
	const [confirm, setConfirm] = useState<"discard" | "reload" | null>(null);
	const [failedCover, setFailedCover] = useState<string | null>(null);
	const submitting = useRef(false);
	const blockerRef = useRef<ReturnType<typeof useBlocker> | null>(null);
	const fileSequence = useRef(0);
	useEffect(
		() => () => {
			fileSequence.current += 1;
		},
		[],
	);
	const titleError = bookTitleError(title);
	const dirty = metadataDraftChanged(base.title, title, coverAction);
	function syncDetails(details: BookDetails) {
		client.setQueryData(bookDetailsKey(details.id), details);
		const catalogRefresh = client.invalidateQueries({
			queryKey: catalogKeys.all,
		});
		void client.invalidateQueries({ queryKey: materialKeys.book(details.id) });
		void client.invalidateQueries({
			queryKey: materialKeys.list(details.source_id),
		});
		void client.invalidateQueries({
			queryKey: queries.source(details.source_id),
		});
		return catalogRefresh;
	}
	const save = useMutation({
		mutationFn: (body: BookMetadataUpdate) => updateBookMetadata(base.id, body),
		onSuccess: async (result) => {
			const catalogRefresh = syncDetails(result);
			if (restoreFocusId) await catalogRefresh;
			const navigation = blockerRef.current;
			if (navigation?.state === "blocked") navigation.proceed();
			close();
		},
		onSettled: () => {
			submitting.current = false;
		},
	});
	const conflict =
		save.error instanceof RequestError && save.error.status === 409;
	const busy = save.isPending || reloading;
	const blocker = useBlocker(
		() => dirty || readingFile || submitting.current || busy,
	);
	blockerRef.current = blocker;
	useBeforeUnload(
		useCallback(
			(event) => {
				if (dirty || readingFile || submitting.current || busy) {
					event.preventDefault();
					event.returnValue = "";
				}
			},
			[dirty, readingFile, busy],
		),
	);
	const confirmation = blocker.state === "blocked" ? "discard" : confirm;
	function continueEditing() {
		if (submitting.current || busy) return;
		if (blocker.state === "blocked") blocker.reset();
		setConfirm(null);
	}
	function discard() {
		if (submitting.current || busy) return;
		if (blocker.state === "blocked") blocker.proceed();
		close();
	}
	function dismiss() {
		if (submitting.current || busy) return;
		if (dirty || readingFile) setConfirm("discard");
		else close();
	}
	async function reload() {
		setConfirm(null);
		setReloading(true);
		setReloadError(null);
		try {
			const current = await getBookDetails(base.id);
			syncDetails(current);
			fileSequence.current += 1;
			setBase(current);
			setTitle(current.title);
			setCoverAction("keep");
			setCover(undefined);
			setPreview(null);
			setReadingFile(false);
			setImageError(null);
			save.reset();
		} catch (error) {
			setReloadError(
				error instanceof Error ? error : new Error("重新读取失败。"),
			);
		} finally {
			setReloading(false);
		}
	}
	const coverUrl =
		coverAction === "replace"
			? preview
			: coverAction === "reset"
				? null
				: base.cover_url;
	return (
		<ConfirmDialog
			titleId={titleId}
			onClose={dismiss}
			className="book-edit-dialog"
			restoreFocusId={restoreFocusId}
		>
			<h2 id={titleId}>编辑书籍信息</h2>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (
						submitting.current ||
						busy ||
						readingFile ||
						imageError ||
						titleError ||
						conflict ||
						!dirty
					)
						return;
					submitting.current = true;
					save.mutate(
						bookMetadataUpdate(
							title,
							base.metadata_revision,
							coverAction,
							cover,
						),
					);
				}}
			>
				<label className="field">
					书名
					<input
						value={title}
						disabled={busy}
						onChange={(event) => setTitle(event.target.value)}
						aria-invalid={Boolean(titleError)}
					/>
				</label>
				{titleError && <p className="inline-error">{titleError}</p>}
				<div className="book-edit-cover-row">
					<div className="book-edit-cover">
						{coverUrl && coverUrl !== failedCover ? (
							<img
								src={coverUrl}
								alt="封面预览"
								onError={() => setFailedCover(coverUrl)}
							/>
						) : (
							<BookCoverPlaceholder title={title || base.title} />
						)}
					</div>
					<div className="book-edit-cover-controls">
						<label className="field">
							选择自定义封面
							<input
								type="file"
								accept="image/png,image/jpeg,.png,.jpg,.jpeg"
								disabled={busy}
								onChange={async (event) => {
									const file = event.target.files?.[0];
									event.target.value = "";
									if (!file) return;
									const sequence = ++fileSequence.current;
									const error = coverFileError(file.type, file.size);
									setImageError(error ? new Error(error) : null);
									if (error) {
										setReadingFile(false);
										return;
									}
									setReadingFile(true);
									try {
										const data = await readCover(file);
										if (sequence !== fileSequence.current) return;
										setCover({
											media_type: file.type as "image/png" | "image/jpeg",
											data_base64: data.slice(data.indexOf(",") + 1),
										});
										setPreview(data);
										setCoverAction("replace");
									} catch (error) {
										if (sequence === fileSequence.current)
											setImageError(
												error instanceof Error
													? error
													: new Error("无法读取图片。"),
											);
									} finally {
										if (sequence === fileSequence.current)
											setReadingFile(false);
									}
								}}
							/>
						</label>
						<small>支持静态 PNG／JPEG，最大 4 MiB、1600 万像素。</small>
						<button
							type="button"
							className="button secondary"
							disabled={
								busy ||
								(!base.custom_cover && coverAction === "keep" && !imageError)
							}
							onClick={() => {
								fileSequence.current += 1;
								setReadingFile(false);
								setCoverAction(base.custom_cover ? "reset" : "keep");
								setCover(undefined);
								setPreview(null);
								setImageError(null);
							}}
						>
							恢复原书封面
						</button>
						{coverAction === "reset" && (
							<p role="status">保存后恢复原书封面。</p>
						)}
						{readingFile && <p role="status">正在读取图片…</p>}
					</div>
				</div>
				<InlineError error={imageError} />
				{conflict ? (
					<div className="inline-error" role="alert">
						<p>
							书籍信息已被其他操作更新。当前草稿已保留，请重新读取后再编辑。
						</p>
						<button
							type="button"
							className="button secondary"
							disabled={busy}
							onClick={() => setConfirm("reload")}
						>
							重新读取当前信息…
						</button>
					</div>
				) : (
					<InlineError error={save.error} />
				)}
				<InlineError error={reloadError} />
				<p className="book-edit-note">
					仅编辑应用内书名与封面；原始 EPUB 和所属来源保持不变。
				</p>
				<div className="actions">
					<button
						type="submit"
						className="button primary"
						disabled={
							busy ||
							readingFile ||
							Boolean(titleError) ||
							Boolean(imageError) ||
							conflict ||
							!dirty
						}
					>
						{save.isPending ? "正在保存…" : reloading ? "正在读取…" : "保存"}
					</button>
					<button
						type="button"
						className="button secondary"
						disabled={busy}
						data-dialog-cancel
						onClick={dismiss}
					>
						取消
					</button>
				</div>
			</form>
			{confirmation && (
				<ConfirmDialog titleId={`${titleId}-discard`} onClose={continueEditing}>
					<h2 id={`${titleId}-discard`}>
						{confirmation === "reload"
							? "重新读取并放弃草稿？"
							: "放弃未保存的修改？"}
					</h2>
					<p>
						{busy
							? "正在保存或读取书籍信息，请稍候。"
							: "书名和封面草稿尚未保存。"}
					</p>
					<div className="actions">
						<button
							type="button"
							className="button secondary"
							disabled={busy}
							data-dialog-cancel
							onClick={continueEditing}
						>
							继续编辑
						</button>
						<button
							type="button"
							className="button primary"
							disabled={busy}
							onClick={() =>
								confirmation === "reload" ? void reload() : discard()
							}
						>
							{confirmation === "reload" ? "放弃并重新读取" : "放弃修改"}
						</button>
					</div>
				</ConfirmDialog>
			)}
		</ConfirmDialog>
	);
}
