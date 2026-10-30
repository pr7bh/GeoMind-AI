import type { RefObject } from "react";
import type { FeatureCollection } from "geojson";
import type { GeoMapHandle } from "../workspace/GeoMap";

export function readLayerFeatures(
  mapRef: RefObject<GeoMapHandle | null>,
  layerId: string,
) {
  const geoJSONText = mapRef.current?.getImportedGeoJSON(layerId);

  if (!geoJSONText) {
    throw new Error("Unable to read the selected layer.");
  }

  const { features } = JSON.parse(geoJSONText) as FeatureCollection;

  if (features.length === 0) {
    throw new Error("The selected layer contains no features.");
  }

  return features;
}
