import type { ReactNode } from "react";
import type { RouteObject } from "react-router";

export type BrowserHarness = {
	container: HTMLElement;
	check: (condition: unknown, message: string) => asserts condition;
	until: (predicate: () => boolean, message: string) => Promise<void>;
	inputValue: (
		input: HTMLInputElement | HTMLTextAreaElement,
		value: string,
	) => void;
	mount: (
		content: ReactNode,
		path?: string,
		initialEntry?: string,
		children?: RouteObject[],
	) => Promise<() => void>;
	mock: (handler: (request: Request) => Promise<Response>) => void;
};

type BrowserCheck = () => Promise<string>;

export async function runBrowserSuite(
	suite: string | null,
	namedSuites: ReadonlyMap<string, BrowserCheck>,
	defaultChecks: readonly BrowserCheck[],
): Promise<string[]> {
	if (suite !== null) {
		const run = namedSuites.get(suite);
		if (!run)
			throw new Error(`Unknown browser suite: ${JSON.stringify(suite)}`);
		return [await run()];
	}
	const lines: string[] = [];
	for (const run of defaultChecks) lines.push(await run());
	return lines;
}
