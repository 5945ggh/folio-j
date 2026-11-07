import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation } from "react-router";
import type { AnalysisDetail } from "../src/analysis/api";
import type { Book } from "../src/catalog/api";
import type { Source } from "../src/content";
import type { BrowserHarness } from "./harness";

const source: Source = {
	id: "editing-source",
	title: "来源标题",
	description: "已有描述",
	note: "长期备注",
	segment_count: 0,
	created_at: "2026-11-03T00:00:00Z",
	updated_at: "2026-11-03T00:00:00Z",
};

export async function sourceEditDelete(h: BrowserHarness) {
	const { SourceEditDialog } = await import("../src/catalog/SourceEditDialog");
	const { BookDeleteDialog } = await import("../src/catalog/BookDeleteDialog");
	const { AnalysisPanel } = await import("../src/analysis/AnalysisPanel");
	const { getSource, queries } = await import("../src/content");
	const { container, mount, mock, until, inputValue } = h;
	const check: BrowserHarness["check"] = h.check;
	const button = (label: string, parent: ParentNode = container) => {
		const node = [...parent.querySelectorAll<HTMLButtonElement>("button")].find(
			(item) => item.textContent?.trim() === label,
		);
		check(node, `Missing button ${label}`);
		return node;
	};
	const respond = (
		complete: ((response: Response) => void) | undefined,
		response: Response,
	) => {
		check(complete, "A pending request must have a response callback");
		complete(response);
	};
	const top = () => {
		const node = [
			...container.querySelectorAll<HTMLDialogElement>("dialog[open]"),
		].at(-1);
		check(node, "Expected an open dialog");
		return node;
	};
	const dialogText = () =>
		[...container.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1)
			?.textContent;
	const cancelEvent = () =>
		top().dispatchEvent(new Event("cancel", { cancelable: true }));
	const patches: Record<string, unknown>[] = [];
	let releasePatch: ((response: Response) => void) | undefined;
	let releaseSourceRead: ((response: Response) => void) | undefined;
	let staleReadCompleted = false;
	let queryClient: QueryClient | undefined;
	mock(async (request) => {
		if (
			request.method === "GET" &&
			new URL(request.url).pathname === `/api/sources/${source.id}`
		) {
			// Deliberately return even if cancellation aborts the request signal.
			return new Promise<Response>((resolve) => {
				releaseSourceRead = resolve;
			});
		}
		if (
			request.method === "PATCH" &&
			new URL(request.url).pathname === `/api/sources/${source.id}`
		) {
			patches.push(await request.json());
			return new Promise<Response>((resolve) => {
				releasePatch = resolve;
			});
		}
		throw new Error(
			`Unexpected source editor request ${request.method} ${request.url}`,
		);
	});
	function Editor() {
		const client = useQueryClient();
		queryClient = client;
		useState(() => client.setQueryData(queries.source(source.id), source));
		const current = useQuery({
			queryKey: queries.source(source.id),
			// Match SourceDetail: the real GET does not consume AbortSignal.
			queryFn: async () => {
				const result = await getSource(source.id);
				staleReadCompleted = true;
				return result;
			},
		});
		const [open, setOpen] = useState(true);
		const location = useLocation();
		return (
			<>
				<output data-path>{location.pathname}</output>
				<h1 data-source-title>{current.data?.title}</h1>
				<p data-source-note>{current.data?.note}</p>
				<Link to={location.pathname === "/away" ? "/finish" : "/away"}>
					离开测试
				</Link>
				<button type="button" onClick={() => setOpen(true)}>
					编辑测试来源
				</button>
				{open && current.data && (
					<SourceEditDialog
						initial={current.data}
						onClose={() => setOpen(false)}
					/>
				)}
			</>
		);
	}
	let dispose = await mount(<Editor />);
	try {
		await until(
			() => !!container.querySelector(".source-form") && !!releaseSourceRead,
			"Cached source opens while its stale background GET remains pending",
		);
		button("保存更改").click();
		await until(
			() => !container.querySelector("dialog[open]"),
			"Unchanged save closes without a write",
		);
		check(Number(patches.length) === 0, "Unchanged source must not PATCH");
		button("编辑测试来源").click();
		await until(
			() => !!container.querySelector(".source-form"),
			"Editor reopens",
		);
		const field =
			container.querySelector<HTMLInputElement>(".source-form input");
		check(field, "Source title input must exist");
		inputValue(field, "自己的名称");
		button("取消").click();
		await until(
			() => dialogText()?.includes("放弃本次编辑") === true,
			"Cancel must protect edits",
		);
		button("继续编辑", top()).click();
		await until(
			() => container.querySelectorAll("dialog[open]").length === 1,
			"Continue preserves editor",
		);
		cancelEvent();
		await until(
			() => dialogText()?.includes("放弃本次编辑") === true,
			"Escape close request uses same reminder",
		);
		button("继续编辑", top()).click();
		await until(
			() => container.querySelectorAll("dialog[open]").length === 1,
			"Continue returns to editor",
		);
		container.querySelector<HTMLAnchorElement>("a")?.click();
		await until(
			() => dialogText()?.includes("放弃本次编辑") === true,
			"Navigation uses same reminder",
		);
		check(
			container.querySelector("[data-path]")?.textContent === "/",
			"Dirty navigation remains on source",
		);
		button("继续编辑", top()).click();
		await until(
			() => container.querySelectorAll("dialog[open]").length === 1,
			"Navigation cancellation keeps editor",
		);
		check(
			field.value === "自己的名称",
			"Every close attempt must preserve input",
		);
		const save = button("保存更改");
		save.click();
		save.click();
		await until(() => !!releasePatch, "Changed source must PATCH");
		check(
			Number(patches.length) === 1 &&
				JSON.stringify(patches[0]) === JSON.stringify({ title: "自己的名称" }),
			"Only changed title is submitted once",
		);
		cancelEvent();
		check(
			container.querySelectorAll("dialog[open]").length === 1,
			"Pending save cannot close",
		);
		respond(
			releasePatch,
			Response.json({ detail: "保存暂时失败" }, { status: 500 }),
		);
		await until(
			() => !!dialogText()?.includes("保存暂时失败"),
			"Failure retains source draft",
		);
		check(field.value === "自己的名称", "Failed source save retains input");
		const note = container.querySelectorAll<HTMLTextAreaElement>(
			".source-form textarea",
		)[1];
		check(note, "Source note input must exist");
		inputValue(note, "");
		releasePatch = undefined;
		button("保存更改").click();
		await until(() => !!releasePatch, "Retry must PATCH");
		check(
			JSON.stringify(patches[1]) ===
				JSON.stringify({ title: "自己的名称", note: "" }),
			"Clearing remains explicit and description is omitted",
		);
		container.querySelector<HTMLAnchorElement>("a")?.click();
		await until(
			() => dialogText()?.includes("正在保存") === true,
			"Navigation must wait for the in-flight source save",
		);
		check(releasePatch, "Pending retry must have response");
		respond(
			releasePatch,
			Response.json({ ...source, title: "自己的名称", note: "" }),
		);
		await until(
			() => !container.querySelector("dialog[open]"),
			"Successful save closes directly",
		);
		await until(
			() => container.querySelector("[data-path]")?.textContent === "/away",
			"Successful save completes the pending navigation",
		);
		check(queryClient, "Source editor must expose its real query client");
		const savedSource = queryClient.getQueryData<Source>(
			queries.source(source.id),
		);
		check(
			savedSource?.title === "自己的名称" && savedSource.note === "",
			"Successful save publishes title and cleared note to source cache",
		);
		check(!staleReadCompleted, "The old GET must still be pending after save");
		respond(releaseSourceRead, Response.json(source));
		await until(
			() => staleReadCompleted,
			"The old real source GET returns its stale body despite cancellation",
		);
		await new Promise((resolve) => requestAnimationFrame(resolve));
		const afterStaleRead = queryClient.getQueryData<Source>(
			queries.source(source.id),
		);
		check(
			afterStaleRead?.title === "自己的名称" && afterStaleRead.note === "",
			"Late source GET must not overwrite the successful save in cache",
		);
		check(
			container.querySelector("[data-source-title]")?.textContent ===
				"自己的名称" &&
				container.querySelector("[data-source-note]")?.textContent === "",
			"Source query subscribers retain saved title and cleared note after old GET",
		);
		button("编辑测试来源").click();
		await until(
			() => !!container.querySelector(".source-form"),
			"Source opens for discard",
		);
		const discardField =
			container.querySelector<HTMLInputElement>(".source-form input");
		check(discardField, "Discard editor input exists");
		check(
			discardField.value === "自己的名称" &&
				container.querySelectorAll<HTMLTextAreaElement>(
					".source-form textarea",
				)[1]?.value === "",
			"Reopened editor starts from the successful save after the late GET",
		);
		inputValue(discardField, "放弃的内容");
		container.querySelector<HTMLAnchorElement>("a")?.click();
		await until(
			() => dialogText()?.includes("放弃本次编辑") === true,
			"Discard navigation is protected",
		);
		button("放弃并离开", top()).click();
		await until(
			() =>
				container.querySelector("[data-path]")?.textContent === "/finish" &&
				!container.querySelector("dialog[open]"),
			"Explicit discard completes navigation",
		);
		check(Number(patches.length) === 2, "Discard does not save");
	} finally {
		dispose();
	}

	const book: Book = {
		id: "delete-book",
		type: "book",
		title: "删除的书",
		source_id: source.id,
		source_title: source.title,
		version_id: "version",
		contract_version: "1",
		cover_url: null,
		created_at: source.created_at,
		last_opened_at: null,
		status: "not_started",
		usage_revision: 0,
		source_sha256: "s",
		product_sha256: "p",
		warnings: [],
	};
	const bookImpact = (cascade: boolean, empty = false) => ({
		material_id: book.id,
		hidden_result_count: empty ? 0 : cascade ? 3 : 2,
		retained_result_count: empty ? 0 : cascade ? 0 : 1,
		active_task_count: empty ? 0 : 2,
		segment_count: empty ? 0 : 3,
		analysis_count: empty ? 0 : 4,
		thread_count: empty ? 0 : 5,
		message_count: empty ? 0 : 12,
		active_job_count: empty ? 0 : 1,
	});
	function BookDeletion() {
		const [open, setOpen] = useState(true);
		return open ? (
			<BookDeleteDialog
				book={book}
				close={() => setOpen(false)}
				restoreFocusId=""
			/>
		) : (
			<p>书籍已删除</p>
		);
	}
	let releaseDelete: ((response: Response) => void) | undefined;
	for (const cascade of [false, true]) {
		let bookReads = 0;
		const submittedModes: string[] = [];
		let releaseOldImpact: ((response: Response) => void) | undefined;
		mock(async (request) => {
			const url = new URL(request.url);
			const mode = url.searchParams.get("delete_learning_content");
			if (
				request.method === "GET" &&
				url.pathname === `/api/materials/${book.id}/delete-impact`
			) {
				bookReads++;
				if (bookReads === 1)
					return Response.json({ detail: "影响暂时无法读取" }, { status: 500 });
				// Resolve this obsolete unchecked read after the checked mode is ready.
				if (cascade && mode === "false" && bookReads === 4)
					return new Promise<Response>((resolve) => {
						releaseOldImpact = resolve;
					});
				return Response.json(bookImpact(mode === "true"));
			}
			if (
				request.method === "DELETE" &&
				url.pathname === `/api/materials/${book.id}`
			) {
				submittedModes.push(mode ?? "missing");
				return new Promise<Response>((resolve) => {
					releaseDelete = resolve;
				});
			}
			throw new Error(
				`Unexpected book deletion request ${request.method} ${url}`,
			);
		});
		releaseDelete = undefined;
		dispose = await mount(<BookDeletion />);
		try {
			await until(
				() => !!dialogText()?.includes("影响暂时无法读取"),
				"Impact failure stays visible",
			);
			const checkbox = container.querySelector<HTMLInputElement>(
				'input[type="checkbox"]',
			);
			check(
				checkbox && !checkbox.checked,
				"Book deletion starts with learning content retained",
			);
			check(
				checkbox.closest("label")?.textContent?.trim() === "同时删除学习积累",
				"Cleanup uses the concise checkbox label",
			);
			check(button("删除书籍").disabled, "Impact failure prevents deletion");
			button("重试读取删除影响").click();
			await until(
				() => !!dialogText()?.includes("2 份译文随本书隐藏"),
				"Impact retry displays retained mode",
			);
			check(
				dialogText()?.includes("3 个学习片段、4 份讲解") &&
					dialogText()?.includes("5 个讨论、12 条消息") &&
					dialogText()?.includes("1 个讨论任务继续运行") &&
					dialogText()?.includes("2 个翻译任务") &&
					dialogText()?.includes("1 份仍可从保留的片段查看"),
				"All learning impact counts appear",
			);
			if (cascade) {
				checkbox.click();
				await until(
					() => !!dialogText()?.includes("3 份译文随本书隐藏"),
					"Cascade impact uses its own query",
				);
				checkbox.click();
				await until(
					() => !!releaseOldImpact,
					"Unchecked refresh remains in flight",
				);
				checkbox.click();
				await until(
					() =>
						checkbox.checked &&
						!!dialogText()?.includes("3 份译文随本书隐藏") &&
						!button("删除书籍").disabled,
					"Checked mode can finish before old unchecked impact",
				);
				respond(
					releaseOldImpact,
					Response.json({ ...bookImpact(false), hidden_result_count: 99 }),
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
				check(
					!dialogText()?.includes("99") &&
						dialogText()?.includes("3 份译文随本书隐藏"),
					"Late unchecked data cannot replace checked counts",
				);
				check(
					dialogText()?.includes("人工讲解") &&
						dialogText()?.includes("后续讨论") &&
						dialogText()?.includes("手动录入的片段保留") &&
						dialogText()?.includes("将停止 1 个讨论任务、2 个翻译任务"),
					"Cascade warning explains its exact scope",
				);
			}
			const reads = bookReads;
			const remove = button("删除书籍");
			remove.click();
			remove.click();
			await until(() => !!releaseDelete, "Book DELETE starts");
			check(
				submittedModes.length === 1 &&
					submittedModes[0] === String(cascade) &&
					bookReads === reads,
				"Submit directly deletes the selected mode once",
			);
			check(
				checkbox.disabled && button("取消").disabled,
				"Pending deletion locks checkbox and cancel",
			);
			checkbox.click();
			cancelEvent();
			check(
				container.querySelector("dialog[open]") && checkbox.checked === cascade,
				"Pending deletion cannot close or change mode",
			);
			respond(
				releaseDelete,
				Response.json({ detail: "删除暂时失败" }, { status: 500 }),
			);
			await until(
				() => !!dialogText()?.includes("删除暂时失败"),
				"Book deletion failure stays visible",
			);
			check(
				checkbox.checked === cascade && !checkbox.disabled,
				"Failure preserves selection for retry",
			);
			releaseDelete = undefined;
			button("删除书籍").click();
			await until(() => !!releaseDelete, "Book retry starts");
			check(
				bookReads === reads &&
					Number(submittedModes.length) === 2 &&
					submittedModes[1] === String(cascade),
				"Retry preserves mode and does not reread impact",
			);
			if (cascade) {
				respond(releaseDelete, new Response(null, { status: 204 }));
				await until(
					() => !!dialogText()?.includes("操作失败"),
					"Cascade deletion requires a response receipt",
				);
				check(checkbox.checked, "Missing receipt keeps cleanup mode selected");
				releaseDelete = undefined;
				button("删除书籍").click();
				await until(() => !!releaseDelete, "Receipt retry starts");
				respond(
					releaseDelete,
					Response.json({
						material_id: "different-book",
						deleted_segment_ids: ["unrelated-segment"],
					}),
				);
				await until(
					() => !!dialogText()?.includes("删除回执与目标书籍不一致"),
					"A different book receipt cannot complete deletion",
				);
				releaseDelete = undefined;
				button("删除书籍").click();
				await until(() => !!releaseDelete, "Matching receipt retry starts");
				check(
					bookReads === reads &&
						submittedModes.every((mode) => mode === "true"),
					"Receipt retries keep their mode without rereading counts",
				);
			}
			respond(
				releaseDelete,
				cascade
					? Response.json({
							material_id: book.id,
							deleted_segment_ids: ["saved-from-book"],
						})
					: new Response(null, { status: 204 }),
			);
			await until(
				() => !!container.textContent?.includes("书籍已删除"),
				"Book deletion succeeds",
			);
		} finally {
			dispose();
		}
	}

	const analysis: AnalysisDetail = {
		id: "delete-analysis",
		segment_id: "segment",
		title: "学习讲解",
		excerpt: "摘录",
		current_revision_id: "r1",
		revision_id: "r1",
		parent_revision_id: null,
		origin: "manual",
		run_id: null,
		normalizer_version: 1,
		created_at: source.created_at,
		updated_at: source.updated_at,
		source_md: "## 学习\n正文",
		warnings: [],
		sections: [],
	};
	let analysisReads = 0,
		analysisDeletes = 0;
	releaseDelete = undefined;
	mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (
			request.method === "DELETE" &&
			path === `/api/analyses/${analysis.id}`
		) {
			analysisDeletes++;
			return new Promise<Response>((resolve) => {
				releaseDelete = resolve;
			});
		}
		if (
			request.method === "GET" &&
			path === `/api/analyses/${analysis.id}/delete-impact`
		) {
			analysisReads++;
			return Response.json({
				analysis_id: analysis.id,
				title: analysis.title,
				revision_count: 2,
				section_count: 3,
				occurrence_count: 0,
			});
		}
		if (request.method === "GET" && path === `/api/analyses/${analysis.id}`)
			return Response.json(analysis);
		if (request.method === "GET" && path === "/api/analyses/other-analysis")
			return Response.json({
				...analysis,
				id: "other-analysis",
				title: "另一份讲解",
			});
		if (request.method === "GET" && path === "/api/segments/segment/analyses")
			return Response.json([analysis]);
		throw new Error(
			`Unexpected analysis deletion request ${request.method} ${path}`,
		);
	});
	function AnalysisDeletion() {
		const [selected, setSelected] = useState<string | null>(analysis.id);
		return (
			<>
				<button type="button" onClick={() => setSelected("other-analysis")}>
					切换测试讲解
				</button>
				<AnalysisPanel
					segmentId="segment"
					selectedId={selected}
					revisionId={null}
					onSelect={setSelected}
				/>
			</>
		);
	}
	dispose = await mount(<AnalysisDeletion />);
	try {
		await until(
			() => !!container.querySelector(".analysis-document"),
			"Analysis document loads",
		);
		const menu = container.querySelector<HTMLButtonElement>(
			".analysis-menu-trigger",
		);
		check(menu, "Analysis menu exists");
		menu.click();
		button("删除此讲解").click();
		await until(
			() => !!dialogText()?.includes("2 个修订"),
			"Analysis impact loads",
		);
		button("切换测试讲解").click();
		await until(
			() =>
				!!container
					.querySelector(".analysis-document")
					?.textContent?.includes("另一份讲解"),
			"Underlying selection may change while confirmation retains its original target",
		);
		const reads = analysisReads;
		const remove = button("确认删除");
		remove.click();
		remove.click();
		await until(() => !!releaseDelete, "Analysis DELETE starts");
		check(
			analysisDeletes === 1 && analysisReads === reads,
			"Analysis deletes once without rereading",
		);
		cancelEvent();
		check(
			container.querySelector("dialog[open]"),
			"Pending analysis deletion stays open",
		);
		check(releaseDelete, "Analysis response is available");
		respond(
			releaseDelete,
			Response.json({ detail: "删除暂时失败" }, { status: 500 }),
		);
		await until(
			() => !!dialogText()?.includes("删除暂时失败"),
			"Analysis failure retains confirmation",
		);
		releaseDelete = undefined;
		button("确认删除").click();
		await until(() => !!releaseDelete, "Analysis retry starts");
		check(
			Number(analysisDeletes) === 2 && analysisReads === reads,
			"Analysis retry does not reread",
		);
		check(releaseDelete, "Analysis retry response available");
		respond(releaseDelete, new Response(null, { status: 204 }));
		await until(
			() => !container.querySelector("dialog[open]"),
			"Analysis deletion closes confirmation",
		);
	} finally {
		dispose();
	}
	const capture = new URLSearchParams(location.search);
	if (capture.has("capture")) {
		const empty = capture.has("empty");
		const unchecked = empty || capture.has("unchecked");
		document.documentElement.dataset.theme =
			capture.get("mode") === "dark" ? "dark" : "light";
		mock(async (request) => {
			if (new URL(request.url).pathname.endsWith("/delete-impact"))
				return Response.json(
					bookImpact(
						new URL(request.url).searchParams.get("delete_learning_content") ===
							"true",
						empty,
					),
				);
			throw new Error(`Unexpected capture request ${request.url}`);
		});
		await mount(<BookDeletion />);
		await until(
			() =>
				!!dialogText()?.includes(
					empty ? "本书暂无关联的学习片段" : "3 个学习片段",
				),
			"Capture dialog and impact finish mounting",
		);
		await until(() => !button("删除书籍").disabled, "Capture impact loads");
		const checkbox = container.querySelector<HTMLInputElement>(
			'input[type="checkbox"]',
		);
		check(checkbox, "Capture cleanup checkbox exists");
		if (!unchecked) {
			checkbox.click();
			await until(
				() =>
					!!dialogText()?.includes("3 份译文随本书隐藏") &&
					!button("删除书籍").disabled,
				"Capture shows selected learning cleanup",
			);
		}
		check(
			checkbox.checked === !unchecked,
			"Capture preserves the requested cleanup mode",
		);
		if (empty) {
			check(
				!/(?:^|\s)0\s*(?:个|份|条)/.test(dialogText() ?? ""),
				"Empty impact omits zero counts",
			);
			check(
				!dialogText()?.includes("任务") && !dialogText()?.includes("份译文"),
				"Empty impact omits task and translation notices",
			);
		} else {
			check(
				dialogText()?.includes("3 个学习片段、4 份讲解、5 个讨论、12 条消息"),
				"Capture shows nonzero learning counts",
			);
		}
	}

	return `source edit and deletion ${innerWidth}px: changed-field PATCH, clearing, close/navigation draft reminder, retry; direct book/analysis DELETE, optional learning cleanup, impact retry, late mode isolation, retained selection, duplicate and pending-close guards`;
}
