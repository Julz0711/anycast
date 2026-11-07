/**
 * Picture chooser on the profile page: built-in pictures (a color, then a shape) or an uploaded
 * photo, cropped to a square here (drag to move, slider or wheel to zoom) before it is sent.
 */
import { useEffect, useRef, useState } from 'react';
import { ACCENTS, AVATAR_COLORS, AVATAR_SHAPES, avatarId, parseAvatar, type AccentId } from '@anycast/shared';
import { BuiltinAvatar } from './Avatar';
import { cropToBlob } from './actions';
import { Segmented } from '../components/ui';
import { IconUpload } from '../components/Icons';
import { errorMessage } from '../api/client';

export interface PictureValue {
  avatar: string | null;
  /** URL to show: the saved upload, or an object URL of a new crop */
  image: string | null;
}

export function PictureChooser(props: {
  value: PictureValue;
  onAvatar: (id: string) => void;
  /** a new crop: the blob to upload on save, and an object URL to preview it */
  onImage: (blob: Blob, url: string) => void;
}) {
  const [tab, setTab] = useState<'builtin' | 'upload'>(props.value.image ? 'upload' : 'builtin');
  const parsed = parseAvatar(props.value.avatar);
  const [color, setColor] = useState<AccentId>(parsed?.color ?? 'amber');

  return (
    <div className="pc">
      <Segmented
        label="Picture source"
        value={tab}
        options={[
          { value: 'builtin', label: 'Pictures' },
          { value: 'upload', label: 'Your photo' },
        ]}
        onChange={setTab}
      />
      {tab === 'builtin' ? (
        <>
          <div className="swatches pc-colors" role="radiogroup" aria-label="Picture color" data-nav-row="pc-colors">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={ACCENTS[c].name}
                title={ACCENTS[c].name}
                className="swatch"
                style={{ background: ACCENTS[c].hex, ['--sw' as string]: ACCENTS[c].hex }}
                onClick={() => {
                  setColor(c);
                  // keep the shape, change its color
                  if (parsed && !props.value.image) props.onAvatar(avatarId(parsed.shape, c));
                }}
              />
            ))}
          </div>
          <div className="pc-grid" role="radiogroup" aria-label="Picture" data-nav-row="pc-grid">
            {AVATAR_SHAPES.map((shape) => {
              const id = avatarId(shape, color);
              const on = !props.value.image && props.value.avatar === id;
              return (
                <button key={shape} type="button" role="radio" aria-checked={on} aria-label={`${shape} picture`} className="pc-opt" onClick={() => props.onAvatar(id)}>
                  <span className="pic pic-md">
                    <BuiltinAvatar shape={shape} color={color} />
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <Upload onImage={props.onImage} />
      )}
    </div>
  );
}

function Upload({ onImage }: { onImage: (blob: Blob, url: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [crop, setCrop] = useState({ zoom: 1, x: 0.5, y: 0.5 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => () => void (src && URL.revokeObjectURL(src)), [src]);

  const open = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError('Pick an image file (JPEG, PNG, WebP, HEIC where the browser supports it).');
    setNatural(null);
    setCrop({ zoom: 1, x: 0.5, y: 0.5 });
    setSrc(URL.createObjectURL(file));
  };

  // how the image sits in the square frame for the current crop (percent of the frame)
  let style: React.CSSProperties = {};
  if (natural) {
    const short = Math.min(natural.w, natural.h);
    const w = (natural.w / short) * crop.zoom * 100;
    const h = (natural.h / short) * crop.zoom * 100;
    style = { width: `${w}%`, height: `${h}%`, left: `${-(w - 100) * crop.x}%`, top: `${-(h - 100) * crop.y}%` };
  }

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, x: crop.x, y: crop.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const box = frame.current?.getBoundingClientRect();
    if (!d || !box || !natural) return;
    const short = Math.min(natural.w, natural.h);
    const roomX = (natural.w / short) * crop.zoom * box.width - box.width;
    const roomY = (natural.h / short) * crop.zoom * box.height - box.height;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    setCrop((c) => ({
      ...c,
      x: roomX > 0 ? clamp(d.x - (e.clientX - d.px) / roomX) : 0.5,
      y: roomY > 0 ? clamp(d.y - (e.clientY - d.py) / roomY) : 0.5,
    }));
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = 0.05;
    const k: Record<string, () => void> = {
      ArrowLeft: () => setCrop((c) => ({ ...c, x: Math.max(0, c.x - step) })),
      ArrowRight: () => setCrop((c) => ({ ...c, x: Math.min(1, c.x + step) })),
      ArrowUp: () => setCrop((c) => ({ ...c, y: Math.max(0, c.y - step) })),
      ArrowDown: () => setCrop((c) => ({ ...c, y: Math.min(1, c.y + step) })),
    };
    if (k[e.key]) {
      e.preventDefault();
      e.stopPropagation();
      k[e.key]!();
    }
  };

  const use = async () => {
    if (!img.current) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await cropToBlob(img.current, crop);
      onImage(blob, URL.createObjectURL(blob));
      setSrc(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pc-upload">
      <input ref={input} type="file" accept="image/*" className="sr-only" tabIndex={-1} onChange={(e) => (open(e.target.files?.[0]), (e.target.value = ''))} />
      {src ? (
        <>
          <div
            ref={frame}
            className="pc-crop"
            tabIndex={0}
            role="group"
            aria-label="Crop: drag or use the arrow keys to move the picture"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
            onKeyDown={onKey}
            onWheel={(e) => setCrop((c) => ({ ...c, zoom: Math.min(4, Math.max(1, c.zoom - e.deltaY / 500)) }))}
          >
            <img
              ref={img}
              src={src}
              alt=""
              draggable={false}
              style={style}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onError={() => (setSrc(null), setError("This picture can't be opened here. Try a JPEG or PNG."))}
            />
          </div>
          <label className="pc-zoom">
            <span>Zoom</span>
            <input type="range" min={1} max={4} step={0.01} value={crop.zoom} onChange={(e) => setCrop((c) => ({ ...c, zoom: Number(e.target.value) }))} />
          </label>
          <div className="pc-row">
            <button type="button" className="btn" onClick={() => input.current?.click()}>
              Another photo
            </button>
            <button type="button" className="btn btn-primary" disabled={!natural || busy} onClick={() => void use()}>
              {busy ? 'Preparing…' : 'Use this photo'}
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className="pc-drop"
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            open(e.dataTransfer.files[0]);
          }}
        >
          <IconUpload />
          <span className="pc-drop-title">Choose a photo</span>
          <span className="muted">or drop one here. You can move and zoom it next.</span>
        </button>
      )}
      {error && (
        <p className="pc-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
