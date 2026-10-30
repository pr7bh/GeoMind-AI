import type { RefObject } from "react";
import type { GeoMapHandle, ImportedLayerInfo } from "../workspace/GeoMap";

// Only one tool may listen for map clicks at a time.
export type MapPickTarget = "nearest" | "start" | "destination";

export interface ToolProps {
  theme: "light" | "dark";
  mapRef: RefObject<GeoMapHandle | null>;
  importedLayers: ImportedLayerInfo[];
}

export interface MapPickProps {
  mapPick: MapPickTarget | null;
  onBeginMapPick: (target: MapPickTarget) => void;
  onEndMapPick: () => void;
}
