import {
  Blend,
  CircleDot,
  Flame,
  Layers,
  LocateFixed,
  Route,
  SquareDashedMousePointer,
  Settings2,
  Telescope,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type WorkspaceToolId =
  | "discovery"
  | "routing"
  | "nearest"
  | "buffer"
  | "spatial-query"
  | "intersection"
  | "heatmap"
  | "layers"
  | "settings";

export interface WorkspaceTool {
  id: WorkspaceToolId;
  /** Short label under the sidebar icon. */
  label: string;
  title: string;
  description: string;
  icon: LucideIcon;
}

export const WORKSPACE_TOOLS: WorkspaceTool[] = [
  {
    id: "discovery",
    label: "Discover",
    title: "Discovery",
    description: "Find real OpenStreetMap features around a location.",
    icon: Telescope,
  },
  {
    id: "routing",
    label: "Route",
    title: "Routing",
    description: "Measure straight-line and driving routes between two points.",
    icon: Route,
  },
  {
    id: "nearest",
    label: "Nearest",
    title: "Nearest Features",
    description: "Rank the features in a layer by distance from a reference point.",
    icon: LocateFixed,
  },
  {
    id: "buffer",
    label: "Buffer",
    title: "Buffer Analysis",
    description: "Create a distance buffer around a point on the map.",
    icon: CircleDot,
  },
  {
    id: "spatial-query",
    label: "Query",
    title: "Spatial Query",
    description: "Filter or clip a layer by a boundary polygon.",
    icon: SquareDashedMousePointer,
  },
  {
    id: "intersection",
    label: "Intersect",
    title: "Intersection Analysis",
    description: "Find where features in two layers overlap.",
    icon: Blend,
  },
  {
    id: "heatmap",
    label: "Heatmap",
    title: "Heatmap",
    description: "Visualise the density of point features in a layer.",
    icon: Flame,
  },
  {
    id: "layers",
    label: "Layers",
    title: "Data Layers",
    description: "Manage imported, discovered and analysis layers.",
    icon: Layers,
  },
  {
    id: "settings",
    label: "Settings",
    title: "Map Settings",
    description: "Base map and appearance.",
    icon: Settings2,
  },
];
