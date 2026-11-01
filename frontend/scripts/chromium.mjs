import { access } from "node:fs/promises";
import path from "node:path";

// Chrome and Edge expose the same CDP transport used by these offline checks.
export async function findChromium(environment = process.env) {
	const candidates = environment.CHROME_BIN
		? [environment.CHROME_BIN]
		: [
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
				"/usr/bin/google-chrome",
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				...[
					environment.PROGRAMFILES,
					environment["PROGRAMFILES(X86)"],
					environment.LOCALAPPDATA,
				]
					.filter(Boolean)
					.flatMap((root) => [
						path.join(root, "Google/Chrome/Application/chrome.exe"),
						path.join(root, "Microsoft/Edge/Application/msedge.exe"),
					]),
			];
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Try the next installed browser; an explicit override remains authoritative.
		}
	}
	throw new Error(
		"Chrome/Edge unavailable; set CHROME_BIN to its executable path",
	);
}
