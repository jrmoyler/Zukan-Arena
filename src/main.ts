import './styles.css';
import { ZukanArenaGame } from './game/Game';

const host = document.querySelector<HTMLElement>('#app');

if (!host) throw new Error('Missing #app host');

try {
  new ZukanArenaGame(host);
} catch (error) {
  console.error('[Zukan Arena] Boot failed', error);
}

