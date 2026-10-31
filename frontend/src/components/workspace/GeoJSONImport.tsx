
import { useRef, useState } from 'react';
import { FileUp, X, LoaderCircle } from 'lucide-react';

interface GeoJSONImportProps {
  theme: 'light' | 'dark';
  onImport: (content: string) => {
    count: number;
    geometryTypes: string[];
  };
  onClose: () => void;
}

export default function GeoJSONImport({
  theme,
  onImport,
  onClose,
}: GeoJSONImportProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const isDark = theme === 'dark';

  async function handleFile(file?: File) {
    if (!file) return;

    setError('');
    setMessage('');

    const validExtension = /\.(geojson|json)$/i.test(file.name);

    if (!validExtension) {
      setError('Choose a .geojson or .json file.');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setError('Files must be 10 MB or smaller.');
      return;
    }

    setLoading(true);

    try {
      const content = await file.text();
      const result = onImport(content);

      setMessage(
        `Imported ${result.count} features: ${result.geometryTypes.join(', ')}`,
      );
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to import this GeoJSON file.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Blurred background overlay */}
      <button
        type="button"
        aria-label="Close import panel"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-md"
      />

      {/* Centered modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="geojson-import-title"
        className={`gm-glass-strong relative z-10 w-full max-w-md rounded-2xl border p-5 shadow-2xl ${
          isDark
            ? 'border-neutral-800 bg-neutral-950 text-white'
            : 'border-gray-200 bg-white text-black'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileUp className="text-emerald-500" size={20} />

            <h3
              id="geojson-import-title"
              className="text-base font-semibold"
            >
              Import GeoJSON
            </h3>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close import panel"
            className={`rounded-lg p-1.5 transition-colors ${
              isDark
                ? 'text-neutral-400 hover:bg-neutral-800 hover:text-white'
                : 'text-gray-500 hover:bg-gray-100 hover:text-black'
            }`}
          >
            <X size={18} />
          </button>
        </div>

        {/* Description */}
        <p
          className={`mt-2 text-sm ${
            isDark ? 'text-neutral-400' : 'text-gray-500'
          }`}
        >
          Import points, lines, and polygons into a separate map layer.
        </p>

        {/* Hidden file input */}
        <input
          ref={inputRef}
          type="file"
          accept=".geojson,.json,application/geo+json,application/json"
          className="hidden"
          onChange={(event) => {
            void handleFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />

        {/* Upload button */}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={loading}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <>
              <LoaderCircle size={18} className="animate-spin" />
              Importing file...
            </>
          ) : (
            <>
              <FileUp size={18} />
              Choose GeoJSON file
            </>
          )}
        </button>

        {/* Success message */}
        {message && (
          <p
            role="status"
            className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-500"
          >
            {message}
          </p>
        )}

        {/* Error message */}
        {error && (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-500"
          >
            {error}
          </p>
        )}

        {/* Footer */}
        <p
          className={`mt-4 text-xs ${
            isDark ? 'text-neutral-500' : 'text-gray-500'
          }`}
        >
          Maximum file size: 10 MB. Coordinates should use WGS 84 (EPSG:4326).
        </p>
      </div>
    </div>
  );
}
