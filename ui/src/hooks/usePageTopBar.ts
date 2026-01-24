import { useEffect, type DependencyList } from "react";
import { useFrameStore, type TopBarConfig } from "@/stores/frameStore";

export function usePageTopBar(
  config: TopBarConfig | null,
  deps: DependencyList,
) {
  const setTopBarConfig = useFrameStore((s) => s.setTopBarConfig);

  useEffect(() => {
    if (config) {
      setTopBarConfig(config);
    } else {
      setTopBarConfig({ show: false });
    }
  }, deps);

  useEffect(() => {
    return () => {
      setTopBarConfig({ show: false });
    };
  }, [setTopBarConfig]);
}
