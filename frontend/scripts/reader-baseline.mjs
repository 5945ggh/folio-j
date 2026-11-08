import { execFileSync } from "node:child_process";
import path from "node:path";

// The pre-retention comparison replaces only these modules, not the whole app.
const revision = "ae44fc8925ab5733e0f8162e6b3981cff1088975";
const modules = [
	"MaterialReader.tsx",
	"reader-frames.ts",
	"study-marks-query.ts",
	"chapter-translations-query.ts",
];

export function historicalReaderBaseline(frontend) {
	const originals = new Map();
	for (const name of modules) {
		const repositoryPath = `frontend/src/materials/${name}`;
		try {
			originals.set(
				path.join(frontend, "src/materials", name).replaceAll("\\", "/"),
				execFileSync("git", ["show", `${revision}:${repositoryPath}`], {
					cwd: frontend,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				}),
			);
		} catch (cause) {
			throw new Error(
				`Historical reader baseline unavailable: requires Git object ${revision}:${repositoryPath} in this checkout`,
				{ cause },
			);
		}
	}
	console.log(
		`Historical reader baseline: ${revision}; four reader modules only; production files remain untouched`,
	);
	return {
		name: "historical-reader-baseline",
		enforce: "pre",
		transform(_source, id) {
			return originals.get(id.split("?")[0]);
		},
	};
}
