import type { components } from "../api/schema";

type PositionUpdate = components["schemas"]["ReadingPositionUpdate"];
/** Response metadata must never enter the strict update request. */
export function positionRequest(
	position: Omit<PositionUpdate, "expected_revision">,
	revision: number,
): PositionUpdate {
	return {
		version_id: position.version_id,
		chapter_id: position.chapter_id,
		part_index: position.part_index,
		resource_id: position.resource_id,
		kind: position.kind,
		offset: position.offset,
		image_id: position.image_id,
		image_progress: position.image_progress,
		settings: position.settings
			? {
					font_size: position.settings.font_size,
					line_height: position.settings.line_height,
					writing_mode: position.settings.writing_mode,
				}
			: undefined,
		expected_revision: revision,
	};
}
