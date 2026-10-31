import { createRef, useState } from "react";
import { NativeSelect } from "../src/NativeSelect";
import type { BrowserHarness } from "./harness";
import "../src/materials/reader-r1.css";
import "../src/materials/reader-refresh.css";

const options = (
	<>
		<option value="long">
			非常に長い日本語の選択肢・表示領域を越えても矢印と重ならない資料名
		</option>
		<option value="short">短い資料</option>
	</>
);

export async function nativeSelectRegression(
	h: BrowserHarness,
	preview = false,
) {
	const check: BrowserHarness["check"] = h.check;
	const ref = createRef<HTMLSelectElement>();
	let changes = 0;
	const targets: EventTarget[] = [];
	const theme = new URLSearchParams(location.search).get("theme") ?? "light";
	const previousTheme = document.documentElement.dataset.theme;
	document.documentElement.dataset.theme = theme;
	function Fixture() {
		const [value, setValue] = useState("long");
		return (
			<div style={{ padding: 16, maxWidth: "100%" }}>
				<form id="select-form" style={{ width: 260, maxWidth: "100%" }}>
					<label className="field" htmlFor="controlled-select">
						資料
						<NativeSelect
							id="controlled-select"
							name="material"
							className="fixture-control"
							wrapperClassName="fixture-wrapper"
							ref={ref}
							value={value}
							onChange={(event) => {
								changes++;
								targets.push(event.target);
								setValue(event.currentTarget.value);
							}}
						>
							{options}
						</NativeSelect>
					</label>
					<output id="selected-value">{value}</output>
					<div data-layout="regular">
						<NativeSelect aria-label="通常" defaultValue="long">
							{options}
						</NativeSelect>
					</div>
					<div data-layout="compact" className="catalog-toolbar">
						<NativeSelect aria-label="コンパクト" defaultValue="long">
							{options}
						</NativeSelect>
					</div>
					<label data-layout="full" className="field" htmlFor="full-select">
						全幅
						<NativeSelect
							id="full-select"
							aria-label="全幅"
							defaultValue="long"
						>
							{options}
						</NativeSelect>
					</label>
					<label className="field" htmlFor="disabled-select">
						無効
						<NativeSelect
							id="disabled-select"
							disabled
							name="disabled"
							defaultValue="short"
						>
							{options}
						</NativeSelect>
					</label>
					<NativeSelect
						aria-label="複数"
						multiple
						name="multiple"
						defaultValue={["short"]}
					>
						{options}
					</NativeSelect>
					<NativeSelect
						aria-label="一覧"
						size={3}
						name="list"
						defaultValue="short"
					>
						{options}
					</NativeSelect>
				</form>
				<section
					className="reader-r1"
					data-theme={theme === "dark" ? "black" : "white"}
					style={{
						position: "relative",
						inset: "auto",
						width: 260,
						maxWidth: "100%",
						overflow: "visible",
						marginTop: 16,
					}}
				>
					<div className="reader-panel-body">
						<label data-layout="reader" htmlFor="reader-select">
							読書設定
							<NativeSelect
								id="reader-select"
								aria-label="読書設定"
								defaultValue="long"
							>
								{options}
							</NativeSelect>
						</label>
					</div>
				</section>
			</div>
		);
	}
	const dispose = await h.mount(<Fixture />);
	function find<T extends Element>(selector: string): T {
		const node = h.container.querySelector<T>(selector);
		check(node, `Missing select fixture ${selector}`);
		return node;
	}
	try {
		await h.until(() => ref.current !== null, "Native select ref must resolve");
		const controlled = find<HTMLSelectElement>("#controlled-select");
		check(
			ref.current === controlled && controlled instanceof HTMLSelectElement,
			"Ref must expose the native HTMLSelectElement",
		);
		check(
			controlled.labels?.[0]?.textContent?.includes("資料"),
			"Native label association must survive wrapping",
		);
		check(
			controlled.classList.contains("fixture-control") &&
				controlled.parentElement?.classList.contains("fixture-wrapper"),
			"Class names must reach select and wrapper separately",
		);
		check(
			!h.container.querySelector('[role="combobox"], [role="listbox"]'),
			"Select must retain native semantics without replacement roles",
		);
		controlled.focus();
		check(
			document.activeElement === controlled,
			"Native select ref must accept focus",
		);
		controlled.value = "short";
		controlled.dispatchEvent(new Event("change", { bubbles: true }));
		await h.until(
			() => find("#selected-value").textContent === "short",
			"Native change must update controlled React state",
		);
		check(
			changes === 1 &&
				targets[0] === controlled &&
				controlled.value === "short",
			"Change must expose actual select once",
		);
		const values = new FormData(find<HTMLFormElement>("#select-form"));
		check(
			values.get("material") === "short" && !values.has("disabled"),
			"Native names, values and disabled form rules must survive wrapping",
		);
		const disabled = find<HTMLSelectElement>("select:disabled");
		disabled.focus();
		check(
			document.activeElement !== disabled,
			"Disabled select must remain unfocusable",
		);
		for (const select of h.container.querySelectorAll<HTMLSelectElement>(
			"select:not([multiple]):not([size])",
		)) {
			const wrapper = select.parentElement;
			check(wrapper, "Select wrapper must exist");
			check(
				wrapper.matches("span.native-select"),
				"Single select must have shared wrapper",
			);
			const arrow = wrapper.querySelector("svg");
			check(
				arrow?.getAttribute("aria-hidden") === "true",
				"Decorative arrow must be hidden from accessibility APIs",
			);
			const style = getComputedStyle(select);
			check(
				style.appearance === "none" &&
					Number.parseFloat(style.paddingRight) >= 40,
				"Custom arrow must replace native arrow and reserve text space in every scope",
			);
			const bounds = select.getBoundingClientRect(),
				icon = arrow.getBoundingClientRect();
			check(
				Math.abs(icon.width - 14) < 1 &&
					Math.abs(icon.height - 14) < 1 &&
					Math.abs(bounds.right - icon.right - 14) <= 1,
				"Arrow must stay 14px wide and 14px from the right edge",
			);
			check(
				getComputedStyle(arrow).pointerEvents === "none",
				"Arrow must not intercept native select pointer input",
			);
			const colorProbe = document.createElement("span");
			colorProbe.style.color = select.closest(".reader-r1")
				? "var(--reader-muted)"
				: "var(--color-text-muted)";
			colorProbe.hidden = true;
			wrapper.append(colorProbe);
			const expectedColor = getComputedStyle(colorProbe).color;
			colorProbe.remove();
			check(
				getComputedStyle(arrow).color === expectedColor,
				"Arrow must use theme-aware muted foreground in app and Reader scopes",
			);
			if (!select.disabled) {
				select.scrollIntoView({ block: "center" });
				const visible = arrow.getBoundingClientRect();
				check(
					document.elementFromPoint(
						visible.left + visible.width / 2,
						visible.top + visible.height / 2,
					) === select,
					"Pointer at arrow must hit the real native select",
				);
			}
		}
		for (const layout of h.container.querySelectorAll<HTMLElement>(
			"[data-layout]",
		)) {
			const select = layout.querySelector("select");
			check(select, "Layout fixture must contain a select");
			const box = select.getBoundingClientRect(),
				parent = layout.getBoundingClientRect();
			check(
				box.width > 40 &&
					box.left >= parent.left - 1 &&
					box.right <= parent.right + 1,
				`${layout.dataset.layout}: long option must fit narrow container`,
			);
			check(
				layout.scrollWidth <= layout.clientWidth + 1,
				`${layout.dataset.layout}: select must not force horizontal overflow`,
			);
		}
		for (const selector of ["select[multiple]", "select[size]"]) {
			const list = find<HTMLSelectElement>(selector);
			check(
				!list.closest(".native-select") &&
					!list.parentElement?.querySelector(":scope > svg"),
				"Multiple and size>1 selects must remain native lists without dropdown arrow",
			);
			check(
				getComputedStyle(list).appearance !== "none",
				"List selects must retain native appearance",
			);
		}
		check(
			document.documentElement.scrollWidth <= innerWidth + 1,
			"Long option labels must not overflow document",
		);
		return `native select: controlled change/ref/label/form/disabled, native lists, arrow geometry/theme/pointer hit and narrow layouts verified at ${innerWidth}px (${theme})`;
	} finally {
		if (!preview) {
			dispose();
			if (previousTheme === undefined)
				delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = previousTheme;
		}
	}
}
