import { DEFAULT_FILTERS, type FilterParams } from "../engine/types";

/**
 * Named enhancement presets — the spike's equivalent of the desktop "CS Adapt"
 * favorites: each bundles a set of filter params + a tone-curve LUT id.
 *
 * `modality` tags which image type a preset is tuned for. Today everything is
 * "general"; this is the seam for the later "different filters for panoramic /
 * CT / ceph" work — that becomes pure data (add presets, filter the strip by
 * the loaded image's modality) with no pipeline changes.
 */
export type Modality = "general" | "ceph" | "pano" | "ct" | "intraoral";

export interface Preset {
  id: string;
  name: string;
  modality: Modality;
  /** Full filter params, including the LUT id this preset selects. */
  params: FilterParams;
}

const p = (over: Partial<FilterParams>): FilterParams => ({ ...DEFAULT_FILTERS, ...over });

export const PRESETS: Preset[] = [
  {
    id: "original",
    name: "Original",
    modality: "general",
    params: p({ lut: "none" }),
  },
  {
    id: "adapt-balanced",
    name: "Balanced",
    modality: "general",
    // Auto-window + moderate CLAHE is the workhorse: local contrast without
    // the haze a pure tone curve leaves behind.
    params: p({ autoWindow: true, clahe: 0.6, claheClip: 2.5, sharpen: 1.5 }),
  },
  {
    id: "adapt-detail",
    name: "Detail",
    modality: "general",
    params: p({ autoWindow: true, clahe: 0.85, claheClip: 3.5, sharpen: 3.0 }),
  },
  {
    id: "adapt-soft-tissue",
    name: "Soft Tissue",
    modality: "general",
    params: p({ autoWindow: true, clahe: 0.45, claheClip: 2, sharpen: 1.0, lut: "soft-tissue" }),
  },
  {
    id: "adapt-bone",
    name: "Bone",
    modality: "general",
    params: p({ autoWindow: true, clahe: 0.7, claheClip: 4, sharpen: 2.0, lut: "bone-detail" }),
  },
  {
    id: "pano",
    name: "Panoramic",
    modality: "pano",
    // Tuned for dark, low-contrast panos like the test image: strong auto-window
    // + assertive CLAHE to pull bone/tooth structure out of the fog.
    params: p({ autoWindow: true, clahe: 0.9, claheClip: 3, sharpen: 2.0, gamma: 1.1 }),
  },
  {
    id: "teeth-vs-tissue",
    name: "Teeth vs Tissue",
    modality: "general",
    // Density segmentation: boost contrast in the tooth band, soften+lift the
    // soft-tissue band, on top of an auto-windowed CLAHE base.
    params: p({
      autoWindow: true,
      clahe: 0.5,
      sharpen: 1.5,
      segEnabled: true,
      segAuto: true,
      segToothGain: 1.6,
      segTissueGain: 0.8,
      segTissueBias: 0.05,
    }),
  },
];

export function listPresets(modality?: Modality): Preset[] {
  if (!modality) return PRESETS;
  return PRESETS.filter((x) => x.modality === modality || x.modality === "general");
}
