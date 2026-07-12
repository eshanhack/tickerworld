const setStatus = (name, state, text) => {
  const card = document.querySelector(`[data-status="${name}"]`);
  if (!card) return;
  card.dataset.state = state;
  const value = card.querySelector('span:last-child');
  if (value) value.textContent = text;
};

const jsonRequest = async (url, timeout = 3500) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(String(response.status));
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

await Promise.allSettled([
  jsonRequest('https://multiplayer.tickerworld.io/api/capabilities').then((payload) => {
    const open = payload?.multiplayerAvailable === true && payload?.switches?.admissions === true;
    setStatus('multiplayer', open ? 'ok' : 'down', open ? 'Available' : 'Solo available');
  }).catch(() => setStatus('multiplayer', 'down', 'Solo available')),
  jsonRequest('/api/news').then((payload) => {
    const live = payload?.mode === 'live';
    setStatus('news', live ? 'ok' : 'down', live ? 'Available' : 'Unavailable');
  }).catch(() => setStatus('news', 'down', 'Unavailable')),
]);

const updated = document.querySelector('[data-updated]');
if (updated) updated.textContent = `Checked ${new Date().toLocaleString()}`;
