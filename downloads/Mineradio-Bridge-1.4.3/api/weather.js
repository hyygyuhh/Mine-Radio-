import { getNeteaseCookie } from './cookies.js';
import { handleSearch } from './netease.js';

function normalizeLocation(loc) {
  const lat = loc && loc.lat != null ? Number(loc.lat) : NaN;
  const lon = loc && loc.lon != null ? Number(loc.lon) : NaN;
  return {
    city: (loc && loc.city) || '',
    region: (loc && loc.region) || '',
    country: (loc && loc.country) || '',
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    // Aliases used by older page code (locateWeatherRadio).
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lon) ? lon : null,
    timezone: (loc && loc.timezone) || '',
    ip: (loc && loc.ip) || '',
    error: (loc && loc.error) || undefined,
  };
}

export async function fetchIpWeatherLocation() {
  try {
    const resp = await fetch('http://ip-api.com/json/?fields=status,message,country,regionName,city,lat,lon,timezone,query&lang=zh-CN');
    const data = await resp.json();
    if (data.status !== 'success') throw new Error(data.message || 'IP location failed');
    return normalizeLocation({
      city: data.city || '',
      region: data.regionName || '',
      country: data.country || '',
      lat: data.lat,
      lon: data.lon,
      timezone: data.timezone || '',
      ip: data.query || '',
    });
  } catch (err) {
    return normalizeLocation({ city: '', region: '', country: '', lat: null, lon: null, timezone: '', ip: '', error: err.message });
  }
}

async function fetchOpenMeteo(lat, lon, timezone) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day,precipitation',
    timezone: timezone || 'auto',
  });
  const resp = await fetch('https://api.open-meteo.com/v1/forecast?' + params.toString());
  return resp.json();
}

const MOOD_PRESETS = {
  sunny: {
    key: 'sunny',
    title: '晴光电台',
    tagline: '阳光正好，放一组明亮耐听的歌',
    keywords: ['阳光 流行', 'summer pop', 'City Pop', '轻快 华语'],
    label: '晴',
  },
  cloudy: {
    key: 'cloudy',
    title: '云层电台',
    tagline: '阴天也适合慢慢听',
    keywords: ['chill 氛围', 'indie pop', '阴天 歌单', 'Lo-fi'],
    label: '多云',
  },
  rain: {
    key: 'rain',
    title: '雨声电台',
    tagline: '雨天配慢节奏和温柔声线',
    keywords: ['雨天 安静', 'lofi rain', 'R&B', '陈奕迅'],
    label: '雨',
  },
  snow: {
    key: 'snow',
    title: '雪夜电台',
    tagline: '降温了，听点温暖的歌',
    keywords: ['冬日 温暖', '民谣', '治愈 华语', '慢歌'],
    label: '雪',
  },
  fog: {
    key: 'fog',
    title: '雾感电台',
    tagline: '低饱和天气，低饱和旋律',
    keywords: ['ambient pop', '氛围 电子', '慢节奏', '治愈'],
    label: '雾',
  },
  storm: {
    key: 'storm',
    title: '风暴电台',
    tagline: '外面很吵，里面要稳',
    keywords: ['摇滚 能量', '电子 节奏', '雨夜 摇滚', '鼓点'],
    label: '雷暴',
  },
};

function weatherMoodKey(code) {
  const c = Number(code);
  if ([0, 1].includes(c)) return 'sunny';
  if ([2, 3].includes(c)) return 'cloudy';
  if ([45, 48].includes(c)) return 'fog';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(c)) return 'rain';
  if ([71, 73, 75, 77, 85, 86].includes(c)) return 'snow';
  if ([95, 96, 99].includes(c)) return 'storm';
  return 'cloudy';
}

/** Map Open-Meteo mood → Folia Machi weather kinds. */
export function moodToMachiWeather(moodKey) {
  if (moodKey === 'rain' || moodKey === 'storm') return 'rain';
  if (moodKey === 'snow') return 'snow';
  if (moodKey === 'fog') return 'fog';
  return 'clear';
}

function uniqueSongs(songs) {
  const seen = new Set();
  return (songs || []).filter((song) => {
    const key = String(song && (song.id || `${song.name}|${song.artist}`) || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return !!(song && song.name);
  });
}

function seedQueriesForMood(mood) {
  return (mood && mood.keywords ? mood.keywords.slice(0, 4) : ['chill 氛围', '今日推荐']);
}

async function resolveCoords(query) {
  query = query || {};
  let lat = query.lat != null ? Number(query.lat) : (query.latitude != null ? Number(query.latitude) : NaN);
  let lon = query.lon != null ? Number(query.lon) : (query.longitude != null ? Number(query.longitude) : NaN);
  let city = String(query.city || query.q || '').trim();
  let timezone = String(query.timezone || '').trim();
  let source = 'coords';
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const loc = await fetchIpWeatherLocation();
    lat = loc.lat;
    lon = loc.lon;
    if (!city) city = loc.city || '';
    if (!timezone) timezone = loc.timezone || '';
    source = 'ip';
  }
  return { lat, lon, city, timezone, source };
}

function buildWeatherPayload(lat, lon, city, timezone, forecast) {
  const current = (forecast && forecast.current) || {};
  const moodKey = weatherMoodKey(current.weather_code);
  const mood = MOOD_PRESETS[moodKey] || MOOD_PRESETS.cloudy;
  const machi = moodToMachiWeather(moodKey);
  return {
    city,
    lat,
    lon,
    latitude: lat,
    longitude: lon,
    timezone: (forecast && forecast.timezone) || timezone,
    mood: moodKey,
    moodPreset: mood,
    label: mood.label,
    machi,
    temperature: current.temperature_2m,
    apparentTemperature: current.apparent_temperature,
    humidity: current.relative_humidity_2m,
    code: current.weather_code,
    isDay: current.is_day,
    precipitation: current.precipitation,
    location: { name: city || '', latitude: lat, longitude: lon },
  };
}

/** Lightweight current weather for Folia Machi / home cards — no song search. */
export async function fetchCurrentWeather(query) {
  const { lat, lon, city, timezone, source } = await resolveCoords(query);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, error: 'LOCATION_UNAVAILABLE', weather: null, source };
  }
  const forecast = await fetchOpenMeteo(lat, lon, timezone);
  return {
    ok: true,
    source,
    weather: buildWeatherPayload(lat, lon, city, timezone, forecast),
    updatedAt: Date.now(),
  };
}

export async function buildWeatherRadio(query) {
  query = query || {};
  const current = await fetchCurrentWeather(query);
  if (!current.ok || !current.weather) {
    return {
      ok: false,
      error: current.error || 'LOCATION_UNAVAILABLE',
      weather: null,
      radio: { title: '天气电台', subtitle: '暂时无法定位，请先搜索歌曲。', seedQueries: [], songs: [] },
    };
  }
  const weather = current.weather;
  const mood = weather.moodPreset || MOOD_PRESETS.cloudy;
  const queries = seedQueriesForMood(mood);
  const cookie = await getNeteaseCookie();
  let songs = [];
  const settled = await Promise.allSettled(queries.map((q) => handleSearch(q, 8, cookie)));
  settled.forEach((result) => {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) songs = songs.concat(result.value);
  });
  songs = uniqueSongs(songs).slice(0, 18);
  const title = weather.city ? `${weather.city} · ${mood.title}` : mood.title;
  const subtitle = `${mood.tagline} · ${Math.round(weather.temperature || 0)}°C`;
  return {
    ok: true,
    weather,
    radio: {
      title,
      subtitle,
      seedQueries: queries,
      songs,
      updatedAt: Date.now(),
    },
  };
}
