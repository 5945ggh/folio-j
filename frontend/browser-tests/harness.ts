import type { ReactNode } from "react";

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
	) => Promise<() => void>;
	mock: (handler: (request: Request) => Promise<Response>) => void;
};
