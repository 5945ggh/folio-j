import { useEffect } from "react";
import { Route, Routes, useNavigate } from "react-router";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";

type Schema = components["schemas"];
const timestamp = "2026-10-24T00:00:00Z";
const hash = "a".repeat(64);
const materialId = "reader-session";
const versionId = "v1";
const chapterId = "long-chapter";
const paragraphs = Array.from(
	{ length: 400 },
	(_, index) =>
		`春の風。第${String(index).padStart(3, "0")}段落。静かな庭を通り抜ける。`,
);
const text = paragraphs.join("");
const startAt = (index: number) => paragraphs.slice(0, index).join("").length;
const targetParagraph = 350;
const targetStart = startAt(targetParagraph);
const targetText = paragraphs[targetParagraph] ?? "";
const reference: Schema["MaterialProvenance"] = {
	contract_version: "1",
	material_id: materialId,
	version_id: versionId,
	ranges: [
		{
			resource_id: "r",
			spine_index: 0,
			start: targetStart,
			end: targetStart + targetText.length,
			exact: targetText,
			text_sha256: hash,
			prefix: "",
			suffix: "",
		},
	],
};
const chapter: Schema["MaterialChapterResponse"] = {
	id: chapterId,
	material_id: materialId,
	version_id: versionId,
	title: "400段の長い章",
	level: 0,
	resources: [
		{
			id: "r",
			text,
			text_sha256: hash,
			href: "chapter.xhtml",
			css: "p{margin:0 0 1.8em}",
			html_attributes: { lang: "ja" },
			body_attributes: {},
		},
	],
	parts: [0, 140, 280].map((first, index) => {
		const end = index === 2 ? 400 : first + 140;
		return {
			resource_id: "r",
			spine_index: 0,
			start: startAt(first),
			end: startAt(end),
			leaf_start: first,
			leaf_end: end,
			html: paragraphs
				.slice(first, end)
				.map(
					(value, local) =>
						`<p><span data-locator-leaf="${first + local}">${value}</span></p>`,
				)
				.join(""),
		};
	}),
};
const book: Schema["MaterialResponse"] = {
	id: materialId,
	source_id: "source",
	title: "阅读会话测量",
	version_id: versionId,
	contract_version: "1",
	product_sha256: hash,
	source_sha256: hash,
	created_at: timestamp,
	warnings: [],
	chapters: [{ id: chapterId, title: chapter.title, level: 0, part_count: 3 }],
	reading_position: {
		chapter_id: chapterId,
		resource_id: "r",
		version_id: versionId,
		part_index: 0,
		kind: "text",
		offset: 0,
		at_chapter_end: false,
		progress: 0,
		revision: 0,
		updated_at: timestamp,
		settings: { font_size: 22, line_height: 2, writing_mode: "horizontal-tb" },
	},
};
const readings: Schema["MaterialReadingsResponse"] = {
	material_id: materialId,
	version_id: versionId,
	generation_id: "generation",
	resources: [
		{
			resource_id: "r",
			text_sha256: hash,
			tokens: paragraphs.map((_, index) => ({
				start: startAt(index),
				end: startAt(index) + 1,
				surface: "春",
				reading: "ハル",
				dictionary_form: "春",
				normalized_form: "春",
				is_oov: false,
				pos: ["名詞"],
			})),
		},
	],
};
type RequestTiming = {
	method: string;
	path: string;
	start: number;
	end: number;
};
type Measurement = {
	scenario: string;
	firstFrameMs: number | null;
	allFramesMs: number | null;
	readableMs: number;
	savedMs: number;
	requests: Array<{
		method: string;
		path: string;
		startMs: number;
		fixtureResponseMs: number;
	}>;
	frameReused: boolean[];
	documentReused: boolean[];
};
const round = (value: number) => Math.round(value * 10) / 10;

/** Strict offline DOM measurements: fixture response durations are not network latency. */
export async function readerSession(h: BrowserHarness, realApp = false) {
	const params = new URLSearchParams(location.search);
	const retained = !params.has("baseline");
	const preview = params.has("preview");
	const vertical = params.get("direction") === "vertical-rl";
	const check: BrowserHarness["check"] = h.check;
	const { MaterialReader } = realApp
		? { MaterialReader: null }
		: await import("../src/materials/MaterialReader");
	const { RetainedRoute } = realApp
		? { RetainedRoute: null }
		: await import("../src/navigation/RetainedRoute");
	const App = realApp ? (await import("../src/App")).App : null;
	const segmentSelector = realApp
		? ".segment-workspace"
		: "[data-segment-page]";
	let navigate: ReturnType<typeof useNavigate> | undefined;
	function TestRoutes() {
		const routeNavigate = useNavigate();
		useEffect(() => {
			navigate = routeNavigate;
		}, [routeNavigate]);
		if (App) return <App />;
		check(
			MaterialReader && RetainedRoute,
			"Reader fixture components must load",
		);
		return (
			<>
				{retained && (
					<RetainedRoute
						path="/materials/:id"
						retainOn={(location) => /^\/segments\//.test(location.pathname)}
					>
						<MaterialReader />
					</RetainedRoute>
				)}
				<Routes>
					<Route
						path="/materials/:id"
						element={retained ? null : <MaterialReader />}
					/>
					<Route
						path="/sources/:id"
						element={<main data-source-page="">来源占位页</main>}
					/>
					<Route
						path="/segments/:id"
						element={<main data-segment-page="">片段学习占位页</main>}
					/>
				</Routes>
			</>
		);
	}
	localStorage.clear();
	localStorage.setItem("folio-reader-ui-v1", JSON.stringify({ focus: false }));
	localStorage.setItem(
		`folio-reader-book-ui-v1:${materialId}:${versionId}`,
		JSON.stringify({ rubyScope: "all" }),
	);
	localStorage.setItem(
		`folio-reader-book-ui-v1:other:${versionId}`,
		JSON.stringify({ rubyScope: "all" }),
	);
	const requestTimings: RequestTiming[] = [];
	let opened = 0;
	let saved = 0;
	let usageReads = 0;
	let addedStudyRecord = false;
	let materialUnavailable = false;
	let invalidProvenance = false;
	let changedVersion = false;
	let materialGate: Promise<void> | undefined;
	const savedPositions = new Map<string, Schema["ReadingPositionResponse"]>();
	h.mock(async (request) => {
		const actualPath = new URL(request.url).pathname;
		const requestedMaterialId = actualPath.match(
			/^\/api\/materials\/([^/]+)/,
		)?.[1];
		const path = actualPath.replace(
			"/api/materials/other",
			`/api/materials/${materialId}`,
		);
		check(
			request.method === "GET" ||
				(request.method === "POST" &&
					(path.endsWith("/readings/prepare") || path.endsWith("/opened"))) ||
				(request.method === "PUT" && path.endsWith("/reading-position")),
			`Unexpected reader side effect ${request.method} ${actualPath}`,
		);
		const timing: RequestTiming = {
			method: request.method,
			path: actualPath,
			start: performance.now(),
			end: 0,
		};
		requestTimings.push(timing);
		if (path === `/api/materials/${materialId}` && request.method === "GET") {
			await materialGate;
			if (materialUnavailable) {
				timing.end = performance.now();
				return Response.json({ detail: "材料不存在" }, { status: 404 });
			}
		}
		let data: unknown;
		if (path === `/api/materials/${materialId}` && request.method === "GET")
			data = {
				...book,
				reading_position:
					savedPositions.get(requestedMaterialId ?? materialId) ??
					(book.reading_position
						? {
								...book.reading_position,
								settings: {
									font_size: 22,
									line_height: 2,
									writing_mode: vertical ? "vertical-rl" : "horizontal-tb",
								},
							}
						: null),
			} satisfies Schema["MaterialResponse"];
		else if (path === "/api/sources/source")
			data = {
				id: "source",
				title: "Source",
				description: "",
				note: "",
				segment_count: 1,
				created_at: timestamp,
				updated_at: timestamp,
			} satisfies Schema["SourceResponse"];
		else if (realApp && path === "/api/segments/saved")
			data = {
				id: "saved",
				source_id: "source",
				text: targetText,
				text_sha256: hash,
				context_before: "",
				context_after: "",
				translation: "",
				transcription: "",
				source_ref: "",
				note: "",
				revision: 1,
				text_locked_at: timestamp,
				created_at: timestamp,
				updated_at: timestamp,
				material_provenance: reference,
			} satisfies Schema["SegmentResponse"];
		else if (realApp && path === "/api/segments/saved/analyses") data = [];
		else if (realApp && path === "/api/segments/saved/translation-results")
			data = [];
		else if (path.endsWith("/material-provenance"))
			data = {
				segment_id: "saved",
				status: invalidProvenance ? "snapshot_mismatch" : "resolved",
				assembly_rule: "concat-nfc-v1",
				material_provenance: reference,
				chapter_id: chapterId,
				chapter_title: chapter.title,
				parts: [
					{
						range_index: 0,
						part_index: 2,
						resource_id: "r",
						spine_index: 0,
						start: targetStart,
						end: targetStart + targetText.length,
					},
				],
			} satisfies Schema["SegmentProvenanceResponse"];
		else if (path.endsWith("/readings/prepare"))
			data = {
				material_id: materialId,
				version_id: versionId,
				generation_id: "generation",
				token_count: 400,
			} satisfies Schema["MaterialReadingsSummary"];
		else if (path.endsWith("/readings")) data = readings;
		else if (path === `/api/materials/${materialId}/chapters/${chapterId}`)
			data = chapter;
		else if (path.endsWith("/segments"))
			data = {
				items: [
					...(addedStudyRecord
						? [
								{
									segment_id: "new-saved",
									excerpt: paragraphs[20] ?? "",
									created_at: timestamp,
									material_provenance: {
										...reference,
										ranges: reference.ranges.map((range) => ({
											...range,
											start: startAt(20),
											end: startAt(21),
											exact: paragraphs[20] ?? "",
										})),
									},
								},
							]
						: []),
					{
						segment_id: "saved",
						excerpt: targetText,
						material_provenance: reference,
						created_at: timestamp,
					},
				],
				next_cursor: null,
				unavailable_count: 0,
			} satisfies Schema["MaterialChapterSegmentsResponse"];
		else if (path.endsWith(`/chapters/${chapterId}/translations`))
			data = { items: [], next_cursor: null, unavailable_count: 0 };
		else if (path.endsWith("/translations"))
			data = { results: [], tasks: [], next_offset: null };
		else if (path.endsWith("/usage") || path.endsWith("/opened")) {
			if (path.endsWith("/opened")) opened++;
			if (path.endsWith("/usage")) usageReads++;
			data = {
				material_id: materialId,
				status: "in_progress",
				revision: 1,
				last_opened_at: timestamp,
				updated_at: timestamp,
			} satisfies Schema["MaterialUsageResponse"];
		} else if (path.endsWith("/reading-position") && request.method === "PUT") {
			const update: Schema["ReadingPositionUpdate"] = await request.json();
			saved++;
			data = {
				...update,
				revision: update.expected_revision + 1,
				progress: 0,
				updated_at: timestamp,
			} satisfies Schema["ReadingPositionResponse"];
			savedPositions.set(
				requestedMaterialId ?? materialId,
				data as Schema["ReadingPositionResponse"],
			);
		} else
			throw new Error(
				`Unmocked reader session request ${request.method} ${path}`,
			);
		if (requestedMaterialId === "other" && data && typeof data === "object") {
			if ("material_id" in data) data = { ...data, material_id: "other" };
			else if ("id" in data && path === `/api/materials/${materialId}`)
				data = { ...data, id: "other" };
		}
		if (
			changedVersion &&
			data &&
			typeof data === "object" &&
			"version_id" in data
		) {
			data = {
				...data,
				version_id: "v2",
				...("reading_position" in data && data.reading_position
					? { reading_position: { ...data.reading_position, version_id: "v2" } }
					: {}),
			};
		}
		const response = Response.json(data);
		timing.end = performance.now();
		return response;
	});
	const frames = () => [
		...h.container.querySelectorAll<HTMLIFrameElement>("iframe.material-part"),
	];
	let started = performance.now();
	let firstFrame: number | null = null;
	let allFrames: number | null = null;
	let observing = true;
	const sample = () => {
		if (!observing) return;
		const current = frames();
		if (
			firstFrame === null &&
			current.length &&
			current[0]?.getClientRects().length
		)
			firstFrame = performance.now() - started;
		if (
			allFrames === null &&
			current.length === 3 &&
			current[0]?.getClientRects().length &&
			current.every(
				(frame) =>
					(frame.contentDocument?.querySelectorAll("ruby[data-auto-ruby]")
						.length ?? 0) >= 120,
			)
		)
			allFrames = performance.now() - started;
		requestAnimationFrame(sample);
	};
	requestAnimationFrame(sample);
	const measurements: Measurement[] = [];
	const measure = async (
		scenario: string,
		previous: HTMLIFrameElement[] = [],
		documents: (Document | null)[] = [],
		requestIndex = 0,
		openedBefore = 0,
		savedBefore = 0,
		usageBefore = 0,
	) => {
		await h.until(
			() =>
				allFrames !== null &&
				(retained && previous.length
					? usageReads > usageBefore
					: opened > openedBefore),
			`${scenario}: all frames must have ruby and finish presentation`,
		);
		const readable = performance.now() - started;
		await h.until(
			() => saved > savedBefore,
			`${scenario}: current reading position must be saved`,
		);
		measurements.push({
			scenario,
			firstFrameMs: firstFrame === null ? null : round(firstFrame),
			allFramesMs: allFrames === null ? null : round(allFrames),
			readableMs: round(readable),
			savedMs: round(performance.now() - started),
			requests: requestTimings.slice(requestIndex).map((timing) => ({
				method: timing.method,
				path: timing.path,
				startMs: round(timing.start - started),
				fixtureResponseMs: round(timing.end - timing.start),
			})),
			frameReused: frames().map((frame, index) => frame === previous[index]),
			documentReused: frames().map(
				(frame, index) => frame.contentDocument === documents[index],
			),
		});
	};
	const dispose = await h.mount(
		<TestRoutes />,
		"*",
		`/materials/${materialId}`,
	);
	try {
		await measure("cold open");
		const previous = frames();
		const documents = previous.map((frame) => frame.contentDocument);
		check(navigate, "Test route navigator must be ready");
		const go = navigate;
		go("/segments/saved");
		await h.until(
			() => !!h.container.querySelector(segmentSelector),
			"Segment route must mount",
		);
		if (retained) {
			check(
				previous.every(
					(frame, index) =>
						frame.isConnected && frame.contentDocument === documents[index],
				),
				"Paused reader must preserve every iframe and Document",
			);
			check(
				previous.every((frame) => frame.getClientRects().length === 0),
				"Paused reader must not remain visible on the Segment page",
			);
			const pausedViewport =
				h.container.querySelector<HTMLElement>(".reader-viewport");
			check(pausedViewport, "Paused viewport must remain mounted");
			const pausedScroll = [
				pausedViewport.scrollTop,
				pausedViewport.scrollLeft,
			];
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }),
			);
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
			);
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			);
			check(
				pausedViewport.scrollTop === pausedScroll[0] &&
					pausedViewport.scrollLeft === pausedScroll[1],
				"Background reader must ignore global keyboard navigation",
			);
			addedStudyRecord = true;
		}
		const requestIndex = requestTimings.length;
		const usageBefore = usageReads;
		const openedBefore = opened;
		const savedBefore = saved;
		started = performance.now();
		firstFrame = null;
		allFrames = null;
		go(`/materials/${materialId}?segment=saved`);
		await measure(
			"reader → segment → ?segment return",
			previous,
			documents,
			requestIndex,
			openedBefore,
			savedBefore,
			usageBefore,
		);
		if (retained) {
			check(
				frames().every(
					(frame, index) =>
						frame === previous[index] &&
						frame.contentDocument === documents[index],
				),
				`Returning to the same material must reuse all iframe and Document identities: ${JSON.stringify(measurements)}`,
			);
			const returnRequests = requestTimings.slice(requestIndex);
			check(
				!returnRequests.some(
					(item) =>
						item.path.endsWith("/readings") ||
						item.path === `/api/materials/${materialId}/chapters/${chapterId}`,
				),
				"Resuming must not reload chapter/readings payloads",
			);
			await h.until(() => {
				if (innerWidth <= 720 && !vertical) {
					const highlights =
						frames()[0]?.contentDocument?.defaultView?.CSS.highlights.get(
							"folio-study",
						);
					return !!highlights && highlights.size >= 1;
				}
				return (
					h.container.querySelectorAll(".reader-study-margin").length === 2
				);
			}, "Returning must refresh chapter study records created on the Segment page");
			check(
				returnRequests.some((item) => item.path.endsWith("/segments")) &&
					returnRequests.some((item) =>
						item.path.endsWith(`/chapters/${chapterId}/translations`),
					),
				"Returning must refresh both chapter segments and translations",
			);
		}
		const targetFrame = frames()[2];
		const targetDoc = targetFrame?.contentDocument;
		const targetLeaf = targetDoc?.querySelector(
			`[data-locator-leaf="${targetParagraph}"]`,
		);
		const viewport = h.container.querySelector<HTMLElement>(".reader-viewport");
		check(
			targetFrame && targetDoc && targetLeaf && viewport,
			"Original location must remain projectable in the third frame",
		);
		const projection = (await import("../src/materials/dom")).projectPart(
			targetDoc,
			paragraphs.slice(280).join(""),
			280,
		);
		check(
			projection.raw === paragraphs.slice(280).join(""),
			"Ruby must preserve canonical source text in the located frame",
		);
		const targetCoordinate = vertical
			? targetFrame.getBoundingClientRect().left +
				targetLeaf.getBoundingClientRect().left
			: targetFrame.getBoundingClientRect().top +
				targetLeaf.getBoundingClientRect().top;
		const viewStart = vertical
			? viewport.getBoundingClientRect().left
			: viewport.getBoundingClientRect().top;
		const viewEnd = vertical
			? viewport.getBoundingClientRect().right
			: viewport.getBoundingClientRect().bottom;
		check(
			targetCoordinate >= viewStart - 2 && targetCoordinate < viewEnd,
			`?segment must show exact original paragraph 350, coordinate=${targetCoordinate}, viewport=${viewStart}..${viewEnd}`,
		);
		if (retained && !preview) {
			const scrollBeforePlainReturn = vertical
				? viewport.scrollLeft
				: viewport.scrollTop;
			const plainReturnUsage = usageReads;
			go("/segments/saved");
			await h.until(
				() => !!h.container.querySelector(segmentSelector),
				"Plain return scenario must pause the reader",
			);
			go(`/materials/${materialId}`);
			await h.until(
				() =>
					usageReads > plainReturnUsage &&
					frames().length === 3 &&
					frames().every((frame) => !!frame.getClientRects().length),
				"Returning without a target must resume the same session",
			);
			check(
				frames().every(
					(frame, index) =>
						frame === previous[index] &&
						frame.contentDocument === documents[index],
				),
				"Plain return must reuse the same frames and documents",
			);
			await h.until(
				() =>
					Math.abs(
						(vertical ? viewport.scrollLeft : viewport.scrollTop) -
							scrollBeforePlainReturn,
					) < 2,
				"Returning without ?segment must preserve the prior reading position",
			);
			if (realApp) {
				const beforeForwardUsage = usageReads;
				go(-1);
				await h.until(
					() => !!h.container.querySelector(segmentSelector),
					"History back must reopen the actual Segment route",
				);
				check(
					previous.every(
						(frame, index) =>
							frame.isConnected &&
							frame.contentDocument === documents[index] &&
							frame.getClientRects().length === 0,
					),
					"History back must pause the same reader documents",
				);
				go(1);
				await h.until(
					() =>
						usageReads > beforeForwardUsage &&
						frames().length === 3 &&
						frames().every(
							(frame, index) =>
								frame === previous[index] &&
								frame.contentDocument === documents[index] &&
								!!frame.getClientRects().length,
						) &&
						Math.abs(
							(vertical ? viewport.scrollLeft : viewport.scrollTop) -
								scrollBeforePlainReturn,
						) < 2,
					"History forward must resume the same documents and reading position",
				);
			}
		}
		if (retained && !preview && !realApp) {
			go("/sources/source");
			await h.until(
				() => !!h.container.querySelector("[data-source-page]"),
				"Non-retained source route must mount",
			);
			await h.until(
				() => previous.every((frame) => !frame.isConnected),
				"Leaving the retained route family must evict the reader",
			);
			const evictionRequestIndex = requestTimings.length;
			go(`/materials/${materialId}`);
			await h.until(
				() =>
					frames().length === 3 &&
					frames().every(
						(frame, index) =>
							frame.contentDocument?.querySelector("ruby[data-auto-ruby]") &&
							frame !== previous[index],
					),
				"Returning after eviction must build fresh frames",
			);
			check(
				requestTimings
					.slice(evictionRequestIndex)
					.some((item) => item.path.endsWith("/readings/prepare")),
				"Evicted reader must use the normal opening preparation",
			);

			const beforeOtherMaterial = frames();
			go("/materials/other");
			await h.until(
				() =>
					frames().length === 3 &&
					frames().every(
						(frame, index) =>
							frame !== beforeOtherMaterial[index] &&
							!!frame.contentDocument?.querySelector("ruby[data-auto-ruby]"),
					),
				"A different material must replace the sole retained reading session",
			);
			check(
				beforeOtherMaterial.every((frame) => !frame.isConnected),
				"Opening a different material must dispose the previous session",
			);
			const beforeExpiry = frames();
			let expire: (() => void) | undefined;
			const setTimeoutOriginal = window.setTimeout;
			const dateNowOriginal = Date.now;
			window.setTimeout = ((
				callback: TimerHandler,
				delay?: number,
				...args: unknown[]
			) => {
				if (
					delay !== undefined &&
					delay >= 10 * 60 * 1000 - 1000 &&
					delay <= 10 * 60 * 1000 &&
					typeof callback === "function"
				)
					expire = () => callback(...args);
				return setTimeoutOriginal(callback, delay, ...args);
			}) as typeof window.setTimeout;
			try {
				go("/segments/saved");
				await h.until(
					() => !!h.container.querySelector(segmentSelector) && !!expire,
					"Pausing must schedule a bounded ten-minute expiry",
				);
				check(expire, "Retained reader must have an expiry callback");
				const future = Date.now() + 10 * 60 * 1000 + 1;
				Date.now = () => future;
				expire();
				await h.until(
					() => beforeExpiry.every((frame) => !frame.isConnected),
					"Expiry must dispose all paused iframe documents",
				);
			} finally {
				window.setTimeout = setTimeoutOriginal;
				Date.now = dateNowOriginal;
			}

			const openFresh = async () => {
				go("/sources/source");
				await h.until(
					() => !!h.container.querySelector("[data-source-page]"),
					"Reset route must dispose a failed session",
				);
				go(`/materials/${materialId}`);
				await h.until(
					() =>
						frames().length === 3 &&
						frames().every(
							(frame) =>
								!!frame.getClientRects().length &&
								!!frame.contentDocument?.querySelector("[data-locator-leaf]"),
						),
					"Fresh reader must present before validation regression",
				);
			};
			for (const failure of [
				"material missing",
				"invalid provenance",
			] as const) {
				await openFresh();
				const staleFrames = frames();
				go("/segments/saved");
				await h.until(
					() => !!h.container.querySelector(segmentSelector),
					"Failure scenario must pause on Segment route",
				);
				materialUnavailable = failure === "material missing";
				invalidProvenance = failure === "invalid provenance";
				let releaseMaterial: (() => void) | undefined;
				materialGate = new Promise<void>((resolve) => {
					releaseMaterial = resolve;
				});
				const beforeValidation = requestTimings.length;
				go(`/materials/${materialId}?segment=saved`);
				await h.until(
					() =>
						requestTimings
							.slice(beforeValidation)
							.some((item) => item.path === `/api/materials/${materialId}`),
					"Return must validate material before showing saved content",
				);
				check(
					staleFrames.every((frame) => frame.getClientRects().length === 0),
					"Return must conceal the old surface while validation is pending",
				);
				check(
					releaseMaterial,
					"Validation response must be controlled by this test",
				);
				releaseMaterial();
				materialGate = undefined;
				await h.until(
					() => !!h.container.querySelector(".reader-opening [role=alert]"),
					"Failed material/provenance validation must show the opening error",
				);
				check(
					frames().every((frame) => frame.getClientRects().length === 0),
					"Failed validation must not reveal stale reading content",
				);
				materialUnavailable = false;
				invalidProvenance = false;
			}
			await openFresh();
			const oldVersionFrames = frames();
			go("/segments/saved");
			await h.until(
				() => !!h.container.querySelector(segmentSelector),
				"Version regression must pause reader",
			);
			changedVersion = true;
			localStorage.setItem(
				`folio-reader-book-ui-v1:${materialId}:v2`,
				JSON.stringify({ rubyScope: "all" }),
			);
			go(`/materials/${materialId}`);
			await h.until(
				() =>
					frames().length === 3 &&
					frames().every(
						(frame, index) =>
							frame !== oldVersionFrames[index] &&
							!!frame.getClientRects().length &&
							!!frame.contentDocument?.querySelector("ruby[data-auto-ruby]"),
					),
				"A changed material version must reopen with fresh iframe documents",
			);
		}
		return `reader session (${retained ? "retained" : "baseline"}; 400 paragraphs, 3 iframes, 400 ruby tokens; offline fixture responses, real DOM clock; viewport ${innerWidth}x${innerHeight})\n${JSON.stringify(measurements, null, 2)}\n?segment exact paragraph 350 visible; canonical projection preserved`;
	} finally {
		observing = false;
		if (!preview) dispose();
	}
}
