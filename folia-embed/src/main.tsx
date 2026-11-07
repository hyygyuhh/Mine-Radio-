import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { useMotionValue, type MotionValue } from 'framer-motion';
import '@/i18n/config';
import './embed.css';
import VisualizerRenderer from '@/components/visualizer/VisualizerRenderer';
import { normalizeNebbiaTuning } from '@/components/visualizer/nebbia/tuning';
import { normalizeMachiTuning } from '@/components/visualizer/machi/machiTuning';
import type { AudioBands, Line, SubtitleContentMode, Theme } from '@/types';
import type { VisualizerBackgroundConfig } from '@/components/visualizer/backgrounds/definition';
import type { VisualizerTuningBundle } from '@/components/visualizer/tuningRegistry';
import Wall, { type WallItem } from './wall';

const HOST = 'mineradio-host';
const EMBED = 'folia-embed';

const MODES = new Set([
  'classic', 'cadenza', 'partita', 'tilt', 'fume', 'cappella', 'claddagh',
  'monet', 'diorama', 'lumiere', 'sonnet', 'tempera', 'pendolo', 'hanabi',
  'nebbia', 'machi', 'still',
]);

const THEME: Theme = {
  name: 'Mineradio',
  backgroundColor: '#05060a',
  primaryColor: '#f4f7fb',
  accentColor: '#7ec8d8',
  secondaryColor: '#9db8cf',
  fontStyle: 'sans',
  fontWeight: 700,
  animationIntensity: 'normal',
};

interface AssetItem {
  id: string;
  name: string;
  url: string;
}

interface StageState {
  home: 'mr' | 'wall';
  mode: string;
  lines: Line[];
  theme: Theme;
  coverUrl: string | null;
  songTitle: string | null;
  songArtist: string | null;
  songAlbum: string | null;
  paused: boolean;
  duration: number;
  lyricsFontScale: number;
  visualizerOpacity: number;
  background: VisualizerBackgroundConfig;
  subtitleContentMode: SubtitleContentMode;
  tunings: VisualizerTuningBundle;
  items: WallItem[];
  avatars: AssetItem[];
  emojis: AssetItem[];
  tempera: AssetItem[];
}

const INITIAL: StageState = {
  home: 'mr',
  mode: '',
  lines: [],
  theme: THEME,
  coverUrl: null,
  songTitle: null,
  songArtist: null,
  songAlbum: null,
  paused: false,
  duration: 0,
  lyricsFontScale: 1,
  visualizerOpacity: 1,
  background: { mode: 'common' },
  subtitleContentMode: 'translation',
  tunings: {},
  items: [],
  avatars: [],
  emojis: [],
  tempera: [],
};

function post(type: string, extra?: Record<string, unknown>) {
  parent.postMessage({ source: EMBED, type, ...(extra || {}) }, '*');
}

function asAssets(value: unknown): AssetItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object' && typeof item.url === 'string')
    .map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || ''),
      url: String(item.url),
    }));
}

function normalizeTunings(raw: unknown): VisualizerTuningBundle {
  const input = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
  if (input.nebbia) {
    try { input.nebbia = normalizeNebbiaTuning(input.nebbia); } catch { /* keep the host object */ }
  }
  if (input.machi) {
    try { input.machi = normalizeMachiTuning(input.machi); } catch { /* keep the host object */ }
  }
  return input as VisualizerTuningBundle;
}

function lineIndexAt(lines: Line[], seconds: number) {
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (seconds + 0.02 >= (Number(lines[i].startTime) || 0)) index = i;
    else break;
  }
  return index;
}

class StageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[folia-embed]', error);
  }

  render() {
    if (this.state.failed) {
      return <div style={{ color: '#f4f7fb', padding: 24, fontFamily: 'sans-serif' }}>歌词动画加载失败</div>;
    }
    return this.props.children;
  }
}

function Stage() {
  const [state, setState] = useState<StageState>(INITIAL);
  const [lineIndex, setLineIndex] = useState(-1);
  const linesRef = useRef<Line[]>([]);
  const lineRef = useRef(-1);
  const time = useMotionValue(0);
  const audioPower = useMotionValue(0);
  const bass = useMotionValue(0);
  const lowMid = useMotionValue(0);
  const mid = useMotionValue(0);
  const vocal = useMotionValue(0);
  const treble = useMotionValue(0);
  const spectrum = useMotionValue<Uint8Array<ArrayBuffer>>(new Uint8Array(new ArrayBuffer(0)));
  const audioBands = useMemo<AudioBands>(() => ({
    bass, lowMid, mid, vocal, treble, spectrum,
  }), [bass, lowMid, mid, vocal, treble, spectrum]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.source !== HOST || typeof data.type !== 'string') return;
      if (data.type === 'FOLIA_PING') {
        post('FOLIA_READY');
        return;
      }
      if (data.type === 'FOLIA_SET_MODE') {
        const mode = String(data.mode || '');
        setState((prev) => ({ ...prev, mode: MODES.has(mode) ? mode : prev.mode }));
        return;
      }
      if (data.type === 'FOLIA_SET_HOME') {
        const home = data.home === 'wall' ? 'wall' : 'mr';
        const items = Array.isArray(data.items) ? data.items as WallItem[] : [];
        setState((prev) => ({ ...prev, home, items }));
        return;
      }
      if (data.type === 'FOLIA_SET_LINES') {
        const lines = Array.isArray(data.lines) ? data.lines as Line[] : [];
        linesRef.current = lines;
        const index = lineIndexAt(lines, time.get());
        lineRef.current = index;
        setLineIndex(index);
        setState((prev) => ({ ...prev, lines }));
        return;
      }
      if (data.type === 'FOLIA_SET_TIME') {
        const seconds = Number(data.seconds);
        if (!Number.isFinite(seconds)) return;
        // GlowWord (and several other stages) only leave the hidden "waiting"
        // state on a motion change. A paused clock repeats the same second, so
        // set() would stay silent and the current line would never appear.
        if (time.get() === seconds) time.set(seconds + 0.0001);
        time.set(seconds);
        const index = lineIndexAt(linesRef.current, seconds);
        if (index !== lineRef.current) {
          lineRef.current = index;
          setLineIndex(index);
        }
        return;
      }
      if (data.type === 'FOLIA_SET_AUDIO') {
        const power = Number(data.power);
        const bands = data.bands && typeof data.bands === 'object' ? data.bands : {};
        const bassValue = clamp01(bands.bass);
        const midValue = clamp01(bands.mid);
        const trebleValue = clamp01(bands.treble);
        if (Number.isFinite(power)) audioPower.set(Math.max(0, Math.min(1, power)));
        bass.set(bassValue);
        lowMid.set(bassValue);
        mid.set(midValue);
        vocal.set(midValue);
        treble.set(trebleValue);
        if (Array.isArray(data.spectrum) && data.spectrum.length) {
          const next = new Uint8Array(new ArrayBuffer(data.spectrum.length));
          for (let i = 0; i < data.spectrum.length; i++) next[i] = Number(data.spectrum[i]) & 255;
          spectrum.set(next);
        }
        return;
      }
      if (data.type === 'FOLIA_SET_THEME' && data.theme && typeof data.theme === 'object') {
        setState((prev) => ({ ...prev, theme: { ...THEME, ...data.theme } }));
        return;
      }
      if (data.type === 'FOLIA_SET_TUNING') {
        setState((prev) => ({ ...prev, tunings: normalizeTunings(data.tunings) }));
        return;
      }
      if (data.type === 'FOLIA_SET_ASSETS') {
        setState((prev) => ({
          ...prev,
          avatars: asAssets(data.avatars),
          emojis: asAssets(data.emojis),
          tempera: asAssets(data.tempera),
        }));
        return;
      }
      if (data.type === 'FOLIA_SET_META') {
        const payload = data.payload && typeof data.payload === 'object' ? data.payload : data;
        setState((prev) => ({
          ...prev,
          coverUrl: payload.coverUrl || null,
          songTitle: payload.songTitle || null,
          songArtist: payload.songArtist || null,
          songAlbum: payload.songAlbum || null,
          paused: !!payload.paused,
          duration: Number(payload.durationSeconds) > 0 ? Number(payload.durationSeconds) : prev.duration,
          lyricsFontScale: Number(payload.lyricsFontScale) > 0 ? Number(payload.lyricsFontScale) : prev.lyricsFontScale,
          visualizerOpacity: Number.isFinite(Number(payload.visualizerOpacity)) ? Number(payload.visualizerOpacity) : prev.visualizerOpacity,
          background: payload.background && typeof payload.background === 'object' ? payload.background : prev.background,
          subtitleContentMode: payload.subtitleContentMode || prev.subtitleContentMode,
        }));
      }
    };
    window.addEventListener('message', onMessage);
    post('FOLIA_READY');
    return () => window.removeEventListener('message', onMessage);
  }, [audioPower, bass, lowMid, mid, spectrum, time, treble, vocal]);

  const seed = (state.songTitle || '') + '|' + (state.songArtist || '') + '|' + state.lines.length;
  const showTranslation = state.subtitleContentMode !== 'none';

  return (
    <StageBoundary key={state.home + ':' + state.mode}>
      {state.home === 'wall' ? (
        <Wall
          items={state.items}
          time={time}
          paused={state.paused}
          duration={state.duration}
          onPlay={(index) => post('FOLIA_WALL_PLAY', { index })}
          onToggle={() => post('FOLIA_WALL_TOGGLE')}
          onSeek={(seconds) => post('FOLIA_WALL_SEEK', { seconds })}
          onOpen={(index) => post('FOLIA_WALL_OPEN', { index })}
        />
      ) : state.mode ? (
        <LyricStage
          state={state}
          lineIndex={lineIndex}
          time={time}
          audioPower={audioPower}
          audioBands={audioBands}
          seed={seed}
          showTranslation={showTranslation}
        />
      ) : null}
    </StageBoundary>
  );
}

function LyricStage({
  state,
  lineIndex,
  time,
  audioPower,
  audioBands,
  seed,
  showTranslation,
}: {
  state: StageState;
  lineIndex: number;
  time: MotionValue<number>;
  audioPower: MotionValue<number>;
  audioBands: AudioBands;
  seed: string;
  showTranslation: boolean;
}) {
  return (
    <VisualizerRenderer
      mode={state.mode}
      animateStyleSwitch
      currentTime={time}
      duration={state.duration}
      currentLineIndex={lineIndex}
      lines={state.lines}
      theme={state.theme}
      audioPower={audioPower}
      audioBands={audioBands}
      coverUrl={state.coverUrl}
      songTitle={state.songTitle}
      songArtist={state.songArtist}
      songAlbum={state.songAlbum}
      showText
      seed={seed}
      staticMode={false}
      paused={state.paused}
      visualizerOpacity={state.visualizerOpacity}
      background={state.background}
      visualizerTunings={state.tunings}
      cappellaCustomAvatarImages={state.avatars}
      cappellaCustomEmojiImages={state.emojis}
      temperaLayerImageAssets={state.tempera}
      lyricsFontScale={state.lyricsFontScale}
      isPlayerChromeHidden
      showHarmonySubtitle={false}
      showSubtitleTranslation={showTranslation}
      subtitleContentMode={state.subtitleContentMode}
      onLyricLineSeek={(seconds) => post('FOLIA_WALL_SEEK', { seconds })}
    />
  );
}

function clamp01(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

const root = document.getElementById('root');
// The entry bundle is also imported by lyric chunks. A cache query on the
// script URL makes that a second module, which would mount a second wall.
if (root && root.dataset.foliaMounted !== '1') {
  root.dataset.foliaMounted = '1';
  createRoot(root).render(<Stage />);
}
