import {
	DictionaryCards,
	type LookupLevel,
} from "../src/dictionary/DictionaryCards";
import type { DictionaryMatch } from "../src/dictionary/dictionary-api";
import { dictionaryPages } from "../src/dictionary/dictionary-pages";
import { dictionaryPassage } from "../src/dictionary/dictionary-passage";
import "../src/materials/reader-r1.css";
import "../src/dictionary/dictionary.css";
import type { BrowserHarness } from "./harness";

const surface = "食べさせられていなかった";
const description =
	"食べ〔未然形〕＋させ〔させる·未然形〕＋られ〔られる·连用形〕＋て＋い〔いる·未然形〕＋なかっ〔ない·连用形·促音便〕＋た";
const entry: DictionaryMatch = {
	id: "eat",
	dictionary_id: "synthetic",
	term: "食べる",
	reading: "たべる",
	start: 0,
	end: Array.from(surface).length,
	surface,
	inflection: [
		{ surface: "食べ", dictionary_form: "食べる", form: "irrealis" },
		{ surface: "させ", dictionary_form: "させる", form: "irrealis" },
		{ surface: "られ", dictionary_form: "られる", form: "continuative" },
		{ surface: "て", dictionary_form: "て" },
		{ surface: "い", dictionary_form: "いる", form: "irrealis" },
		{
			surface: "なかっ",
			dictionary_form: "ない",
			form: "continuative",
			sound_change: "促音便",
		},
		{ surface: "た", dictionary_form: "た" },
	],
	definitions: [
		...Array.from({ length: 14 }, (_, i) => ({
			tag: "p" as const,
			lang: "ja" as const,
			text: `${i + 1} 食べ物を口に入れて、かんで飲み込む。長い説明も最後まで読める。`,
		})),
		{ tag: "p", lang: "ja", text: "释义末尾：最後の説明。" },
	],
};

function level(id: number, entries: DictionaryMatch[] = [entry]): LookupLevel {
	return {
		id,
		origin: {
			input: { text: surface, position: 0 },
			anchor: { left: 260, right: 280, top: 90, bottom: 112 },
		},
		pages: dictionaryPages(entries),
		index: 0,
		pending: false,
		message: "",
	};
}

/** Real card/CSS with trusted dragging and actual viewport resize delivery. */
export async function dictionaryInflectionLayout(h: BrowserHarness) {
	const check: BrowserHarness["check"] = h.check;
	const { browserPointer: pointer, browserResize: resize } =
		window as Window & {
			browserPointer?: (events: unknown[]) => Promise<void>;
			browserResize?: (width: number, height: number) => Promise<void>;
		};
	check(
		pointer && resize,
		"Runner must provide native pointer and viewport resize",
	);
	const passageFixture = document.createElement("div");
	passageFixture.style.cssText =
		"position:fixed;inset:0;z-index:9999;background:white;font-size:20px;line-height:2;";
	passageFixture.innerHTML =
		'<section lang="ja">前文。</section><section lang="ja"><span>😀か</span><b>\u3099猫</b><ruby>歩<rt>ある</rt></ruby>く。</section><section lang="ja">後文。</section><p><span>猫</span><a href="#">犬</a><span>鳥</span></p><p lang="zh">中文</p><p>Latin</p><pre lang="ja">前文。\n猫が歩く。\u2028後文。</pre><section class="loanword" lang="ja">コーヒー</section><section class="halfwidth" lang="ja">ｺｰﾋｰ</section>';
	document.body.append(passageFixture);
	try {
		const hit = (selector: string, start = 0, end = start + 1) => {
			const element = passageFixture.querySelector(selector);
			check(element?.firstChild, "Passage fixture must contain target text");
			const range = document.createRange();
			range.setStart(element.firstChild, start);
			range.setEnd(element.firstChild, end);
			const rect = range.getBoundingClientRect();
			return dictionaryPassage(
				passageFixture,
				rect.left + rect.width / 2,
				rect.top + rect.height / 2,
			);
		};
		const canonical = hit("b", 1);
		check(
			canonical?.text === "😀が猫歩く。" && canonical.offset === 2,
			"Block-local lookup must normalize NFC and count supplementary characters as one code point",
		);
		check(
			canonical.range(1, 2)?.toString() === "か\u3099",
			"Canonical response ranges must restore decomposed inline DOM text across nodes",
		);
		check(
			hit("p span")?.text === "猫" && hit("p span:last-child")?.text === "鳥",
			"Interactive nodes must split lookup windows without inventing adjacent text",
		);
		check(
			hit("a") === null &&
				hit('[lang="zh"]') === null &&
				hit("p:last-of-type") === null,
			"Links, explicitly Chinese text and Latin glyphs must not trigger lookup",
		);
		const line = hit("pre", 4);
		check(
			line?.text === "猫が歩く。" && line.offset === 0,
			"Raw and Unicode line breaks must stop the lookup window inside one block",
		);
		check(
			hit(".loanword", 1)?.text === "コーヒー" &&
				hit(".loanword", 1)?.offset === 1 &&
				hit(".halfwidth", 1)?.text === "ｺｰﾋｰ",
			"Shared Japanese marks must permit lookup on fullwidth and halfwidth prolonged sound marks",
		);
	} finally {
		passageFixture.remove();
	}
	const initial = { width: innerWidth, height: innerHeight };
	let dispose = () => {};
	const mount = async (levels: LookupLevel[]) => {
		dispose();
		dispose = await h.mount(
			<div className="reader-r1" data-theme="light">
				<DictionaryCards
					levels={levels}
					behindPanel={false}
					mode="click"
					opacity={72}
					title="合成测试词典"
					nested={() => {}}
					choose={() => {}}
					backTo={() => {}}
					close={() => {}}
					onRecord={() => {}}
				/>
			</div>,
		);
		await h.until(
			() => h.container.querySelectorAll(".dict-card").length === levels.length,
			"Dictionary cards must mount",
		);
		await new Promise((resolve) => setTimeout(resolve, 160));
	};
	const element = <T extends HTMLElement>(selector: string): T => {
		const found = h.container.querySelector<T>(selector);
		check(found, `Missing ${selector}`);
		return found;
	};
	const visible = (node: Element) => {
		const box = node.getBoundingClientRect();
		return box.width > 0 && box.height > 0;
	};
	const checkReachable = async (scroll: HTMLElement, target: Element) => {
		const range = document.createRange();
		range.selectNodeContents(target);
		const lines = [...range.getClientRects()];
		const origin = scroll.getBoundingClientRect().top - scroll.scrollTop;
		check(lines.length > 0, "Content must have rendered text lines");
		for (const [index, line] of lines.entries()) {
			const relative = line.top - origin;
			scroll.scrollTop = Math.max(0, relative - 1);
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
			const current = [...range.getClientRects()][index];
			const viewport = scroll.getBoundingClientRect();
			check(
				current &&
					current.top >= viewport.top - 1 &&
					current.bottom <= viewport.bottom + 1,
				`Every text line must be reachable inside the scroll viewport: ${JSON.stringify({ current: current?.toJSON(), viewport: viewport.toJSON() })}`,
			);
		}
	};
	try {
		await resize(1280, 900);
		await mount([level(1)]);
		const card = element<HTMLElement>(".dict-card");
		const header = element<HTMLElement>(".dict-card-head");
		const before = card.getBoundingClientRect();
		const head = header.getBoundingClientRect();
		const x = head.left + 28,
			y = head.top + 19;
		check(
			header.contains(document.elementFromPoint(x, y)),
			"Drag starts on visible header",
		);
		await pointer([
			{ type: "mouseMoved", x, y },
			{ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
			{ type: "mouseMoved", x, y: y + 350, button: "left", buttons: 1 },
			{
				type: "mouseReleased",
				x,
				y: y + 350,
				button: "left",
				buttons: 0,
				clickCount: 1,
			},
		]);
		await h.until(
			() => card.getBoundingClientRect().top > before.top + 300,
			"Trusted drag must move the card down",
		);
		await resize(1280, 320);
		await h.until(
			() => innerHeight === 320 && card.getBoundingClientRect().bottom <= 320,
			"Resized card must fit the short viewport",
		);
		const scroll = element<HTMLElement>(".dict-scroll");
		check(
			scroll.clientHeight > 20,
			`Dragging then shrinking must leave a readable scroll viewport; got ${scroll.clientHeight}px`,
		);
		const inflection = element<HTMLElement>(".dict-inflection");
		check(
			inflection.textContent === description,
			"Single entry must retain every inflection component",
		);
		await checkReachable(scroll, inflection);
		const last = element<HTMLElement>(".dict-definitions p:last-child");
		check(
			last.textContent?.startsWith("释义末尾"),
			"Long definition fixture must retain its tail",
		);
		await checkReachable(scroll, last);
		check(
			scroll.scrollTop > 0,
			"Reaching the last definition must scroll the squeezed card",
		);

		await resize(1280, 900);
		const second: DictionaryMatch = {
			...entry,
			id: "second-eat",
			term: "喰べる",
			inflection: [{ surface, dictionary_form: "喰べる", form: "attributive" }],
		};
		await mount([
			level(2, [entry, second, { ...entry, id: "plain-eat", inflection: [] }]),
		]);
		const sections = [
			...h.container.querySelectorAll<HTMLElement>(".dict-entry"),
		];
		check(sections.length === 3, "Same-range entries must stay independent");
		check(
			sections[0]?.querySelector(".dict-inflection")?.textContent ===
				description,
			"First entry keeps its own long explanation",
		);
		check(
			sections[1]?.querySelector(".dict-inflection")?.textContent ===
				`${surface}〔连体形〕`,
			"Second entry keeps its own evidence",
		);
		check(
			!sections[2]?.querySelector(".dict-inflection"),
			"An entry without evidence must not reserve a line",
		);

		await resize(390, 900);
		await mount([level(3), level(4)]);
		const parent = element<HTMLElement>('.dict-card[data-depth="0"]');
		const child = element<HTMLElement>('.dict-card[data-depth="1"]');
		const parentInflection = parent.querySelector(".dict-inflection");
		check(
			parentInflection && !visible(parentInflection),
			"Collapsed narrow parent must hide its inflection",
		);
		check(
			visible(element(".dict-parent-line")) &&
				visible(element(".dict-card h2")),
			"Collapsed parent must retain its title and source excerpt",
		);
		const childInflection = child.querySelector(".dict-inflection");
		check(
			childInflection && visible(childInflection),
			"Foreground narrow card must show its inflection",
		);
		return "dictionary inflection: trusted 350px drag + 1280×320 resize retain scrollable explanation/definition; separate entry evidence; collapsed narrow parent hides explanation";
	} finally {
		dispose();
		await resize(initial.width, initial.height);
	}
}
