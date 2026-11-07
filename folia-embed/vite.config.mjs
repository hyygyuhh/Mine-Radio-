import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const foliaSrc = 'C:/Users/z1590/Downloads/folia-major-0.7.26/folia-major-0.7.26/src';

function stubVirtual(id, code) {
  const resolved = '\0' + id;
  return {
    name: 'stub-' + id,
    resolveId(source) {
      if (source === id) return resolved;
    },
    load(loaded) {
      if (loaded === resolved) return code;
    },
  };
}

function stubWorkers() {
  const lyric = path.resolve(__dirname, 'src/stubs/lyricWorkerClient.ts');
  const metadata = path.resolve(__dirname, 'src/stubs/metadataWorkerClient.ts');
  const omni = path.resolve(__dirname, 'src/stubs/omni.ts');
  return {
    name: 'stub-folia-workers',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      const bare = source.split('?')[0];
      if (bare === '@/services/onlineMusic/omni' || bare.endsWith('/services/onlineMusic/omni')) return omni;
      if (!bare.startsWith('.')) return null;
      const target = path.resolve(path.dirname(importer), bare).replace(/\\/g, '/');
      if (target.endsWith('/utils/lyrics/workerClient') || target.endsWith('/utils/lyrics/workerClient.ts')) return lyric;
      if (target.endsWith('/utils/localMetadataWorkerClient') || target.endsWith('/utils/localMetadataWorkerClient.ts')) return metadata;
      if (target.endsWith('/services/onlineMusic/omni') || target.endsWith('/services/onlineMusic/omni.ts')) return omni;
      return null;
    },
  };
}

function stubOnlineMusic() {
  return {
    name: 'stub-online-music',
    enforce: 'pre',
    load(id) {
      const file = id.split('?')[0].replace(/\\/g, '/');
      if (!file.includes('/services/onlineMusic/') || !/\.tsx?$/.test(file)) return null;
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
      const names = new Set();
      const take = (chunk) => {
        for (const part of chunk.split(',')) {
          const name = part.trim().split(/\s+as\s+/).pop().trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
      };
      for (const match of text.matchAll(/export\s+(?:async\s+)?(?:function|const|class|let|var|enum)\s+([A-Za-z_$][\w$]*)/g)) {
        names.add(match[1]);
      }
      for (const match of text.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) take(match[1]);
      for (const match of text.matchAll(/export\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
      const lines = [...names].map((name) => `export const ${name} = new Proxy(function(){ return null }, { get: () => ${name}, apply: () => null });`);
      if (/export\s+default\s/.test(text)) {
        lines.unshift('const __default = new Proxy(function(){ return null }, { get: () => __default, apply: () => null }); export default __default;');
      }
      return lines.join('\n') + '\n';
    },
  };
}

function resolveFoliaDeps() {
  const rootImporter = path.join(__dirname, 'index.html');
  return {
    name: 'resolve-folia-deps',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !importer.includes('folia-major-0.7.26')) return null;
      if (
        source.startsWith('\0') ||
        source.startsWith('virtual:') ||
        source.startsWith('.') ||
        source.startsWith('/') ||
        source.startsWith('@/') ||
        /^[A-Za-z]:[\\/]/.test(source)
      ) {
        return null;
      }
      return this.resolve(source, rootImporter, { ...options, skipSelf: true });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [
    stubVirtual('virtual:folia-locale-zh-TW', 'export default {}'),
    stubVirtual(
      'virtual:icu-folia-dict',
      'export const DICT_WORDS = ""; export const DICT_FREQS = ""; export const DICT_TOTAL = 0;',
    ),
    stubVirtual(
      'virtual:icu-folia-hmm',
      'export const HMM_START = { B: 0, E: 0, M: 0, S: 0 }; export const HMM_TRANS = { B: {}, E: {}, M: {}, S: {} }; export const HMM_EMIT = { B: ["", ""], E: ["", ""], M: ["", ""], S: ["", ""] }; export const T2S_PAIRS = "";',
    ),
    stubVirtual('virtual:folia-command-pinyin', 'export const PINYIN_BY_PHRASE = {};'),
    stubWorkers(),
    stubOnlineMusic(),
    resolveFoliaDeps(),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': foliaSrc,
    },
    dedupe: ['react', 'react-dom', 'framer-motion', 'three', 'pixi.js'],
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 8000,
  },
  server: {
    fs: {
      allow: [foliaSrc, path.dirname(foliaSrc), __dirname],
    },
  },
});
