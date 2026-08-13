import './styles.css';
import { ZukanArenaGame } from './game/Game';

const host = document.querySelector<HTMLElement>('#app');

if (!host) throw new Error('Missing #app host');

try {
  new ZukanArenaGame(host);
} catch (error) {
  if (error instanceof Error && error.message === 'WebGL 2 unavailable') {
    console.info('[Zukan Arena] Compatibility notice displayed.');
  } else {
    console.error('[Zukan Arena] Boot failed', error);
  }
}
