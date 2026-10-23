import type { Chapter, ReadingsResponse, Settings } from "../src/materials/api";
import { snapshotReaderFrameTargets } from "../src/materials/focus";
import { DEFAULT_BOOK_UI } from "../src/materials/preferences";
import { partDocument, ReaderFrames } from "../src/materials/reader-frames";

function check(value: unknown, message: string): asserts value {
	if (!value) throw new Error(`reader clipboard: ${message}`);
}

/** Synthetic copy events exercise the real iframe binding, not the system clipboard. */
export async function readerClipboard(preview = false) {
	const text = "前漢字。\n東京へ。\n後。";
	const html =
		'<p><span data-locator-leaf="0">前</span><ruby><span data-locator-leaf="1">漢字</span><rp>（</rp><rt>かんじ</rt><rp>）</rp></ruby><span data-locator-leaf="2">。</span></p><span data-locator-leaf="3">\n</span><p><span data-locator-leaf="4">東京へ。</span></p><span data-locator-leaf="5">\n</span><p><span data-locator-leaf="6">後。</span></p>';
	const chapter: Chapter = {
		id: "clipboard",
		material_id: "clipboard",
		version_id: "v1",
		title: "copy",
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
				html,
				leaf_start: 0,
				leaf_end: 7,
			},
		],
	};
	const readings: ReadingsResponse = {
		material_id: "clipboard",
		version_id: "v1",
		generation_id: "g1",
		resources: [
			{
				resource_id: "r",
				text_sha256: "a".repeat(64),
				tokens: [
					{
						start: 5,
						end: 7,
						surface: "東京",
						reading: "トウキョウ",
						dictionary_form: "東京",
						normalized_form: "東京",
						pos: [],
						is_oov: false,
					},
				],
			},
		],
	};
	for (const writing_mode of ["horizontal-tb", "vertical-rl"] as const) {
		const settings: Settings = {
			font_size: 20,
			line_height: 1.8,
			writing_mode,
		};
		const host = document.createElement("div");
		host.style.cssText = "width:400px;height:320px;overflow:auto";
		const panel = preview ? document.createElement("section") : document.body;
		if (preview) {
			panel.style.cssText =
				"display:inline-block;vertical-align:top;margin:16px";
			const title = document.createElement("h2");
			title.textContent =
				writing_mode === "horizontal-tb" ? "横排复制" : "竖排复制";
			panel.append(title);
			document.body.append(panel);
		}
		const iframe = document.createElement("iframe");
		iframe.setAttribute("sandbox", "allow-same-origin");
		host.append(iframe);
		panel.append(host);
		const frames = new ReaderFrames();
		try {
			const part = chapter.parts[0],
				resource = chapter.resources[0];
			check(part && resource, "missing fixture resource");
			await new Promise<void>((resolve) => {
				iframe.onload = () => resolve();
				iframe.srcdoc = partDocument(part, resource, settings);
			});
			frames.register(0, iframe);
			frames.load(0, iframe, 1, {
				chapter,
				readingGeneration: "g1",
				readings,
				current: () => ({ settings, theme: "white", bookUi: DEFAULT_BOOK_UI }),
				generation: () => 1,
				root: () => host,
				bindFocus: (doc) => {
					snapshotReaderFrameTargets(doc);
					return undefined;
				},
				key: () => {},
				wheel: () => {},
				touch: () => {},
				image: () => {},
				ready: () => {},
				error: (error) => {
					throw error;
				},
			});
			const frame = frames.get(0);
			check(frame, "ReaderFrames.load did not create the frame");
			const { doc } = frame;
			const selection = doc.getSelection();
			check(selection, "missing native selection");
			const node = (selector: string) => {
				const found = doc.querySelector(selector)?.firstChild;
				check(found?.nodeType === Node.TEXT_NODE, `missing text ${selector}`);
				return found as Text;
			};
			const select = (
				anchor: Node,
				start: number,
				focus = anchor,
				end = anchor.textContent?.length ?? 0,
			) => selection.setBaseAndExtent(anchor, start, focus, end);
			const copy = (
				expected: string,
				prevented = true,
				target: EventTarget = doc,
			) => {
				const before = [
					selection.anchorNode,
					selection.anchorOffset,
					selection.focusNode,
					selection.focusOffset,
				];
				const markup = doc.body.innerHTML;
				const data = new DataTransfer();
				data.setData("text/html", "<b>native-format</b>");
				const event = new ClipboardEvent("copy", {
					bubbles: true,
					cancelable: true,
					clipboardData: data,
				});
				target.dispatchEvent(event);
				check(
					event.defaultPrevented === prevented,
					`${writing_mode}: copy default handling for ${JSON.stringify(expected)}`,
				);
				check(
					data.getData("text/plain") === expected,
					`${writing_mode}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(data.getData("text/plain"))}`,
				);
				if (prevented && expected)
					check(!data.getData("text/html"), "copy retained HTML");
				check(doc.body.innerHTML === markup, "copy mutated DOM");
				check(
					before.every(
						(value, index) =>
							value ===
							[
								selection.anchorNode,
								selection.anchorOffset,
								selection.focusNode,
								selection.focusOffset,
							][index],
					),
					"copy mutated selection or direction",
				);
			};
			const first = node('[data-locator-leaf="0"]'),
				base = node('[data-locator-leaf="1"]'),
				rt = node("ruby rt"),
				last = node('[data-locator-leaf="6"]');
			select(first, 0, last, last.length);
			copy(text); // Original ruby and rp must never leak into plain text.
			select(base, 1, base, 2);
			copy("字");
			select(base, 2, base, 0);
			copy("漢字");
			select(first, 0, rt, rt.length);
			copy("前漢字");
			select(rt, 1, last, last.length);
			copy("。\n東京へ。\n後。");
			select(rt, 0);
			copy("");
			select(node("ruby rp"), 0);
			copy("");
			selection.removeAllRanges();
			copy("", false);
			select(base, 1, base, 1);
			copy("", false);
			for (const ruby of ["show", "hide", "on-demand"] as const) {
				frames.update(
					chapter,
					settings,
					"white",
					{ ...DEFAULT_BOOK_UI, rubyScope: "all", ruby },
					readings,
				);
				const automatic = node("ruby[data-auto-ruby]");
				select(automatic, 1, automatic, 2);
				copy("京"); // Uses the projection refreshed by ReaderFrames.update.
				select(automatic, 2, automatic, 0);
				copy("東京");
				const all = doc.createRange();
				all.selectNodeContents(doc.body);
				selection.removeAllRanges();
				selection.addRange(all);
				copy(text); // Element boundaries used by native Select All.
			}
			const extension = doc.createElement("textarea");
			doc.body.append(extension);
			copy("", false, extension);
			extension.remove();
			frames.clear();
			copy("", false);
			if (preview) {
				frames.load(0, iframe, 1, {
					chapter,
					readingGeneration: "g1",
					readings,
					current: () => ({
						settings,
						theme: "white",
						bookUi: { ...DEFAULT_BOOK_UI, rubyScope: "all" },
					}),
					generation: () => 1,
					root: () => host,
					bindFocus: () => undefined,
					key: () => {},
					wheel: () => {},
					touch: () => {},
					image: () => {},
					ready: () => {},
					error: (error) => {
						throw error;
					},
				});
				const paste = document.createElement("textarea");
				paste.placeholder = `${writing_mode}: paste here`;
				paste.rows = 4;
				paste.style.cssText = "display:block;width:400px;margin-top:12px";
				panel.append(paste);
			}
		} finally {
			if (!preview) {
				frames.clear();
				host.remove();
			}
		}
	}
	return "reader clipboard: real ReaderFrames copy binding; original/automatic ruby, partial/reverse/annotation/Select All, horizontal/vertical, cleanup; synthetic clipboard data";
}
