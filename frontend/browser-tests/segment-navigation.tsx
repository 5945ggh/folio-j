import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import {
	readerSessionFixture as fixture,
	readerSessionFixtureData,
} from "./reader-session-fixture";

type Schema = components["schemas"];

/** Real Segment entry, retained return and interleaved requests share one exact DOM oracle. */
export async function segmentNavigation(h: BrowserHarness) {
	const check: BrowserHarness["check"] = h.check;
	const { App, appRoutes } = await import("../src/App");
	const { book, chapter, paragraphs, startAt, targetText, timestamp } = fixture;
	const vertical =
		new URLSearchParams(location.search).get("direction") === "vertical-rl";
	const deferredChapter = {
		...chapter,
		id: "delayed-chapter",
		title: "延迟目标章",
	};
	let navigate: ReturnType<typeof useNavigate> | undefined;
	let client: ReturnType<typeof useQueryClient> | undefined;
	function Navigator() {
		const routeNavigate = useNavigate();
		client = useQueryClient();
		useEffect(() => {
			navigate = routeNavigate;
		}, [routeNavigate]);
		return null;
	}
	localStorage.clear();
	localStorage.setItem(
		"folio-reader-ui-v1",
		JSON.stringify({
			focus: false,
			marks: { studySegmentUnderlines: false, studySegmentMargins: false },
		}),
	);
	localStorage.setItem(
		`folio-reader-book-ui-v1:${book.id}:${book.version_id}`,
		JSON.stringify({ rubyScope: "all" }),
	);
	let position: Schema["ReadingPositionResponse"] | null = book.reading_position
		? {
				...book.reading_position,
				settings: {
					font_size: 22,
					line_height: 2,
					...book.reading_position.settings,
					writing_mode: vertical
						? ("vertical-rl" as const)
						: ("horizontal-tb" as const),
				},
			}
		: null;
	let originChapter = chapter.id;
	let chapterGate: Promise<void> | undefined;
	let releaseChapter: (() => void) | undefined;
	let delayedRequests = 0;
	let segmentReads = 0;
	const searchParagraph = 370;
	const searchText = paragraphs[searchParagraph] ?? "";
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/api/segments/saved") segmentReads++;
		let data = readerSessionFixtureData(path, {
			originChapter,
			studyRecords: false,
		});
		if (path === `/api/materials/${book.id}` && request.method === "GET")
			data = {
				...book,
				reading_position: position,
				chapters: [
					...book.chapters,
					{
						id: deferredChapter.id,
						title: deferredChapter.title,
						level: 0,
						part_count: 3,
					},
				],
			} satisfies Schema["MaterialResponse"];
		else if (path.endsWith(`/chapters/${deferredChapter.id}`)) {
			delayedRequests++;
			await chapterGate;
			data = deferredChapter;
		} else if (path.endsWith("/reading-position") && request.method === "PUT") {
			const update: Schema["ReadingPositionUpdate"] = await request.json();
			position = {
				...update,
				revision: update.expected_revision + 1,
				progress: 0,
				updated_at: timestamp,
			} satisfies Schema["ReadingPositionResponse"];
			data = position;
		} else if (path.endsWith("/search"))
			data = {
				material_id: book.id,
				version_id: book.version_id,
				query: searchText,
				total: 1,
				offset: 0,
				limit: 40,
				items: [
					{
						chapter_id: deferredChapter.id,
						chapter_title: deferredChapter.title,
						part_index: 2,
						resource_id: "r",
						spine_index: 0,
						start: startAt(searchParagraph),
						end: startAt(searchParagraph) + searchText.length,
						match: searchText,
						before: "",
						after: "",
					},
				],
			} satisfies Schema["MaterialSearchResponse"];
		else if (data === undefined)
			throw new Error(
				`Unmocked Segment navigation request ${request.method} ${path}`,
			);
		return Response.json(data);
	});
	const frames = () => [
		...h.container.querySelectorAll<HTMLIFrameElement>("iframe.material-part"),
	];
	const highlights = () =>
		frames().flatMap((frame) => {
			const ranges =
				frame.contentDocument?.defaultView?.CSS.highlights.get("folio-search");
			return ranges ? [...ranges].map((range) => ({ frame, range })) : [];
		});
	const assertExact = async (expected: string, label: string) => {
		await h.until(
			() =>
				highlights()
					.map(({ range }) => range.toString())
					.join("") === expected,
			`${label}: actual CSS Highlight must contain only the exact accepted source`,
		);
		const mark = highlights()[0];
		const doc = mark?.frame.contentDocument;
		const leaf = mark?.range.startContainer.parentElement;
		check(
			mark && doc?.defaultView && leaf,
			`${label}: highlight must bind real source DOM`,
		);
		check(
			doc.defaultView.getComputedStyle(doc.body).writingMode ===
				(vertical ? "vertical-rl" : "horizontal-tb"),
			`${label}: actual source must use the requested writing direction`,
		);
		const color = doc.defaultView.getComputedStyle(
			leaf,
			"::highlight(folio-search)",
		).backgroundColor;
		check(
			color !== "rgba(0, 0, 0, 0)" && color !== "transparent",
			`${label}: exact range must have a visible background (${color})`,
		);
		const root = h.container.querySelector<HTMLElement>(".reader-viewport");
		check(root, `${label}: reading viewport must exist`);
		const sourceRange = doc.createRange();
		sourceRange.setStart(mark.range.startContainer, mark.range.startOffset);
		sourceRange.setEnd(mark.range.endContainer, mark.range.endOffset);
		const rect = sourceRange.getBoundingClientRect();
		const frameRect = mark.frame.getBoundingClientRect();
		const viewport = root.getBoundingClientRect();
		check(
			vertical
				? frameRect.left + rect.right > viewport.left &&
						frameRect.left + rect.left < viewport.right
				: frameRect.top + rect.bottom > viewport.top &&
						frameRect.top + rect.top < viewport.bottom,
			`${label}: accepted range must be in the actual reading viewport`,
		);
		check(
			frames().every(
				(frame) =>
					!frame.contentDocument?.defaultView?.CSS.highlights.has(
						"folio-study",
					),
			),
			`${label}: temporary feedback must work with permanent underlines disabled`,
		);
	};
	const returnFromSegment = async () => {
		await h.until(
			() =>
				!!h.container.querySelector<HTMLAnchorElement>(
					"a.segment-material-origin-link",
				),
			"Actual Segment page must verify provenance and expose its return link",
		);
		h.container
			.querySelector<HTMLAnchorElement>("a.segment-material-origin-link")
			?.click();
	};
	const dispose = await h.mount(
		<>
			<Navigator />
			<App />
		</>,
		"/",
		"/segments/saved",
		appRoutes,
	);
	try {
		await returnFromSegment();
		await assertExact(targetText, "Cold Segment return");
		const previous = frames();
		const documents = previous.map((frame) => frame.contentDocument);
		await h.until(
			() => !highlights().length,
			"Cold return feedback must clear actual CSS ranges",
		);
		check(
			navigate && client,
			"Production router and query cache must be available",
		);
		const go = navigate;
		const readsBefore = segmentReads;
		go("/segments/saved");
		await h.until(
			() =>
				segmentReads > readsBefore &&
				!!h.container.querySelector(".segment-workspace"),
			"Actual Segment page must reopen while preserving the reader",
		);
		await returnFromSegment();
		await assertExact(targetText, "Retained Segment return");
		check(
			frames().every(
				(frame, index) =>
					frame === previous[index] &&
					frame.contentDocument === documents[index],
			),
			"Retained return must preserve all iframe and Document identities",
		);
		await h.until(
			() => !highlights().length,
			"Retained return feedback must clear actual CSS ranges",
		);

		// Only the target chapter response is gated: no real-time race or artificial clock is required.
		originChapter = deferredChapter.id;
		chapterGate = new Promise<void>((resolve) => {
			releaseChapter = resolve;
		});
		client.removeQueries({
			queryKey: ["segments", "saved", "material-provenance"],
			exact: true,
		});
		const overlapReadsBefore = segmentReads;
		go("/segments/saved");
		await h.until(
			() =>
				segmentReads > overlapReadsBefore &&
				!!h.container.querySelector(".segment-workspace"),
			"Replacement scenario must reopen the actual Segment page",
		);
		await returnFromSegment();
		await h.until(
			() => delayedRequests > 0,
			"Returned Segment target must await the controlled chapter response",
		);
		const toc = h.container.querySelector<HTMLButtonElement>(
			'button[aria-label="目录"]',
		);
		check(
			toc,
			"Retained reader must expose navigation while the target chapter is pending",
		);
		toc.click();
		await h.until(
			() => !!h.container.querySelector('button[data-tab="search"]'),
			"Navigation search tab must mount",
		);
		h.container
			.querySelector<HTMLButtonElement>('button[data-tab="search"]')
			?.click();
		const search = h.container.querySelector<HTMLInputElement>(
			'input[placeholder="搜索本书原文…"]',
		);
		check(search, "Actual search input must mount");
		h.inputValue(search, searchText);
		await h.until(
			() => !!h.container.querySelector("button.reader-query-hit"),
			"Search must return the newer same-chapter target",
		);
		h.container
			.querySelector<HTMLButtonElement>("button.reader-query-hit")
			?.click();
		check(releaseChapter, "Test must own the outstanding chapter response");
		releaseChapter();
		await assertExact(searchText, "Newer same-chapter search target");
		check(
			!highlights().some(({ range }) => range.toString().includes(targetText)),
			"Cancelled Segment range must not override the accepted search target",
		);
		return `Segment navigation ${vertical ? "vertical" : "horizontal"}: actual Segment cold/retained return, exact visible CSS ranges with underlines off, expiry, iframe identity and gated same-chapter replacement`;
	} finally {
		releaseChapter?.();
		dispose();
	}
}
