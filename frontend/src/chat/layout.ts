export const MIN_CONVERSATION_WIDTH = 360;
export const MAX_CONVERSATION_WIDTH = 900;
const MIN_READER_WIDTH = 380;

export function conversationWidthRange(workspaceWidth: number) {
	return {
		min: MIN_CONVERSATION_WIDTH,
		max: Math.max(
			MIN_CONVERSATION_WIDTH,
			Math.min(MAX_CONVERSATION_WIDTH, workspaceWidth - MIN_READER_WIDTH),
		),
	};
}

export function clampConversationWidth(width: number, workspaceWidth: number) {
	const { min, max } = conversationWidthRange(workspaceWidth);
	return Math.min(max, Math.max(min, width));
}
