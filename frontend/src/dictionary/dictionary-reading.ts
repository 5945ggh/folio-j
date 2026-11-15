import { hiragana } from "../materials/ruby.ts";

const syllables: Record<string, string> = {
	あ: "a",
	い: "i",
	う: "u",
	え: "e",
	お: "o",
	か: "ka",
	き: "ki",
	く: "ku",
	け: "ke",
	こ: "ko",
	さ: "sa",
	し: "shi",
	す: "su",
	せ: "se",
	そ: "so",
	た: "ta",
	ち: "chi",
	つ: "tsu",
	て: "te",
	と: "to",
	な: "na",
	に: "ni",
	ぬ: "nu",
	ね: "ne",
	の: "no",
	は: "ha",
	ひ: "hi",
	ふ: "fu",
	へ: "he",
	ほ: "ho",
	ま: "ma",
	み: "mi",
	む: "mu",
	め: "me",
	も: "mo",
	や: "ya",
	ゆ: "yu",
	よ: "yo",
	ら: "ra",
	り: "ri",
	る: "ru",
	れ: "re",
	ろ: "ro",
	わ: "wa",
	ゐ: "wi",
	ゑ: "we",
	を: "o",
	ゔ: "vu",
	が: "ga",
	ぎ: "gi",
	ぐ: "gu",
	げ: "ge",
	ご: "go",
	ざ: "za",
	じ: "ji",
	ず: "zu",
	ぜ: "ze",
	ぞ: "zo",
	だ: "da",
	ぢ: "ji",
	づ: "zu",
	で: "de",
	ど: "do",
	ば: "ba",
	び: "bi",
	ぶ: "bu",
	べ: "be",
	ぼ: "bo",
	ぱ: "pa",
	ぴ: "pi",
	ぷ: "pu",
	ぺ: "pe",
	ぽ: "po",
	いぇ: "ye",
	うぃ: "wi",
	うぇ: "we",
	うぉ: "wo",
	しぇ: "she",
	じぇ: "je",
	ちぇ: "che",
	すぃ: "si",
	ずぃ: "zi",
	てぃ: "ti",
	でぃ: "di",
	てゅ: "tyu",
	でゅ: "dyu",
	つぁ: "tsa",
	つぃ: "tsi",
	つぇ: "tse",
	つぉ: "tso",
	とぅ: "tu",
	どぅ: "du",
	ふぁ: "fa",
	ふぃ: "fi",
	ふぇ: "fe",
	ふぉ: "fo",
	ふゅ: "fyu",
	ゔぁ: "va",
	ゔぃ: "vi",
	ゔぇ: "ve",
	ゔぉ: "vo",
	ゔゅ: "vyu",
	くぁ: "kwa",
	くゎ: "kwa",
	くぃ: "kwi",
	くぇ: "kwe",
	くぉ: "kwo",
	ぐぁ: "gwa",
	ぐゎ: "gwa",
	ぐぃ: "gwi",
	ぐぇ: "gwe",
	ぐぉ: "gwo",
};
const contractedVowels: Record<string, string> = { ゃ: "a", ゅ: "u", ょ: "o" };
const longVowels: Record<string, string> = {
	a: "ā",
	i: "ī",
	u: "ū",
	e: "ē",
	o: "ō",
};

function romanizedSyllable(kana: string) {
	const first = kana[0] ?? "";
	const pair = kana.slice(0, 2);
	if (syllables[pair] && pair.length === 2)
		return { value: syllables[pair], length: 2 };
	const vowel = contractedVowels[kana[1] ?? ""];
	const base = syllables[first];
	if (vowel && base?.endsWith("i") && base !== "i") {
		const stem = base.slice(0, -1);
		return {
			value: `${stem}${/^(sh|ch|j)$/.test(stem) ? "" : "y"}${vowel}`,
			length: 2,
		};
	}
	return { value: base, length: 1 };
}

/** Transcribe the supplied surface reading. A missing reading has no fallback. */
export function dictionaryReading(reading: string) {
	const kana = hiragana(reading.normalize("NFKC"));
	if (!/^[ぁ-ゖー]+$/u.test(kana)) return null;
	let romaji = "";
	for (let i = 0; i < kana.length; ) {
		const character = kana[i];
		switch (character) {
			case "ー": {
				const last = romaji.at(-1) ?? "";
				if (longVowels[last]) romaji = romaji.slice(0, -1) + longVowels[last];
				else if (!/[āīūēō]$/u.test(romaji)) return { kana, romaji: "" };
				i++;
				break;
			}
			case "ん": {
				const next = romanizedSyllable(kana.slice(i + 1)).value;
				romaji += next && /^[aiueoy]/.test(next) ? "n'" : "n";
				i++;
				break;
			}
			case "っ": {
				const next = romanizedSyllable(kana.slice(i + 1)).value;
				if (!next || !/^[bcdfghjklmpqrstvwxyz]/.test(next))
					return { kana, romaji: "" };
				romaji += next.startsWith("ch") ? "t" : next[0];
				i++;
				break;
			}
			default: {
				const syllable = romanizedSyllable(kana.slice(i));
				if (!syllable.value) return { kana, romaji: "" };
				romaji += syllable.value;
				i += syllable.length;
			}
		}
	}
	return { kana, romaji };
}
