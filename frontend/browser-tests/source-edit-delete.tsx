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
	mock(async (request) => {
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
		const [open, setOpen] = useState(true);
		const location = useLocation();
		return (
			<>
				<output data-path>{location.pathname}</output>
				<Link to={location.pathname === "/away" ? "/finish" : "/away"}>
					离开测试
				</Link>
				<button type="button" onClick={() => setOpen(true)}>
					编辑测试来源
				</button>
				{open && (
					<SourceEditDialog initial={source} onClose={() => setOpen(false)} />
				)}
			</>
		);
	}
	let dispose = await mount(<Editor />);
	try {
		await until(
			() => !!container.querySelector(".source-form"),
			"Editor must mount",
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
		button("编辑测试来源").click();
		await until(
			() => !!container.querySelector(".source-form"),
			"Source opens for discard",
		);
		const discardField =
			container.querySelector<HTMLInputElement>(".source-form input");
		check(discardField, "Discard editor input exists");
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
	let bookReads = 0,
		bookDeletes = 0;
	let releaseDelete: ((response: Response) => void) | undefined;
	mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (
			request.method === "GET" &&
			path === `/api/materials/${book.id}/delete-impact`
		) {
			bookReads++;
			return Response.json({
				material_id: book.id,
				hidden_result_count: 2,
				retained_result_count: 1,
				active_task_count: 0,
			});
		}
		if (request.method === "DELETE" && path === `/api/materials/${book.id}`) {
			bookDeletes++;
			return new Promise<Response>((resolve) => {
				releaseDelete = resolve;
			});
		}
		throw new Error(
			`Unexpected book deletion request ${request.method} ${path}`,
		);
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
	dispose = await mount(<BookDeletion />);
	try {
		await until(
			() => !!dialogText()?.includes("2 份未关联"),
			"Book impact appears",
		);
		const reads = bookReads;
		const remove = button("删除书籍");
		remove.click();
		remove.click();
		await until(() => !!releaseDelete, "Book DELETE starts");
		check(
			bookDeletes === 1 && bookReads === reads,
			"Book confirmation directly deletes once",
		);
		cancelEvent();
		check(
			container.querySelector("dialog[open]"),
			"Pending book deletion stays open",
		);
		check(releaseDelete, "Book response must be available");
		respond(
			releaseDelete,
			Response.json({ detail: "删除暂时失败" }, { status: 500 }),
		);
		await until(
			() => !!dialogText()?.includes("删除暂时失败"),
			"Book deletion failure remains visible",
		);
		releaseDelete = undefined;
		button("删除书籍").click();
		await until(() => !!releaseDelete, "Book retry starts");
		check(
			bookReads === reads && Number(bookDeletes) === 2,
			"Retry does not reread impact",
		);
		check(releaseDelete, "Book retry response is available");
		respond(releaseDelete, new Response(null, { status: 204 }));
		await until(
			() => !!container.textContent?.includes("书籍已删除"),
			"Book deletion succeeds",
		);
	} finally {
		dispose();
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
	return `source edit and deletion ${innerWidth}px: changed-field PATCH, clearing, close/navigation draft reminder, retry; direct book/analysis DELETE, impact display, duplicate and pending-close guards`;
}
