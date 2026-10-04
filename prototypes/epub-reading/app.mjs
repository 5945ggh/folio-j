import { captureRange, restoreRange, projection } from "./locator.mjs";
const $ = (id) => document.getElementById(id);
let book, resource;
const status = (message, error = false) => {
	$("status").textContent = message;
	$("status").classList.toggle("error", error);
};
function safeBody(html) {
	const parsed = new DOMParser().parseFromString(html, "text/html");
	for (const el of parsed.querySelectorAll(
		"script,style,link,meta,base,iframe,object,embed,form,input,button,textarea,select,svg,math",
	))
		el.remove();
	for (const el of parsed.body.querySelectorAll("*"))
		for (const attr of [...el.attributes]) {
			if (
				attr.name.startsWith("on") ||
				["href", "srcset", "action", "formaction", "style"].includes(attr.name)
			)
				el.removeAttribute(attr.name);
			if (
				attr.name === "src" &&
				!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(attr.value)
			)
				el.removeAttribute("src");
		}
	return parsed.body;
}
function display() {
	const frame = $("frame");
	frame.onload = () => {
		try {
			const doc = frame.contentDocument;
			for (const [target, attrs] of [
				[doc.documentElement, resource.htmlAttributes],
				[doc.body, resource.bodyAttributes],
			]) {
				for (const [name, value] of Object.entries(attrs || {}))
					if (
						["class", "dir", "lang"].includes(name) &&
						typeof value === "string"
					)
						target.setAttribute(name, value);
			}
			doc.body.append(
				...[...safeBody(resource.html).childNodes].map((n) =>
					doc.importNode(n, true),
				),
			);
			const author = doc.createElement("style");
			author.id = "author-style";
			author.textContent = resource.css || "";
			doc.head.append(author);
			const controls = doc.createElement("style");
			controls.id = "reading-controls";
			doc.head.append(controls);
			applyLayout();
			projection(doc, resource.text);
			status(
				`已加载 ${resource.title || resource.href} · ${[...resource.text].length} 码点。划选正文以验证定位。`,
			);
		} catch (e) {
			status(e.message, true);
		}
	};
	frame.srcdoc =
		"<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'\"></head><body></body></html>";
}
function applyLayout() {
	const doc = $("frame").contentDocument;
	if (!doc?.getElementById("reading-controls")) return;
	doc.getElementById("author-style").disabled = !$("author").checked;
	doc.getElementById("reading-controls").textContent =
		`html{height:100%;overflow:auto}body{margin:0;padding:35px;box-sizing:border-box;min-height:100%;font-size:${$("size").value}px!important;line-height:1.9!important;writing-mode:${$("layout").value}!important;color:#283c35;background:#fffdf7}img{max-width:90vw;max-height:70vh}rt{font-size:0.55em}::selection{background:#cadcbb}`;
	$("sizeValue").textContent = $("size").value;
}
function load(data) {
	if (
		data.contract !== "epub-spike-v1" ||
		typeof data.materialVersion !== "string" ||
		!Array.isArray(data.resources) ||
		!data.resources.length
	)
		throw new Error("不是有效的 epub-spike-v1 材料");
	for (const r of data.resources)
		if (
			typeof r.id !== "string" ||
			typeof r.text !== "string" ||
			typeof r.html !== "string" ||
			r.text !== r.text.normalize("NFC")
		)
			throw new Error("资源正文契约无效");
	book = data;
	$("bookTitle").textContent = data.title;
	$("warnings").textContent = (data.warnings || []).join("\n");
	$("chapters").replaceChildren();
	data.resources.forEach((r, i) => {
		const b = document.createElement("button");
		b.textContent = `${i + 1}. ${r.title || r.href}`;
		b.onclick = () => {
			resource = r;
			for (const sibling of b.parentElement.children)
				sibling.classList.toggle("active", sibling === b);
			display();
		};
		$("chapters").append(b);
	});
	$("chapters").firstChild.click();
}
$("file").onchange = async () => {
	try {
		load(JSON.parse(await $("file").files[0].text()));
	} catch (e) {
		status(e.message, true);
	}
};
$("books").onchange = async () => {
	try {
		if (!$("books").value) return;
		const response = await fetch($("books").value);
		if (!response.ok) throw new Error("样书读取失败");
		load(await response.json());
	} catch (e) {
		status(e.message, true);
	}
};
for (const id of ["layout", "author", "size"]) $(id).oninput = applyLayout;
$("capture").onclick = () => {
	try {
		if (!resource) throw new Error("请先加载材料");
		const doc = $("frame").contentDocument;
		const selection = doc.getSelection();
		if (!selection.rangeCount || selection.isCollapsed)
			throw new Error("请在正文中划选文字");
		const q = captureRange(doc, selection.getRangeAt(0), book, resource);
		$("quote").value = JSON.stringify(q, null, 2);
		status(
			`已捕获 [${q.start}, ${q.end}) · ${q.end - q.start} 码点：${q.exact}`,
		);
	} catch (e) {
		status(e.message, true);
	}
};
$("restore").onclick = () => {
	try {
		if (!resource) throw new Error("请先加载材料");
		const q = JSON.parse($("quote").value);
		const doc = $("frame").contentDocument;
		const range = restoreRange(doc, q, book, resource);
		const selection = doc.getSelection();
		selection.removeAllRanges();
		selection.addRange(range);
		range.startContainer.parentElement.scrollIntoView({
			block: "center",
			inline: "center",
		});
		status(
			`已校验版本、资源、快照和 DOM，还原 [${q.start}, ${q.end})：${q.exact}`,
		);
	} catch (e) {
		status(e.message, true);
	}
};
async function samples() {
	try {
		const response = await fetch("./books/index.json");
		if (!response.ok) return;
		const data = await response.json();
		for (const item of Array.isArray(data) ? data : data.books || []) {
			const option = document.createElement("option");
			option.value = item.path;
			option.textContent = item.title;
			$("books").append(option);
		}
	} catch {
		/* local JSON remains available */
	}
}
samples();
$("selftest").onclick = async () => {
	const output = [];
	const test = (name, fn) => {
		try {
			fn();
			output.push(`✓ ${name}`);
		} catch (e) {
			output.push(`✗ ${name}：${e.message}`);
		}
	};
	const iframe = document.createElement("iframe");
	iframe.sandbox = "allow-same-origin";
	iframe.style.cssText =
		"position:absolute;left:-10000px;width:800px;height:500px";
	document.body.append(iframe);
	await new Promise((resolve) => {
		iframe.onload = resolve;
		iframe.srcdoc = '<!doctype html><meta charset="utf-8"><body></body>';
	});
	const doc = iframe.contentDocument;
	doc.body.innerHTML = `<p><ruby><span data-locator-leaf="0">日本</span><rt>にほん</rt></ruby><span data-locator-leaf="1">😀</span><span data-locator-leaf="2">か</span><span data-locator-leaf="3">゙</span><span data-locator-leaf="4">同じ同じ</span></p>`;
	const b = { materialVersion: "test-v1" },
		r = { id: "test", text: "日本😀が同じ同じ" };
	const leaves = [...doc.querySelectorAll("[data-locator-leaf]")];
	const range = (i, a, j, z) => {
		const x = doc.createRange();
		x.setStart(leaves[i].firstChild, a);
		x.setEnd(leaves[j].firstChild, z);
		return x;
	};
	const assert = (x) => {
		if (!x) throw new Error("断言失败");
	};
	const rejects = (fn) => {
		let failed = false;
		try {
			fn();
		} catch {
			failed = true;
		}
		assert(failed);
	};
	test("ruby base 计入正文，读音排除", () =>
		assert(captureRange(doc, range(0, 0, 0, 2), b, r).exact === "日本"));
	test("emoji UTF-16 → 单码点", () => {
		const q = captureRange(doc, range(1, 0, 1, 2), b, r);
		assert(q.start === 2 && q.end === 3);
		rejects(() => captureRange(doc, range(1, 0, 1, 1), b, r));
	});
	test("跨节点 NFC 完整组合及内部边界拒绝", () => {
		assert(captureRange(doc, range(2, 0, 3, 1), b, r).exact === "が");
		rejects(() => captureRange(doc, range(2, 0, 2, 1), b, r));
	});
	const q = captureRange(doc, range(4, 2, 4, 4), b, r);
	test("重复文字按原位置还原", () => {
		const x = restoreRange(doc, q, b, r);
		assert(x.startContainer === leaves[4].firstChild && x.startOffset === 2);
	});
	test("字号与横竖排变化后往返", () => {
		doc.body.style.fontSize = "30px";
		doc.body.style.writingMode = "vertical-rl";
		assert(
			captureRange(doc, restoreRange(doc, q, b, r), b, r).start === q.start,
		);
	});
	test("版本失配拒绝", () =>
		rejects(() => restoreRange(doc, { ...q, materialVersion: "wrong" }, b, r)));
	test("资源失配拒绝", () =>
		rejects(() => restoreRange(doc, { ...q, resourceId: "wrong" }, b, r)));
	test("原文快照失配拒绝", () =>
		rejects(() => restoreRange(doc, { ...q, exact: "错误" }, b, r)));
	test("正文投影失配拒绝", () =>
		rejects(() => restoreRange(doc, q, b, { ...r, text: r.text + "x" })));
	test("作者 CSS 隐藏正文拒绝", () => {
		leaves[4].style.display = "none";
		rejects(() => restoreRange(doc, q, b, r));
	});
	test("重复正文叶子交换后拒绝", () => {
		doc.body.innerHTML =
			'<p><span data-locator-leaf="0">同じ</span><span data-locator-leaf="1">同じ</span></p>';
		const repeat = { id: "repeat", text: "同じ同じ" };
		const nodes = [...doc.querySelectorAll("[data-locator-leaf]")];
		doc.querySelector("p").prepend(nodes[1]);
		rejects(() => projection(doc, repeat.text));
	});
	iframe.remove();
	$("results").textContent = output.join("\n");
	status(
		`真实 DOM 自检：${output.filter((x) => x.startsWith("✓")).length}/${output.length} 通过`,
		output.some((x) => x.startsWith("✗")),
	);
};
