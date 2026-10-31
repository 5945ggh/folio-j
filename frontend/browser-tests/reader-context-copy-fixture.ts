import type { components } from "../src/api/schema";

export const defaultContextCopySettings: components["schemas"]["ContextCopySettingsResponse"] =
	{
		before_sentences: 3,
		after_sentences: 0,
		before_characters: 200,
		after_characters: 200,
		include_source: true,
		revision: 0,
	};

// Existing Reader scenarios do not exercise copying preferences. Their only added
// mock is this exact read; PUT and every other request still reach their handler.
const readerSuites = new Set([
	"app-theme",
	"reader-images",
	"reader-image-performance",
	"reader-layout-switch",
	"reader-bookmarks",
	"reader-session",
	"record-saving",
	"theme",
	"chapter-records",
	"margin-record-targets",
	"inline-records",
	"navigation-feedback",
	"route-loading",
]);

export function defaultReaderContextCopyResponse(
	request: Request,
	suite: string | null,
): Response | undefined {
	if (
		(suite === null || readerSuites.has(suite)) &&
		request.method === "GET" &&
		new URL(request.url).pathname === "/api/settings/context-copy"
	)
		return Response.json(defaultContextCopySettings);
	return undefined;
}
