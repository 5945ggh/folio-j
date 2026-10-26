import {
	type Mutation,
	useMutation,
	useMutationState,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { importMaterial } from "../materials/api";
import { InlineError } from "../Shared";
import { BookCoverPlaceholder } from "./BookCoverPlaceholder";
import {
	forgetCompletedImports,
	type ImportInput,
	type ImportResult,
	type ImportTask,
	importKey,
	importOptions,
	importTask,
	visibleImportTasks,
} from "./import-state";
import "./import-cards.css";

export function useMaterialImport() {
	return useMutation(importOptions(useQueryClient(), importMaterial));
}

/** Rendered IDs hide duplicates; successful refreshes authorize retiring their import results. */
export function useImportTasks(
	books: readonly { id: string }[],
	sourceId?: string,
	canConsume = true,
) {
	const client = useQueryClient();
	const tasks = useMutationState<
		ImportTask,
		Mutation<ImportResult, Error, ImportInput>
	>({
		filters: { mutationKey: importKey },
		select: (mutation) => importTask(client, mutation),
	});
	useEffect(() => {
		if (!tasks.some((task) => task.status === "success")) return;
		forgetCompletedImports(client, [
			...(canConsume ? books.map((book) => book.id) : []),
			...tasks.flatMap((task) =>
				task.invalidated && task.data ? [task.data.material.id] : [],
			),
		]);
	}, [client, books, tasks, canConsume]);
	return visibleImportTasks(
		tasks,
		books.map((book) => book.id),
		sourceId,
	);
}

export function ImportCards({
	tasks,
	returnLabel,
}: {
	tasks: readonly ImportTask[];
	returnLabel: string;
}) {
	const client = useQueryClient();
	const upload = useMaterialImport();
	const location = useLocation();
	if (!tasks.length) return null;
	function remove(task: ImportTask, retry = false) {
		const mutation = client
			.getMutationCache()
			.findAll({ mutationKey: importKey })
			.find((item) => item.mutationId === task.id);
		if (!mutation || mutation.state.status === "pending") return;
		client.getMutationCache().remove(mutation);
		if (upload.variables === task.input) upload.reset();
		if (retry && mutation.state.status === "error") upload.mutate(task.input);
	}
	return (
		<>
			{tasks.map((task) => {
				const ready = task.status === "success" ? task.data : undefined;
				const title =
					ready?.material.title ?? task.input.file.name.replace(/\.epub$/i, "");
				const pending = task.status === "pending";
				const cover = (
					<>
						<div className="book-cover">
							<BookCoverPlaceholder title={title} />
							{pending && (
								<div className="book-import-overlay" aria-hidden="true">
									<span className="import-preparation-indicator" />
								</div>
							)}
						</div>
						<h3 className="book-title" title={title}>
							{title}
						</h3>
					</>
				);
				return (
					<article
						className="book-card book-import-card"
						key={task.id}
						aria-busy={pending}
						aria-label={title}
					>
						{ready ? (
							<Link
								className="book-main-link"
								to={`/materials/${ready.material.id}`}
								state={{
									returnTo: {
										to: `${location.pathname}${location.search}`,
										label: returnLabel,
									},
								}}
							>
								{cover}
							</Link>
						) : (
							<div>{cover}</div>
						)}
						<p className="book-import-status" role="status">
							{pending
								? "正在准备书籍和注音…"
								: ready
									? ready.reused
										? "书籍已在素材库中"
										: "已准备好，可以阅读"
									: "导入失败"}
						</p>
						<InlineError error={task.error} />
						{!pending && (
							<div className="book-import-actions">
								{task.status === "error" && (
									<button type="button" onClick={() => remove(task, true)}>
										重试
									</button>
								)}
								<button type="button" onClick={() => remove(task)}>
									{ready ? "关闭提示" : "移除"}
								</button>
							</div>
						)}
					</article>
				);
			})}
		</>
	);
}
