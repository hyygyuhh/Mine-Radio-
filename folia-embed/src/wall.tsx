import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { motion, useTransform, type MotionValue } from 'framer-motion';
import {
  BLOCK_COLS,
  BLOCK_ROWS,
  SLOTS_PER_BLOCK,
  getBlockReflow,
  getBlockTemplate,
} from '@/components/wall/blockTemplates';

export interface WallItem {
  id: string;
  index: number;
  name: string;
  coverUrl?: string;
  description?: string;
  current?: boolean;
  type?: string;
  hideIndex?: boolean;
  duration?: number;
}

interface WallProps {
  items: WallItem[];
  time: MotionValue<number>;
  paused: boolean;
  duration: number;
  onPlay: (index: number) => void;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  onOpen: (index: number) => void;
}

/** Same cell as Folia's lattice / Bravais wall. */
const CELL = 128;
const GAP = 8;
const PITCH = CELL + GAP;
const BLOCKS_PER_ROW = 3;

function scaleFor(viewportWidth: number) {
  return viewportWidth < 640 ? 0.52 : viewportWidth < 1100 ? 0.64 : 0.76;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function Progress({
  time,
  duration,
  onSeek,
}: {
  time: MotionValue<number>;
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  const label = useTransform(time, (value) => formatTime(value));
  const width = useTransform(time, (value) => {
    if (!(duration > 0)) return '0%';
    return Math.max(0, Math.min(100, (value / duration) * 100)) + '%';
  });
  return (
    <div className="mr-poster-progress">
      <button
        type="button"
        className="mr-poster-bar"
        onClick={(event) => {
          event.stopPropagation();
          if (!(duration > 0)) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
          onSeek(Math.max(0, Math.min(duration, ratio * duration)));
        }}
      >
        <motion.span style={{ width }} />
      </button>
      <motion.span className="mr-poster-time">{label}</motion.span>
      <span className="mr-poster-time">{formatTime(duration)}</span>
    </div>
  );
}

interface PlacedPoster {
  item: WallItem;
  expanded: boolean;
  cols: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function placePosters(items: WallItem[], openId: string | null): PlacedPoster[] {
  const openIndex = openId ? items.findIndex((item) => item.id === openId) : -1;
  const openBlock = openIndex >= 0 ? Math.floor(openIndex / SLOTS_PER_BLOCK) : -1;
  const openSlot = openIndex >= 0 ? openIndex % SLOTS_PER_BLOCK : -1;

  return items.map((item, index) => {
    const blockIndex = Math.floor(index / SLOTS_PER_BLOCK);
    const slotIndex = index % SLOTS_PER_BLOCK;
    const blockCol = blockIndex % BLOCKS_PER_ROW;
    const blockRow = Math.floor(blockIndex / BLOCKS_PER_ROW);
    const expanded = blockIndex === openBlock;
    const slots = expanded
      ? getBlockReflow(blockCol, blockRow, openSlot) || getBlockTemplate(blockCol, blockRow)
      : getBlockTemplate(blockCol, blockRow);
    const slot = slots[slotIndex];
    const originX = blockCol * BLOCK_COLS * PITCH;
    const originY = blockRow * BLOCK_ROWS * PITCH;
    return {
      item,
      expanded: expanded && slotIndex === openSlot,
      cols: slot.cols,
      x: originX + slot.x * PITCH,
      y: originY + slot.y * PITCH,
      w: slot.cols * PITCH - GAP,
      h: slot.rows * PITCH - GAP,
    };
  });
}

export default function Wall({ items, time, paused, duration, onPlay, onToggle, onSeek, onOpen }: WallProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: 1280, h: 800 });
  const [openId, setOpenId] = useState<string | null>(null);
  const [pan, setPan] = useState<{ x: number; y: number } | null>(null);
  const pressId = useRef<string | null>(null);
  const dragged = useRef(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  const collapseTimer = useRef<number | null>(null);

  const placed = useMemo(() => placePosters(items, openId), [items, openId]);
  const scale = scaleFor(view.w);
  const origin = useMemo(() => {
    const blockW = (BLOCK_COLS * PITCH - GAP) * scale;
    const blockH = (BLOCK_ROWS * PITCH - GAP) * scale;
    return {
      x: (view.w - blockW) / 2,
      y: (view.h - blockH) / 2,
    };
  }, [scale, view.w, view.h]);
  const shown = pan || origin;

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const read = () => setView({ w: el.clientWidth || 1280, h: el.clientHeight || 800 });
    read();
    const obs = new ResizeObserver(read);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => () => {
    if (collapseTimer.current != null) window.clearTimeout(collapseTimer.current);
  }, []);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target && target.closest('button')) return;
    dragged.current = false;
    drag.current = { x: event.clientX, y: event.clientY, px: shown.x, py: shown.y, moved: false };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) {
      active.moved = true;
      dragged.current = true;
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    }
    if (active.moved) setPan({ x: active.px + dx, y: active.py + dy });
  }

  function onPointerUp() {
    drag.current = null;
  }

  return (
    <div className="mr-wall">
      <style>{WALL_CSS}</style>
      <div
        ref={stageRef}
        className="mr-wall-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {items.length === 0 ? <p className="mr-wall-empty">队列里还没有歌曲</p> : null}
        <div
          className="mr-wall-board"
          style={{
            transform: `translate(${shown.x}px, ${shown.y}px) scale(${scale})`,
            ['--wall-scale' as string]: String(scale),
          }}
        >
          {placed.map((poster) => {
            const item = poster.item;
            const badge = item.hideIndex
              ? null
              : item.type === 'playlist'
                ? '歌单'
                : String((item.index ?? 0) + 1);
            const showDesc = !!item.description && (poster.expanded || poster.cols >= 3);
            return (
              <article
                key={item.id}
                className={'mr-poster' + (item.current ? ' is-current' : '') + (poster.expanded ? ' is-open' : '')}
                style={{ left: poster.x, top: poster.y, width: poster.w, height: poster.h }}
                onClick={(event) => {
                  if (dragged.current) {
                    dragged.current = false;
                    return;
                  }
                  const target = event.target as HTMLElement | null;
                  if (target && target.closest('button')) return;
                  if (event.detail !== 1) return;
                  pressId.current = item.id;
                  if (openId !== item.id) {
                    setOpenId(item.id);
                    return;
                  }
                  const id = item.id;
                  if (collapseTimer.current != null) window.clearTimeout(collapseTimer.current);
                  collapseTimer.current = window.setTimeout(() => {
                    collapseTimer.current = null;
                    if (pressId.current !== id) return;
                    setOpenId((current) => (current === id ? null : current));
                  }, 240);
                }}
                onDoubleClick={(event) => {
                  const target = event.target as HTMLElement | null;
                  if (target && target.closest('button, input')) return;
                  if (pressId.current !== item.id) return;
                  pressId.current = null;
                  onPlay(item.index);
                }}
              >
                {item.coverUrl ? <img src={item.coverUrl} alt="" draggable={false} /> : <span className="mr-poster-fallback" />}
                <span className="mr-poster-shade" />
                {badge ? (
                  <span className={'mr-poster-badge' + (item.current ? ' is-current' : '')}>
                    {item.current ? '正在播放 · ' : ''}
                    {badge}
                  </span>
                ) : null}
                <div className="mr-poster-copy">
                  <strong>{item.name}</strong>
                  {showDesc ? <small>{item.description}</small> : null}
                  {poster.expanded && item.current && (item.duration || duration) > 0 ? (
                    <Progress
                      time={time}
                      duration={item.duration && item.duration > 0 ? item.duration : duration}
                      onSeek={onSeek}
                    />
                  ) : null}
                  {poster.expanded ? (
                    <div className="mr-poster-actions">
                      {item.current ? (
                        <button type="button" onClick={(event) => { event.stopPropagation(); onToggle(); }}>
                          {paused ? '播放' : '暂停'}
                        </button>
                      ) : null}
                      <button type="button" onClick={(event) => { event.stopPropagation(); onOpen(item.index); }}>
                        看歌词
                      </button>
                      <button type="button" onClick={(event) => { event.stopPropagation(); setOpenId(null); }}>
                        收起
                      </button>
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const WALL_CSS = `
.mr-wall { position: fixed; inset: 0; background: #070707; color: #f4f7fb; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
.mr-wall-stage { position: absolute; inset: 0; overflow: hidden; cursor: grab; touch-action: none; }
.mr-wall-stage:active { cursor: grabbing; }
.mr-wall-empty { position: absolute; left: 28px; top: 18vh; margin: 0; color: rgba(244,247,251,0.62); font-size: 15px; }
.mr-wall-board { position: absolute; top: 0; left: 0; width: 0; height: 0; transform-origin: 0 0; }
.mr-poster {
  position: absolute;
  overflow: hidden;
  margin: 0;
  padding: 0;
  border: 0;
  color: #f4f7fb;
  text-align: left;
  background: #16181f;
  cursor: pointer;
  user-select: none;
  box-shadow: 0 12px 32px rgba(0,0,0,0.28);
  transition: left 360ms cubic-bezier(0.45, 0, 0.2, 1), top 360ms cubic-bezier(0.45, 0, 0.2, 1), width 360ms cubic-bezier(0.45, 0, 0.2, 1), height 360ms cubic-bezier(0.45, 0, 0.2, 1), box-shadow 600ms ease, filter 600ms ease;
}
.mr-poster:hover { z-index: 3; filter: saturate(1.08) brightness(1.05); }
.mr-poster.is-open { z-index: 6; filter: none; box-shadow: 0 42px 110px rgba(0,0,0,0.55); }
.mr-poster.is-current::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 4;
  border: 2px solid #7ec8d8;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.52), inset 0 0 15px -7px rgba(126,200,216,0.46);
  pointer-events: none;
}
.mr-poster img, .mr-poster-fallback { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.mr-poster-fallback { background: linear-gradient(160deg, #243041, #101218 70%); }
.mr-poster-shade {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(0,0,0,0.05) 34%, rgba(0,0,0,0.24) 56%, rgba(0,0,0,0.92) 100%);
}
.mr-poster.is-open .mr-poster-shade {
  background:
    linear-gradient(0deg, rgba(0,0,0,0.86) 0%, rgba(0,0,0,0.62) 14%, rgba(0,0,0,0.26) 30%, rgba(0,0,0,0) 46%),
    linear-gradient(90deg, rgba(0,0,0,0.88), rgba(0,0,0,0.5) 52%, rgba(0,0,0,0.08));
}
.mr-poster-badge {
  position: absolute;
  top: 14px;
  left: 14px;
  z-index: 3;
  max-width: calc(100% - 28px);
  padding: 5px 8px;
  border: 0;
  background: rgba(0,0,0,0.62);
  color: #fff;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mr-poster-badge.is-current { color: #7ec8d8; background: rgba(0,0,0,0.78); }
.mr-poster-copy {
  position: absolute;
  right: 17px;
  bottom: 17px;
  left: 17px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 5px;
  pointer-events: none;
}
.mr-poster.is-open .mr-poster-copy { pointer-events: auto; }
.mr-poster-copy strong {
  overflow: hidden;
  margin-block: -0.14em;
  padding-block: 0.14em;
  font-size: clamp(22px, 2vw, 36px);
  font-weight: 760;
  line-height: 0.96;
  letter-spacing: -0.045em;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.mr-poster.is-open .mr-poster-copy strong {
  max-width: 92%;
  font-size: clamp(48px, 6vw, 82px);
  line-height: 0.95;
}
.mr-poster-copy small {
  overflow: hidden;
  color: rgba(244,247,251,0.78);
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mr-poster.is-open .mr-poster-copy small { margin-top: 7px; font-size: 17px; }
.mr-poster-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; pointer-events: auto; }
.mr-poster-actions button, .mr-poster-bar {
  border: 0;
  color: #f4f7fb;
  background: rgba(255,255,255,0.14);
  border-radius: 999px;
  padding: calc(6px / var(--wall-scale, 1)) calc(12px / var(--wall-scale, 1));
  font: inherit;
  font-size: calc(13px / var(--wall-scale, 1));
  cursor: pointer;
}
.mr-poster-progress { display: flex; align-items: center; gap: calc(8px / var(--wall-scale, 1)); margin-top: 8px; pointer-events: auto; }
.mr-poster-bar { position: relative; flex: 1; height: calc(6px / var(--wall-scale, 1)); padding: 0; border-radius: 999px; overflow: hidden; }
.mr-poster-bar span { position: absolute; left: 0; top: 0; bottom: 0; background: #7ec8d8; }
.mr-poster-time { font-size: calc(11px / var(--wall-scale, 1)); color: rgba(244,247,251,0.72); font-variant-numeric: tabular-nums; }
`;
