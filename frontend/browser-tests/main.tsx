import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
	createMemoryRouter,
	type RouteObject,
	RouterProvider,
} from "react-router";
import type { components } from "../src/api/schema";
import type { StudyTarget } from "../src/materials/study-api";
import "../src/styles.css";
import { analysisReading } from "./analysis-reading";
import { analysisRename } from "./analysis-rename";
import { appTheme } from "./app-theme";
import { overviewImportRegression } from "./catalog-overview";
import { reusedImportRegression } from "./catalog-reuse";
import { catalogToolbarRegression } from "./catalog-toolbar";
import { chapterRecords } from "./chapter-records";
import { explanationRegression } from "./explanation";
import { materialImport } from "./material-import";
import { navigationFeedback } from "./navigation-feedback";
import { readerBookmarks } from "./reader-bookmarks";
import { readerClipboard } from "./reader-clipboard";
import { readerImages } from "./reader-images";
import { readerLayoutSwitch } from "./reader-layout-switch";
import { readerSession } from "./reader-session";
import { readingAidsRegression } from "./reading-aids";
import { recordSaving } from "./record-saving";
import { routeLoading } from "./route-loading";
import { routeMotion } from "./route-motion";
import { segmentMaterials } from "./segment-materials";
import { segmentShareRegression } from "./segment-share";
import { themeRegression } from "./theme";
import { translationRegression } from "./translation";
import { workbenchRegression } from "./workbench";
import { workbenchHistory } from "./workbench-history";
import { workbenchRender } from "./workbench-render";

const result = document.querySelector<HTMLPreElement>("#result");
const container = document.querySelector<HTMLDivElement>("#root");
if (!result || !container) throw new Error("Missing browser test containers");
const output = result;
const root = createRoot(container);
const unexpectedRequests: string[] = [];
let handleRequest: (request: Request) => Promise<Response> = async (
	request,
) => {
	throw new Error(`No mock for ${request.method} ${request.url}`);
};

// Install before importing product API modules, which capture global fetch.
window.fetch = async (input, init) => {
	const request = new Request(input, init);
	try {
		check(
			new URL(request.url).origin === location.origin,
			`Unexpected origin ${request.url}`,
		);
		return await handleRequest(request);
	} catch (error) {
		unexpectedRequests.push(String(error));
		throw error;
	}
};

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
async function until(predicate: () => boolean, message: string) {
	for (let attempt = 0; attempt < 150; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`${message}\n${container?.textContent}`);
}
function element<T extends Element>(selector: string): T {
	const found = container?.querySelector<T>(selector);
	check(found, `Missing ${selector}`);
	return found;
}
function button(label: string): HTMLButtonElement {
	const found = [...(container?.querySelectorAll("button") ?? [])].find(
		(item) => item.textContent?.trim() === label,
	);
	check(found, `Missing button ${label}`);
	check(!found.disabled, `Disabled button ${label}`);
	return found;
}
function inputValue(
	input: HTMLInputElement | HTMLTextAreaElement,
	value: string,
) {
	const prototype =
		input instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	check(setter, "Missing native input value setter");
	setter.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
}
async function mount(
	content: ReactNode,
	path = "*",
	initialEntry = "/",
	children?: RouteObject[],
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const router = createMemoryRouter(
		[{ id: "browser-test-root", path, element: content, children }],
		{
			initialEntries: [initialEntry],
		},
	);
	root.render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return () => {
		flushSync(() => root.render(null));
		router.dispose();
		client.clear();
	};
}

async function cardLayout() {
	const { MaterialsPage } = await import("../src/catalog/MaterialsPage");
	const book: components["schemas"]["MaterialCatalogItem"] = {
		id: "book",
		version_id: "version",
		contract_version: "1",
		type: "book",
		title: "ブラウザー回帰用の本",
		source_id: "source",
		source_title: "テスト",
		cover_url: null,
		created_at: "2026-10-23T00:00:00Z",
		last_opened_at: null,
		status: "not_started",
		usage_revision: 0,
		product_sha256: "a".repeat(64),
		source_sha256: "b".repeat(64),
		warnings: [],
	};
	handleRequest = async (request) => {
		const { pathname } = new URL(request.url);
		if (request.method === "GET" && pathname === "/api/sources")
			return Response.json([]);
		if (request.method === "GET" && pathname === "/api/materials")
			return Response.json({ items: [book], page: 1, page_size: 50, total: 1 });
		throw new Error(`Unexpected ${request.method} ${pathname}`);
	};
	localStorage.clear();
	const dispose = await mount(<MaterialsPage />);
	try {
		await until(
			() => !!container?.querySelector(".book-card"),
			"Book not loaded",
		);
		check(window.innerWidth <= 720, "Runner must use a narrow viewport");
		const slider = element<HTMLInputElement>('input[type="range"]');
		const card = element<HTMLElement>(".book-card");
		const grid = element<HTMLElement>(".book-grid");
		const widths: number[] = [];
		for (const size of [140, 280]) {
			inputValue(slider, String(size));
			await until(
				() => Math.abs(card.getBoundingClientRect().width - size) < 1,
				`Card must follow ${size}px slider preference`,
			);
			widths.push(card.getBoundingClientRect().width);
			check(
				card.getBoundingClientRect().right <=
					grid.getBoundingClientRect().right + 1,
				"Card overflows its grid",
			);
		}
		element<HTMLElement>(".catalog-body").style.width = "120px";
		await until(
			() => card.getBoundingClientRect().width <= 121,
			"Card must fit a container narrower than its selected width",
		);
		return `card layout: slider 140/280 => ${widths.join("/")}px; narrow container ${card.getBoundingClientRect().width}px`;
	} finally {
		dispose();
	}
}

async function clearStudyContext() {
	const { StudySegmentPanel } = await import(
		"../src/materials/StudySegmentPanel"
	);
	const text = "前。学習。後。";
	const target: StudyTarget = {
		reference: {
			contract_version: "1",
			material_id: "material",
			version_id: "version",
			ranges: [
				{
					resource_id: "r",
					spine_index: 0,
					start: 2,
					end: 5,
					exact: "学習。",
					text_sha256: "a".repeat(64),
					prefix: "前。",
					suffix: "後。",
				},
			],
		},
		chapter: {
			id: "chapter",
			material_id: "material",
			version_id: "version",
			title: "章",
			level: 0,
			resources: [
				{
					id: "r",
					text,
					text_sha256: "a".repeat(64),
					href: "r.xhtml",
					css: "",
					html_attributes: {},
					body_attributes: {},
				},
			],
			parts: [
				{
					resource_id: "r",
					spine_index: 0,
					start: 0,
					end: Array.from(text).length,
					html: "",
					leaf_start: 0,
					leaf_end: 1,
				},
			],
		},
	};
	let releaseSettings: (() => void) | undefined;
	let settingsRequested = false;
	let submitted: components["schemas"]["SegmentCreate"] | undefined;
	let accepted = false;
	const settings = new Promise<Response>((resolve) => {
		releaseSettings = () =>
			resolve(
				Response.json({
					enabled: true,
					before_sentences: 3,
					after_sentences: 3,
					before_characters: 200,
					after_characters: 200,
					revision: 0,
				}),
			);
	});
	handleRequest = async (request) => {
		const { pathname } = new URL(request.url);
		if (
			request.method === "GET" &&
			pathname === "/api/settings/segment-context"
		) {
			settingsRequested = true;
			return settings;
		}
		if (
			request.method === "POST" &&
			pathname === "/api/sources/source/segments/material-provenance/matches"
		)
			return Response.json({ segments: [], truncated: false });
		if (
			request.method === "POST" &&
			pathname === "/api/sources/source/segments"
		) {
			submitted = await request.json();
			return Response.json({
				id: "saved",
				source_id: "source",
				text: "学習。",
				text_sha256: "c".repeat(64),
				context_before: "",
				context_after: "",
				material_provenance: target.reference,
				created_at: "2026-10-23T00:00:00Z",
				updated_at: "2026-10-23T00:00:00Z",
				text_locked_at: "2026-10-23T00:00:00Z",
				revision: 1,
				note: "",
				source_ref: "",
				transcription: "",
				translation: "",
			});
		}
		throw new Error(`Unexpected ${request.method} ${pathname}`);
	};
	const dispose = await mount(
		<StudySegmentPanel
			target={target}
			sourceId="source"
			sourceTitle="テスト"
			onCancel={() => {}}
			onSaved={() => {
				accepted = true;
			}}
		/>,
	);
	try {
		await until(
			() => !!container?.querySelector(".study-context-fields textarea"),
			"Study panel not loaded",
		);
		await until(() => settingsRequested, "Settings request not started");
		for (const details of container?.querySelectorAll(".study-context-side") ??
			[])
			details.setAttribute("open", "");
		const fields = [
			...(container?.querySelectorAll<HTMLTextAreaElement>(
				".study-context-fields textarea",
			) ?? []),
		];
		check(
			fields.length === 2 && fields[0] && fields[1],
			"Expected both context inputs",
		);
		inputValue(fields[0], "手動前文");
		inputValue(fields[1], "手動後文");
		await until(
			() =>
				container?.querySelectorAll(".study-context-status").length === 2 &&
				[...(container?.querySelectorAll(".study-context-status") ?? [])].every(
					(status) => status.textContent?.includes("已编辑"),
				),
			"React must receive both edits",
		);
		button("清空前后文").click();
		await until(
			() => fields.every((field) => field.value === ""),
			"Clear button must clear both fields",
		);
		check(releaseSettings, "Settings must remain pending before clearing");
		releaseSettings();
		await until(
			() =>
				!!container?.querySelector(".study-budget-grid") &&
				!container?.textContent?.includes("正在摘录…"),
			"Late settings and prefill must settle",
		);
		check(
			fields.every((field) => field.value === ""),
			"Late prefill overwrote cleared context",
		);
		button("保存片段").click();
		await until(() => accepted, "Saved callback not received");
		check(submitted, "Save request not captured");
		check(
			submitted.context_before === "" && submitted.context_after === "",
			"Save payload must retain both empty fields",
		);
		const savedReference = submitted.material_provenance;
		check(savedReference, "Save omitted exact provenance");
		for (const field of [
			"contract_version",
			"material_id",
			"version_id",
		] as const)
			check(
				savedReference[field] === target.reference[field],
				`Save changed ${field}`,
			);
		check(
			savedReference.ranges.length === target.reference.ranges.length,
			"Save changed provenance range count",
		);
		for (const [index, expected] of target.reference.ranges.entries()) {
			const actual = savedReference.ranges[index];
			check(
				actual &&
					Object.entries(expected).every(
						([key, value]) => actual[key as keyof typeof actual] === value,
					),
				"Save changed exact provenance range",
			);
		}
		return "study context: real clear button + late settings retain empty payload and exact provenance";
	} finally {
		dispose();
	}
}

try {
	const suite = new URLSearchParams(location.search).get("suite");
	const standalone = new Map([
		["app-theme", appTheme],
		["reader-images", readerImages],
		["reader-layout-switch", readerLayoutSwitch],
		["reader-image-performance", readerImages],
		["catalog-overview", overviewImportRegression],
		["catalog-reuse", reusedImportRegression],
		["catalog-toolbar", catalogToolbarRegression],
		["record-saving", recordSaving],
		["navigation-feedback", navigationFeedback],
		["route-motion", routeMotion],
		["route-loading", routeLoading],
	]).get(suite ?? "");
	const lines = standalone
		? [
				await standalone(
					{
						container,
						check,
						until,
						inputValue,
						mount,
						mock: (handler) => {
							handleRequest = handler;
						},
					},
					new URLSearchParams(location.search).has("preview"),
				),
			]
		: suite === "theme"
			? [
					await themeRegression({
						container,
						check,
						until,
						inputValue,
						mount,
						mock: (handler) => {
							handleRequest = handler;
						},
					}),
				]
			: suite === "chapter-records" || suite === "inline-records"
				? [
						await chapterRecords(
							{
								container,
								check,
								until,
								inputValue,
								mount,
								mock: (handler) => {
									handleRequest = handler;
								},
							},
							new URLSearchParams(location.search).has("preview"),
						),
					]
				: suite === "reader-clipboard"
					? [
							await readerClipboard(
								new URLSearchParams(location.search).has("preview"),
							),
						]
					: suite === "reading-aids"
						? [
								await readingAidsRegression(
									{
										container,
										check,
										until,
										inputValue,
										mount,
										mock: (handler) => {
											handleRequest = handler;
										},
									},
									new URLSearchParams(location.search).has("preview"),
								),
							]
						: suite === "translation"
							? [
									await translationRegression({
										container,
										check,
										until,
										inputValue,
										mount,
										mock: (handler) => {
											handleRequest = handler;
										},
									}),
								]
							: suite === "explanation" ||
									suite === "workbench-render" ||
									suite === "workbench-history" ||
									suite === "workbench" ||
									suite === "segment-materials" ||
									suite === "analysis-reading" ||
									suite === "analysis-rename" ||
									suite === "material-import" ||
									suite === "segment-share"
								? [
										await (suite === "explanation"
											? explanationRegression
											: suite === "material-import"
												? (h: Parameters<typeof materialImport>[0]) =>
														materialImport(
															h,
															new URLSearchParams(location.search).get(
																"preview",
															) ||
																new URLSearchParams(location.search).has(
																	"preview",
																),
														)
												: suite === "segment-share"
													? segmentShareRegression
													: suite === "analysis-rename"
														? analysisRename
														: suite === "analysis-reading"
															? analysisReading
															: suite === "segment-materials"
																? segmentMaterials
																: suite === "workbench-history"
																	? workbenchHistory
																	: suite === "workbench-render"
																		? workbenchRender
																		: workbenchRegression)({
											container,
											check,
											until,
											inputValue,
											mount,
											mock: (handler) => {
												handleRequest = handler;
											},
										}),
									]
								: suite === "reader-bookmarks" || suite === "reader-session"
									? [
											await (suite === "reader-session"
												? readerSession
												: readerBookmarks)({
												container,
												check,
												until,
												inputValue,
												mount,
												mock: (handler) => {
													handleRequest = handler;
												},
											}),
										]
									: [
											await workbenchRegression({
												container,
												check,
												until,
												inputValue,
												mount,
												mock: (handler) => {
													handleRequest = handler;
												},
											}),
											await cardLayout(),
											await clearStudyContext(),
											await segmentMaterials({
												container,
												check,
												until,
												inputValue,
												mount,
												mock: (handler) => {
													handleRequest = handler;
												},
											}),
											await readerBookmarks(
												{
													container,
													check,
													until,
													inputValue,
													mount,
													mock: (handler) => {
														handleRequest = handler;
													},
												},
												true,
											),
										];
	check(unexpectedRequests.length === 0, unexpectedRequests.join("\n"));
	output.textContent = `PASS\n${lines.join("\n")}`;
	output.dataset.status = "passed";
} catch (error) {
	output.textContent = `FAIL\n${String(error)}\n${unexpectedRequests.join("\n")}`;
	output.dataset.status = "failed";
}
