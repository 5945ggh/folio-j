import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router";
import {
	dictionaryLibraryKey,
	getDictionaryLibrary,
	installDictionary,
	selectDictionary,
	subscribeDictionaryLibrary,
	updateDictionaryLibrary,
} from "../materials/dictionary-api";
import { returnDestination } from "../navigation";
import { InlineError } from "../Shared";
import { useSettingsDraft } from "./SettingsForms";
import "./dictionary-settings.css";

type DictionaryAction =
	| { kind: "import"; file: File }
	| { kind: "select"; id: string };

async function changeDictionary(action: DictionaryAction) {
	if (action.kind === "select") {
		const library = await selectDictionary(action.id);
		const chosen = library.dictionaries.find(
			(item) => item.dictionary_id === library.active_dictionary_id,
		);
		return { library, notice: `已切换到《${chosen?.title ?? "所选词典"}》。` };
	}
	const result = await installDictionary(action.file);
	const installed = result.library.dictionaries.find(
		(item) => item.dictionary_id === result.dictionary_id,
	);
	const title = installed?.title ?? action.file.name;
	const notice = result.already_installed
		? `《${title}》已经安装。`
		: result.library.active_dictionary_id === result.dictionary_id
			? `已导入《${title}》，阅读时将使用这本词典。`
			: `已导入《${title}》。`;
	return { library: result.library, notice };
}

function DictionaryGlyph({ upload = false }: { upload?: boolean }) {
	return (
		<svg
			width={upload ? 16 : 28}
			height={upload ? 16 : 28}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{upload ? (
				<path d="M12 16V3m-4 4 4-4 4 4M4 15v5h16v-5" />
			) : (
				<path d="M4 4.5q4.5-1.4 8 1.2 3.5-2.6 8-1.2v14.8q-4.5-1.2-8 1-3.5-2.2-8-1zM12 6v14M7 8l2 .5m-2 3 2 .5" />
			)}
		</svg>
	);
}

export function DictionarySettings() {
	const client = useQueryClient();
	const location = useLocation();
	const reader = returnDestination(location.state, { to: "", label: "" });
	const fromBook = /^\/materials\/[a-zA-Z0-9_-]+(?:[?#]|$)/.test(reader.to);
	const input = useRef<HTMLInputElement>(null);
	const library = useQuery({
		queryKey: dictionaryLibraryKey,
		queryFn: ({ signal }) => getDictionaryLibrary(signal),
		refetchOnWindowFocus: true,
		retry: false,
	});
	useEffect(() => subscribeDictionaryLibrary(client), [client]);
	const change = useMutation({
		mutationFn: changeDictionary,
		onSuccess: ({ library: next }) => updateDictionaryLibrary(client, next),
	});
	const busy = change.isPending;
	useSettingsDraft({
		id: "dictionary-library",
		label: "词典",
		dirty: false,
		pending: busy,
		save: async () => true,
		discard: () => {},
	});
	const items = library.data?.dictionaries;
	const importingFile =
		change.isPending && change.variables.kind === "import"
			? change.variables.file
			: null;
	const retry = () => {
		if (change.variables && !busy) change.mutate(change.variables);
	};
	const canImport = !!library.data && !busy;
	return (
		<section className="dictionary-settings" aria-label="查词词典">
			{fromBook && (
				<Link
					className="settings-back-link dictionary-reader-return"
					to={reader.to}
					state={reader.state}
					aria-label="返回阅读"
				>
					← 返回阅读<span>{reader.label}</span>
				</Link>
			)}
			<div className="settings-page-head">
				<h2>词典</h2>
				<p>选择阅读时使用的词典，适用于所有书籍。</p>
			</div>
			<div className="settings-section-heading">
				<h3 id="installed-dictionaries">
					已安装词典
					{items && <span className="dictionary-count">{items.length}</span>}
				</h3>
				<button
					type="button"
					className="settings-button primary"
					disabled={!canImport}
					onClick={() => input.current?.click()}
				>
					<DictionaryGlyph upload />
					导入词典
				</button>
				<input
					hidden
					type="file"
					ref={input}
					accept=".zip,application/zip"
					aria-label="选择词典 ZIP"
					disabled={!canImport}
					onChange={(event) => {
						const file = event.currentTarget.files?.[0];
						event.currentTarget.value = "";
						if (file && !busy) change.mutate({ kind: "import", file });
					}}
				/>
			</div>
			{library.isPending && (
				<p role="status" className="settings-loading">
					正在读取已安装词典…
				</p>
			)}
			{library.isError && (
				<div className="settings-state">
					<InlineError error={library.error} />
					<button
						className="settings-button secondary"
						type="button"
						onClick={() => void library.refetch()}
					>
						重试读取
					</button>
				</div>
			)}
			{items &&
				(items.length ? (
					<fieldset
						className="settings-group dictionary-list"
						aria-labelledby="installed-dictionaries"
						disabled={busy}
					>
						{items.map((item) => {
							const active =
								library.data?.active_dictionary_id === item.dictionary_id;
							return (
								<label
									key={item.dictionary_id}
									className="dictionary-choice"
									data-current={active}
								>
									<span className="dictionary-symbol" aria-hidden="true">
										辞
									</span>
									<span className="dictionary-details">
										<strong>{item.title}</strong>
										<small id={`dictionary-meta-${item.dictionary_id}`}>
											{item.entry_count.toLocaleString("zh-CN")} 条记录
											{item.revision && <> · 版本 {item.revision}</>}
										</small>
									</span>
									{active && <span className="dictionary-current">使用中</span>}
									<input
										type="radio"
										name="active-dictionary"
										aria-label={`使用${item.title}`}
										aria-describedby={`dictionary-meta-${item.dictionary_id}`}
										checked={active}
										onChange={() => {
											if (!active && !busy)
												change.mutate({
													kind: "select",
													id: item.dictionary_id,
												});
										}}
									/>
								</label>
							);
						})}
					</fieldset>
				) : (
					<div className="dictionary-empty settings-group">
						<DictionaryGlyph />
						<strong>还没有安装词典</strong>
						<p>导入第一本后，就可以在书中开启即时查词。</p>
					</div>
				))}
			{importingFile ? (
				<p className="dictionary-notice" role="status">
					正在导入 {importingFile.name}，请稍候…
				</p>
			) : busy ? (
				<p className="dictionary-notice" role="status">
					正在切换词典…
				</p>
			) : change.isError ? (
				<div className="dictionary-failure">
					<InlineError error={change.error} />
					<button
						type="button"
						className="settings-button secondary"
						onClick={retry}
					>
						{change.variables.kind === "import" ? "重试导入" : "重试切换"}
					</button>
				</div>
			) : (
				change.isSuccess && (
					<p className="dictionary-notice" role="status">
						{change.data.notice}
					</p>
				)
			)}
			<p className="settings-hint dictionary-format">
				支持 Yomitan format 3 词条词典（.zip，最大 256
				MiB）。第一本自动使用，以后导入的词典可在这里切换。
			</p>
		</section>
	);
}
