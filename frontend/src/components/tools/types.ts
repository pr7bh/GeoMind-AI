import type { RefObject } from "react";
import type { GeoMapHandle, ImportedLayerInfo } from "../workspace/GeoMap";
import type { MapPicker } from "../map/useMapPicker";

export interface ToolProps {
  theme: "light" | "dark";
  mapRef: RefObject<GeoMapHandle | null>;
  importedLayers: ImportedLayerInfo[];
}

export interface MapPickProps {
  picker: MapPicker;
}
