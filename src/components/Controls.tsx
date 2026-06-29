import { useRef } from "react";
import type { FilterParams, Lut, LiveMode } from "../engine";
import {
  DEFAULT_FILTERS,
  LIVE_MODE_DESCRIPTIONS,
  LIVE_MODE_LABELS,
  LIVE_MODE_ORDER,
} from "../engine";
import type { Preset } from "../presets/presets";

interface Props {
  params: FilterParams;
  onChange: (p: FilterParams) => void;
  /** Currently-active live mode (one of 9). */
  liveMode: LiveMode;
  /** Change handler for the live mode. */
  onModeChange: (m: LiveMode) => void;
  /** Which modes have working underlying engines + loaders. */
  modeAvailable: Record<LiveMode, boolean>;
  /**
   * Optional per-mode reason explaining why the radio is disabled. Surfaced
   * after the label as muted text. Used for the permanent-n/a row
   * (cornerstone-webgpu) and for runtime-unavailable engines.
   */
  modeUnavailableReason: Partial<Record<LiveMode, string>>;
  size: number;
  onSizeChange: (s: number) => void;
  onLoadFiles: (files: FileList | null) => void;
  sliceCount: number;
  sliceIndex: number;
  onSliceChange: (i: number) => void;
  onShowOriginal: () => void;
  onBenchmark: () => void;
  presets: Preset[];
  activePreset: string;
  onApplyPreset: (p: Preset) => void;
  luts: Lut[];
  onLoadLut: (files: FileList | null) => void;
  busy: boolean;
}

export function Controls({
  params,
  onChange,
  liveMode,
  onModeChange,
  modeAvailable,
  modeUnavailableReason,
  size,
  onSizeChange,
  onLoadFiles,
  sliceCount,
  sliceIndex,
  onSliceChange,
  onShowOriginal,
  onBenchmark,
  presets,
  activePreset,
  onApplyPreset,
  luts,
  onLoadLut,
  busy,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const lutRef = useRef<HTMLInputElement>(null);

  const slider = (
    key:
      | "brightness"
      | "contrast"
      | "clahe"
      | "claheClip"
      | "denoise"
      | "sharpen"
      | "edge"
      | "gamma"
      | "segT1"
      | "segT2"
      | "segFeather"
      | "segTissueGain"
      | "segTissueBias"
      | "segBoneGain"
      | "segToothGain"
      | "segToothBias",
    label: string,
    min: number,
    max: number,
    step: number
  ) => (
    <label className="row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={params[key]}
        onChange={(e) => onChange({ ...params, [key]: Number(e.target.value) })}
      />
      <code>{params[key].toFixed(2)}</code>
    </label>
  );

  return (
    <div className="controls">
      <fieldset>
        <legend>Presets (favorites)</legend>
        <div className="presets">
          {presets.map((preset) => (
            <button
              key={preset.id}
              className={"preset" + (activePreset === preset.id ? " active" : "")}
              onClick={() => onApplyPreset(preset)}
              disabled={busy}
              title={`LUT: ${preset.params.lut} · sharpen ${preset.params.sharpen}`}
            >
              {preset.name}
            </button>
          ))}
        </div>
        <p className="hint">
          Each preset bundles a tone-curve LUT + filter settings, like the
          desktop CS Adapt favorites. Adjusting any control below switches to
          manual mode.
        </p>
      </fieldset>

      <fieldset>
        <legend>Source</legend>
        {/* Pick individual .dcm files */}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".dcm,.DCM,application/dicom"
          style={{ display: "none" }}
          onChange={(e) => onLoadFiles(e.target.files)}
        />
        {/* Pick a whole folder (a CT series) */}
        <input
          ref={dirRef}
          type="file"
          multiple
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          style={{ display: "none" }}
          onChange={(e) => onLoadFiles(e.target.files)}
        />
        <div className="buttons">
          <button onClick={() => fileRef.current?.click()} disabled={busy}>
            Load .dcm files…
          </button>
          <button onClick={() => dirRef.current?.click()} disabled={busy}>
            Load folder…
          </button>
        </div>
        {sliceCount > 1 && (
          <label className="row">
            <span>Slice</span>
            <input
              type="range"
              min={0}
              max={sliceCount - 1}
              step={1}
              value={sliceIndex}
              onChange={(e) => onSliceChange(Number(e.target.value))}
              disabled={busy}
            />
            <code>
              {sliceIndex + 1}/{sliceCount}
            </code>
          </label>
        )}
        {sliceCount === 0 && (
          <label className="row">
            <span>Phantom</span>
            <select
              value={size}
              onChange={(e) => onSizeChange(Number(e.target.value))}
              disabled={busy}
            >
              <option value={512}>512 × 512</option>
              <option value={1024}>1024 × 1024</option>
              <option value={2048}>2048 × 2048</option>
            </select>
          </label>
        )}
        <p className="hint">
          Folder is read in-browser only — no upload, no patient identifiers
          read. Uncompressed DICOM only.
        </p>
      </fieldset>

      <fieldset>
        <legend>Engine pipeline</legend>
        {LIVE_MODE_ORDER.map((m) => {
          const disabled = !modeAvailable[m] || busy;
          const reason = modeUnavailableReason[m];
          return (
            <label
              key={m}
              className="radio"
              title={LIVE_MODE_DESCRIPTIONS[m]}
            >
              <input
                type="radio"
                name="live-mode"
                checked={liveMode === m}
                disabled={disabled}
                onChange={() => onModeChange(m)}
              />
              <span>
                {LIVE_MODE_LABELS[m]}
                {reason ? <em className="reason"> · {reason}</em> : null}
              </span>
            </label>
          );
        })}
        <p className="hint">
          Each option corresponds to one row of the benchmark table — hover
          for the full pipeline description. <b>Babylon-only</b> /{" "}
          <b>CS parse only</b> modes paint directly to a Babylon canvas (no
          Cornerstone display); the rest go through Cornerstone's viewport.
        </p>
      </fieldset>

      <fieldset>
        <legend>Filters</legend>
        <label className="row">
          <span>Auto-window</span>
          <input
            type="checkbox"
            checked={params.autoWindow}
            onChange={(e) => onChange({ ...params, autoWindow: e.target.checked })}
          />
        </label>
        {slider("brightness", "Brightness", -1, 1, 0.02)}
        {slider("contrast", "Contrast", 0.2, 4, 0.05)}
        {slider("clahe", "CLAHE", 0, 1, 0.02)}
        {slider("claheClip", "CLAHE clip", 1, 6, 0.1)}
        {slider("denoise", "Denoise", 0, 1, 0.02)}
        {slider("sharpen", "Sharpen", 0, 10, 0.1)}
        {slider("edge", "Edge", 0, 1, 0.02)}
        {slider("gamma", "Gamma", 0.2, 3, 0.05)}
        <label className="row">
          <span>Invert</span>
          <input
            type="checkbox"
            checked={params.invert}
            onChange={(e) => onChange({ ...params, invert: e.target.checked })}
          />
        </label>
        <label className="row">
          <span>Tone LUT</span>
          <select
            value={params.lut}
            onChange={(e) => onChange({ ...params, lut: e.target.value })}
            disabled={busy}
          >
            {luts.map((lut) => (
              <option key={lut.id} value={lut.id}>
                {lut.name}
              </option>
            ))}
          </select>
        </label>
        <input
          ref={lutRef}
          type="file"
          multiple
          accept=".lut,.json,.csv,.txt,.cube"
          style={{ display: "none" }}
          onChange={(e) => onLoadLut(e.target.files)}
        />
        <div className="buttons">
          <button onClick={() => lutRef.current?.click()} disabled={busy}>
            Load LUT…
          </button>
        </div>
        <div className="buttons">
          <button onClick={() => onChange(DEFAULT_FILTERS)} disabled={busy}>
            Reset
          </button>
          <button onClick={onShowOriginal} disabled={busy}>
            Show original
          </button>
          <button onClick={onBenchmark} disabled={busy}>
            Run benchmark
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend>Tissue segmentation (tooth vs tissue)</legend>
        <label className="row">
          <span>Enable</span>
          <input
            type="checkbox"
            checked={params.segEnabled}
            onChange={(e) => onChange({ ...params, segEnabled: e.target.checked })}
          />
        </label>
        {params.segEnabled && (
          <>
            <label className="row">
              <span>Auto thresholds (Otsu)</span>
              <input
                type="checkbox"
                checked={params.segAuto}
                onChange={(e) => onChange({ ...params, segAuto: e.target.checked })}
              />
            </label>
            {!params.segAuto && (
              <>
                {slider("segT1", "Tissue│bone", 0, 1, 0.01)}
                {slider("segT2", "Bone│tooth", 0, 1, 0.01)}
              </>
            )}
            {slider("segFeather", "Edge softness", 0, 0.25, 0.01)}
            {slider("segTissueGain", "Tissue contrast", 0, 3, 0.05)}
            {slider("segTissueBias", "Tissue brightness", -0.3, 0.3, 0.01)}
            {slider("segBoneGain", "Bone contrast", 0, 3, 0.05)}
            {slider("segToothGain", "Tooth contrast", 0, 3, 0.05)}
            {slider("segToothBias", "Tooth brightness", -0.3, 0.3, 0.01)}
            <label className="row">
              <span>View</span>
              <select
                value={params.segView}
                onChange={(e) =>
                  onChange({ ...params, segView: e.target.value as "normal" | "map" })
                }
                disabled={busy}
              >
                <option value="normal">Normal</option>
                <option value="map">Class map (color)</option>
              </select>
            </label>
            <label className="row">
              <span>Tint teeth/tissue</span>
              <input
                type="checkbox"
                checked={params.segTint}
                onChange={(e) => onChange({ ...params, segTint: e.target.checked })}
              />
            </label>
            <p className="hint">
              Classifies each pixel by density (windowed brightness) into soft
              tissue / bone / tooth, then applies its own contrast + brightness.
              "Class map" colors the regions so you can check the split; orange =
              tooth, green = bone, blue = soft tissue.
            </p>
          </>
        )}
      </fieldset>
    </div>
  );
}
