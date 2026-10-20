/** A started discussion stays mounted until its keyed Segment page leaves. */
export function shouldMountWorkbench(
	activated: boolean,
	chatOpen: boolean,
	generateToken: string | null,
): boolean {
	return activated || chatOpen || Boolean(generateToken);
}
