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
