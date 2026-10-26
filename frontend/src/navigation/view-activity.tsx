import { createContext, type ReactNode, useContext } from "react";

type ViewActivity = { active: boolean; activation: number };
export const ViewActivityContext = createContext<ViewActivity>({
	active: true,
	activation: 0,
});

/** Effects and asynchronous work consult activity; final unmount disposes resources. */
export function useViewActivity() {
	return useContext(ViewActivityContext);
}

export function ViewActivityProvider({
	value,
	children,
}: {
	value: ViewActivity;
	children: ReactNode;
}) {
	return <ViewActivityContext value={value}>{children}</ViewActivityContext>;
}
