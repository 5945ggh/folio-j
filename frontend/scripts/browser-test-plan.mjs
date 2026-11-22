const canonicalQuery = (query) => {
	const parameters = new URLSearchParams(query);
	parameters.sort();
	return parameters.toString();
};

export function selectBrowserScenarios(scenarios, environment = {}) {
	const suite = environment.BROWSER_TEST_SUITE;
	const query = environment.BROWSER_TEST_QUERY;
	const selected = scenarios.filter(
		([, , candidate]) =>
			(!suite || new URLSearchParams(candidate).get("suite") === suite) &&
			(!query || canonicalQuery(candidate) === canonicalQuery(query)),
	);
	if (!selected.length)
		throw new Error(
			`No browser scenarios match suite=${suite ?? "*"}, query=${query ?? "*"}`,
		);
	if (
		environment.BROWSER_TEST_BASELINE &&
		selected.some(
			([, , candidate]) =>
				new URLSearchParams(candidate).get("suite") !== "reader-session",
		)
	)
		throw new Error(
			"Historical baseline is supported only for reader-session measurements",
		);
	return selected;
}

export function browserScreenshotName(width, height, query) {
	const parameters = new URLSearchParams(query);
	parameters.delete("capture");
	parameters.sort();
	// Encode the complete scene identity, including height and optional flags.
	return `${width}x${height}-${encodeURIComponent(parameters.toString() || "default")}.png`;
}

export function browserScenarioUrl(base, query, environment) {
	const url = new URL(base);
	url.search = query;
	const parameters = url.searchParams;
	if (environment.BROWSER_TEST_BASELINE) parameters.set("baseline", "");
	if (environment.BROWSER_TEST_PREVIEW) {
		parameters.set("preview", "");
		parameters.set("path", environment.BROWSER_TEST_PREVIEW);
		if (environment.BROWSER_TEST_PANEL)
			parameters.set("panel", environment.BROWSER_TEST_PANEL);
		if (environment.BROWSER_TEST_THEME)
			parameters.set("mode", environment.BROWSER_TEST_THEME);
	} else if (environment.BROWSER_TEST_SCREENSHOT_DIR) {
		parameters.set("capture", "");
	}
	return url;
}

export function assertBrowserResult(scene, result, exceptions) {
	if (exceptions.length) {
		throw new Error(
			`Uncaught page exception(s) in ${scene}:\n${JSON.stringify(exceptions, null, 2)}\nPage result: ${result.text}`,
		);
	}
	if (result.status !== "passed") throw new Error(result.text);
}
